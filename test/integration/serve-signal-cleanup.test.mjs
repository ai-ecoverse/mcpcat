import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mcpcatArgs } from './helpers/bin.mjs';
import { attachKernel, createNodeKernel } from './helpers/kernel.mjs';
import { waitUntil } from './helpers/wait.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const fixturesDir = join(root, 'test/integration/fixtures');
const kernelBundle = join(root, 'dist/kernel/mcpcat.mjs');
const rounds = 8;

const home = mkdtempSync(join(tmpdir(), 'mcpcat-serve-signal-'));
after(() => rmSync(home, { recursive: true, force: true }));

const hostPaths = [
  ['serve --http', ['serve', '--http', '0', `node=${join(fixturesDir, 'serve-cli.mjs')}`], {}],
  [
    'serve --proxy --http',
    [
      'serve',
      '--proxy',
      `stdio:node ${join(fixturesDir, 'server-stdio-legacy.mjs')}`,
      '--http',
      '0',
    ],
    {},
  ],
  [
    'serve --webmcp --http',
    [
      'serve',
      '--webmcp',
      '--http',
      '0',
      '--playwright-cli',
      join(fixturesDir, 'fake-playwright-cli.sh'),
    ],
    { FAKE_PWCLI_FIXTURE: join(fixturesDir, 'webmcp-tools.json') },
  ],
];

function signalOnStderr(args, env, trigger, sig) {
  const { cmd, args: cmdArgs } = mcpcatArgs(args);
  const child = spawn(cmd, cmdArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NODE_NO_WARNINGS: '1', HOME: home, ...env },
  });
  let stderr = '';
  let sent = false;
  child.stderr.on('data', (c) => {
    stderr += c.toString();
    if (!sent && trigger.test(stderr)) {
      sent = true;
      child.kill(sig);
    }
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  return new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolve({ sent, signal, stderr });
    });
  });
}

const triggers = [
  ['the token file is announced', /bearer saved to /],
  ['"listening"', /listening on /],
];

for (const [label, args, env] of hostPaths) {
  describe(`${label}: a signal right after startup output removes the token file`, () => {
    for (const [when, trigger] of triggers) {
      for (const sig of ['SIGHUP', 'SIGTERM', 'SIGINT']) {
        it(`${sig} as soon as ${when}: the token file is gone, ${rounds} servers`, async () => {
          const runs = await Promise.all(
            Array.from({ length: rounds }, () => signalOnStderr(args, env, trigger, sig))
          );
          for (const [i, run] of runs.entries()) {
            assert.ok(run.sent, `server ${i} never printed ${trigger}: ${run.stderr}`);
            const tokenFile = /bearer saved to (.+)/.exec(run.stderr)?.[1].trim();
            assert.ok(tokenFile, `server ${i} should announce its token file: ${run.stderr}`);
            assert.equal(run.signal, null, `server ${i} died of ${run.signal} without cleaning up`);
            assert.ok(!existsSync(tokenFile), `server ${i}: ${tokenFile} survived ${sig}`);
          }
        });
      }
    }
  });
}

describe('add --bridge: a signal right after "listening" shuts the bridge down', {
  timeout: 60_000,
}, () => {
  let kernel;
  let client;

  before(async () => {
    kernel = await createNodeKernel({});
    await kernel.writeFile(
      '/node_modules/@ai-ecoverse/mcpcat/dist/kernel/mcpcat.mjs',
      readFileSync(kernelBundle)
    );
    await kernel.writeFile(
      '/node_modules/@ai-ecoverse/mcpcat/package.json',
      JSON.stringify({
        name: '@ai-ecoverse/mcpcat',
        version: '0.0.0',
        type: 'module',
        slicc: { commands: { mcpcat: { abi: 'js', module: 'dist/kernel/mcpcat.mjs' } } },
      })
    );
    await kernel.writeFile(
      '/node_modules/@ai-ecoverse/mcpcat-test-stdio/dist/server.mjs',
      readFileSync(join(fixturesDir, 'kernel-stdio-server.mjs'))
    );
    await kernel.writeFile(
      '/node_modules/@ai-ecoverse/mcpcat-test-stdio/package.json',
      JSON.stringify({
        name: '@ai-ecoverse/mcpcat-test-stdio',
        version: '1.0.0',
        type: 'module',
        slicc: { commands: { 'mcpcat-test-stdio': { abi: 'js', module: 'dist/server.mjs' } } },
      })
    );
    await kernel.writeFile(
      '/node_modules/@ai-ecoverse/mcpcat-test-signal-at-listening/dist/main.mjs',
      readFileSync(join(fixturesDir, 'kernel-signal-at-listening.mjs'))
    );
    await kernel.writeFile(
      '/node_modules/@ai-ecoverse/mcpcat-test-signal-at-listening/package.json',
      JSON.stringify({
        name: '@ai-ecoverse/mcpcat-test-signal-at-listening',
        version: '1.0.0',
        type: 'module',
        slicc: {
          commands: {
            'mcpcat-test-signal-at-listening': { abi: 'js', module: 'dist/main.mjs' },
          },
        },
      })
    );
    client = await attachKernel(await kernel.connect());
  });

  after(() => {
    client?.close();
    kernel?.terminate();
  });

  for (const sig of ['SIGHUP', 'SIGTERM', 'SIGINT']) {
    it(`${sig}: the bridge exits cleanly, ${rounds} rounds`, async () => {
      for (let i = 0; i < rounds; i++) {
        let stderr = '';
        let sp;
        let sent = false;
        const fire = () => {
          if (!sent && sp && /listening on /.test(stderr)) {
            sent = true;
            sp.signal(sig);
          }
        };
        sp = await client.spawn(
          [
            'mcpcat',
            'add',
            '--bridge',
            '--no-auth',
            '--config',
            `/tmp/bridge-${sig}-${i}.json`,
            `b${i}`,
            '--',
            'mcpcat-test-stdio',
          ],
          {
            stdin: 'pipe',
            env: {},
            onStdout() {},
            onStderr(chunk) {
              stderr += new TextDecoder().decode(chunk);
              fire();
            },
          }
        );
        await waitUntil(() => fire() || sent, 'the listening line');
        assert.equal(await sp.exited, 0, `round ${i}: bridge did not shut down cleanly: ${stderr}`);
      }
    });
  }

  for (const sig of ['SIGHUP', 'SIGTERM', 'SIGINT']) {
    it(`${sig} from inside the kernel the moment "listening" appears: the bridge exits cleanly, 40 bridges`, async () => {
      const runs = await Promise.all(
        Array.from({ length: 40 }, (_, i) =>
          kernel.run(
            [
              'mcpcat-test-signal-at-listening',
              sig,
              'add',
              '--bridge',
              '--no-auth',
              '--config',
              `/tmp/bridge-in-kernel-${sig}-${i}.json`,
              `k${i}`,
              '--',
              'mcpcat-test-stdio',
            ],
            { stdout: 'pipe', stderr: 'pipe' }
          )
        )
      );
      const outcomes = runs.map((r) => JSON.parse(r.stdout.trim() || '{}'));
      assert.ok(
        outcomes.every((o) => o.sent),
        `every bridge should print "listening": ${JSON.stringify(outcomes)}`
      );
      const unclean = outcomes.map((o, i) => [i, o.status]).filter(([, status]) => status !== 0);
      assert.deepEqual(unclean, [], `bridges that died of ${sig} instead of shutting down`);
    });
  }
});
