import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isStandalone, mcpcatArgs, mcpcatBin } from './helpers/bin.mjs';
import { createNodeKernel, hostUrl, nodeTransport } from './helpers/kernel.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const fixtures = join(here, 'fixtures');
const stdioTarget = `stdio:node ${join(fixtures, 'legacy-elicit-server-host.mjs')}`;
const fakeTty = join(here, 'helpers/fake-tty.mjs');
const SECRET = 'hunter2-legacy-elicit';

function collect(child, input) {
  return new Promise((resolve) => {
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    if (child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(input);
    }
    child.on('exit', (status) =>
      resolve({
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        status,
      })
    );
  });
}

async function startHttp() {
  const child = spawn(process.execPath, [join(fixtures, 'legacy-elicit-server-http.mjs')], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await new Promise((resolve) => {
    child.stdout.once('data', (d) => resolve(JSON.parse(d.toString()).port));
  });
  return { child, port };
}

function exit6Request(r) {
  assert.equal(r.status, 6, r.stderr);
  assert.equal(r.stdout, '');
  const req = JSON.parse(r.stderr);
  assert.equal(req.method, 'elicitation/create');
  return req.params;
}

describe('host: legacy elicitation/create, sampling and roots', () => {
  let home;
  let env;
  let http;
  let url;

  before(async () => {
    home = mkdtempSync(join(tmpdir(), 'mcpcat-legacy-elicit-'));
    env = {
      ...process.env,
      NODE_NO_WARNINGS: '1',
      HOME: home,
      PI_CODING_AGENT_DIR: join(home, 'agent'),
      LEGACY_KEY: SECRET,
    };
    http = await startHttp();
    url = `http://127.0.0.1:${http.port}/mcp`;
  });

  after(() => {
    http?.child.kill('SIGTERM');
    rmSync(home, { recursive: true, force: true });
  });

  function run(args) {
    const { cmd, args: a } = mcpcatArgs(args);
    return collect(spawn(cmd, a, { stdio: ['ignore', 'pipe', 'pipe'], env }));
  }

  function runTty(args, input) {
    const child = spawn(process.execPath, ['--import', fakeTty, mcpcatBin, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    return collect(child, input);
  }

  for (const kind of ['stdio', 'http']) {
    const target = () => (kind === 'stdio' ? stdioTarget : url);

    it(`${kind}: no TTY exits 6 with the request on stderr`, async () => {
      const params = exit6Request(await run(['call', target(), 'whoami']));
      assert.equal(params.mode, 'form');
      assert.deepEqual(params.requestedSchema.required, ['name']);
    });

    it(`${kind}: --respond answers the request`, async () => {
      const r = await run(['--respond', '{"name":"bob"}', 'call', target(), 'whoami']);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout.trim(), 'accept {"name":"bob"}');
    });

    it(`${kind}: a TTY prompts and answers`, { skip: isStandalone }, async () => {
      const r = await runTty(['call', target(), 'whoami'], 'ada\n');
      assert.equal(r.status, 0, r.stderr);
      assert.ok(r.stderr.includes('Who are you?'), r.stderr);
      assert.ok(!r.stderr.includes('\u001b'), r.stderr);
      assert.equal(r.stdout.trim(), 'accept {"name":"ada"}');
    });

    it(`${kind}: --no-input on a TTY exits 6`, { skip: isStandalone }, async () => {
      exit6Request(await runTty(['--no-input', 'call', target(), 'whoami'], 'ada\n'));
    });

    it(`${kind}: URL mode waits for Enter on a TTY`, { skip: isStandalone }, async () => {
      const r = await runTty(['call', target(), 'confirm-url'], '\n');
      assert.equal(r.status, 0, r.stderr);
      assert.ok(r.stderr.includes('https://example.com/confirm'), r.stderr);
      assert.equal(r.stdout.trim(), 'url accept');
    });

    it(`${kind}: URL mode without a TTY exits 6`, async () => {
      const params = exit6Request(await run(['call', target(), 'confirm-url']));
      assert.equal(params.url, 'https://example.com/confirm');
    });

    it(`${kind}: sampling/createMessage is declined`, async () => {
      const r = await run(['call', target(), 'sample']);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /^sampling -1 sampling declined/);
    });

    it(`${kind}: roots/list answers from --root`, async () => {
      const r = await run([
        '--root',
        '/srv/a',
        '--root',
        'file:///srv/b',
        'call',
        target(),
        'roots',
      ]);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout), [{ uri: 'file:///srv/a' }, { uri: 'file:///srv/b' }]);
    });
  }

  it('http: the exit 6 request is redacted', async () => {
    const r = await run(['-H', 'X-Key: ${LEGACY_KEY}', 'call', url, 'whoami']);
    exit6Request(r);
    assert.ok(!r.stderr.includes(SECRET), r.stderr);
    assert.ok(r.stderr.includes('[REDACTED]'), r.stderr);
  });

  it('http: the TTY prompt is redacted', { skip: isStandalone }, async () => {
    const r = await runTty(['-H', 'X-Key: ${LEGACY_KEY}', 'call', url, 'whoami'], 'ada\n');
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!r.stderr.includes(SECRET), r.stderr);
  });
});

describe('kernel: legacy elicitation/create, sampling and roots', () => {
  let kernel;
  let http;
  const env = { PI_CODING_AGENT_DIR: '/etc/mcpcat-legacy-elicit', LEGACY_KEY: SECRET };

  before(async () => {
    http = await startHttp();
    kernel = await createNodeKernel({
      network: { transport: nodeTransport({ hostLoopback: true }) },
    });
    const install = async (dir, command, module, data) => {
      await kernel.writeFile(`/node_modules/@ai-ecoverse/${dir}/${module}`, data);
      await kernel.writeFile(
        `/node_modules/@ai-ecoverse/${dir}/package.json`,
        JSON.stringify({
          name: `@ai-ecoverse/${dir}`,
          version: pkg.version,
          type: 'module',
          slicc: { commands: { [command]: { abi: 'js', module } } },
        })
      );
    };
    await install(
      'mcpcat',
      'mcpcat',
      'dist/kernel/mcpcat.mjs',
      readFileSync(join(root, 'dist/kernel/mcpcat.mjs'))
    );
    await kernel.writeFile(
      '/node_modules/@ai-ecoverse/mcpcat/dist/quickjs.wasm',
      readFileSync(join(root, 'dist/quickjs.wasm'))
    );
    await install(
      'mcpcat-test-legacy-elicit',
      'legacy-elicit-srv',
      'dist/server.mjs',
      readFileSync(join(fixtures, 'legacy-elicit-server.mjs'))
    );
  });

  after(() => {
    http?.child.kill('SIGTERM');
    kernel?.terminate();
  });

  function run(args) {
    return kernel.run(['mcpcat', ...args], { stdout: 'pipe', stderr: 'pipe', env });
  }

  for (const kind of ['stdio', 'http']) {
    const target = () =>
      kind === 'stdio' ? 'stdio:legacy-elicit-srv' : `${hostUrl(http.port)}/mcp`;

    it(`${kind}: exits 6 with the request on stderr`, async () => {
      exit6Request(await run(['call', target(), 'whoami']));
    });

    it(`${kind}: --respond answers the request`, async () => {
      const r = await run(['--respond', '{"name":"bob"}', 'call', target(), 'whoami']);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout.trim(), 'accept {"name":"bob"}');
    });

    it(`${kind}: sampling/createMessage is declined`, async () => {
      const r = await run(['call', target(), 'sample']);
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /^sampling -1 sampling declined/);
    });

    it(`${kind}: roots/list answers from --root`, async () => {
      const r = await run(['--root', '/srv/a', 'call', target(), 'roots']);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout), [{ uri: 'file:///srv/a' }]);
    });
  }

  it('http: the exit 6 request is redacted', async () => {
    const r = await run([
      '-H',
      'X-Key: ${LEGACY_KEY}',
      'call',
      `${hostUrl(http.port)}/mcp`,
      'whoami',
    ]);
    exit6Request(r);
    assert.ok(!r.stderr.includes(SECRET), r.stderr);
  });
});
