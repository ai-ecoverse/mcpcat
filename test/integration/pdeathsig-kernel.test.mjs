import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { attachKernel, createNodeKernel } from './helpers/kernel.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const fixturesDir = join(root, 'test/integration/fixtures');
const kernelBundle = join(root, 'dist/kernel/mcpcat.mjs');

const commands = [
  ['mcpcat-test-wrap', 'kernel-stdio-wrapper.mjs'],
  ['mcpcat-test-slow-legacy', 'kernel-stdio-legacy-slow-pidtrack.mjs'],
  ['mcpcat-test-sleeper', 'kernel-sleeper.mjs'],
  ['mcpcat-test-pdeathsig-probe', 'kernel-pdeathsig-probe.mjs'],
];

async function install(kernel) {
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
  for (const [name, file] of commands) {
    await kernel.writeFile(
      `/node_modules/@ai-ecoverse/${name}/dist/main.mjs`,
      readFileSync(join(fixturesDir, file))
    );
    await kernel.writeFile(
      `/node_modules/@ai-ecoverse/${name}/package.json`,
      JSON.stringify({
        name: `@ai-ecoverse/${name}`,
        version: '1.0.0',
        type: 'module',
        slicc: { commands: { [name]: { abi: 'js', module: 'dist/main.mjs' } } },
      })
    );
  }
}

const kernel = await createNodeKernel({});
await install(kernel);
const probe = await kernel.run(['mcpcat-test-pdeathsig-probe'], { stdout: 'pipe', stderr: 'pipe' });
const supported = probe.status === 0;

const isTree = (p) =>
  p.state !== 'Z' &&
  p.argv.some((a) => /mcpcat-test-(wrap|slow-legacy|sleeper)/.test(a)) &&
  !p.argv.some((a) => a === 'mcpcat');

async function treeRunning(client, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const tree = (await client.ps()).filter(isTree);
    const has = (name) => tree.some((p) => p.argv.some((a) => a.includes(name)));
    if (has('mcpcat-test-wrap') && has('mcpcat-test-slow-legacy') && has('mcpcat-test-sleeper')) {
      return tree;
    }
    await sleep(100);
  }
  throw new Error('wrapper, server and grandchild never all ran');
}

async function survivors(client, timeoutMs = 5_000) {
  const end = Date.now() + timeoutMs;
  let left = [];
  while (Date.now() < end) {
    left = (await client.ps()).filter(isTree);
    if (left.length === 0) return left;
    await sleep(100);
  }
  return left;
}

const upstream = 'stdio:mcpcat-test-wrap mcpcat-test-slow-legacy';

const scenarios = [
  ['call', ['call', upstream, 'slow', '-d', '{}']],
  ['serve --proxy', ['serve', '--proxy', upstream, '--http', '0', '--no-auth']],
];

function listening(stderr) {
  const port = /listening on http:\/\/127\.0\.0\.1:(\d+)\//.exec(stderr)?.[1];
  return port && `http://${port}.kernel.localhost/mcp`;
}

async function waitFor(fn, what, timeoutMs = 10_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = fn();
    if (v) return v;
    await sleep(50);
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe('kernel: a SIGKILLed mcpcat takes its stdio servers with it', {
  skip: !supported && 'parentDeathSignal requires a newer slicc-kernel',
  timeout: 60_000,
}, () => {
  let client;

  before(async () => {
    client = await attachKernel(await kernel.connect());
  });

  after(async () => {
    for (const p of (await client.ps()).filter(isTree)) {
      try {
        await client.kill(p.pid, 'SIGKILL');
      } catch {}
    }
    client?.close();
  });

  for (const [label, args] of scenarios) {
    for (const target of ['pid', 'group']) {
      it(`${label}: SIGKILL to the ${target} ends wrapper, server and grandchild`, async () => {
        let stderr = '';
        const sp = await client.spawn(['mcpcat', ...args], {
          stdin: 'pipe',
          env: {},
          onStdout() {},
          onStderr(chunk) {
            stderr += new TextDecoder().decode(chunk);
          },
        });
        let caller;
        if (args[0] === 'serve') {
          const url = await waitFor(() => listening(stderr), 'the proxy to listen');
          caller = await client.spawn(['mcpcat', 'call', url, 'slow', '-d', '{}'], {
            stdin: 'pipe',
            env: {},
            onStdout() {},
            onStderr() {},
          });
        }
        const tree = await treeRunning(client);
        assert.ok(
          tree.every((p) => p.pgid !== sp.pgid),
          'servers lead their own groups'
        );
        if (target === 'pid') await client.kill(sp.pid, 'SIGKILL');
        else sp.signal('SIGKILL');
        await sp.exited;
        caller?.signal('SIGKILL');
        const left = await survivors(client);
        assert.deepEqual(
          left.map((p) => p.argv.join(' ')),
          [],
          'wrapper, server and grandchild should be gone'
        );
      });
    }
  }
});

after(() => kernel.terminate());
