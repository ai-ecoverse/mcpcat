import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mcpcatArgs } from './helpers/bin.mjs';
import { createNodeKernel, hostUrl, nodeTransport } from './helpers/kernel.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const fixtures = join(here, 'fixtures');
const hostFixture = join(fixtures, 'complete-server-host.mjs');
const RESOURCE = 'file:///items/{id}';

function collect(child) {
  return new Promise((resolve) => {
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('exit', (status) =>
      resolve({
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        status,
      })
    );
  });
}

async function startHttp(legacy) {
  const child = spawn(process.execPath, [hostFixture, '--http', ...(legacy ? ['--legacy'] : [])], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const port = await new Promise((resolve) => {
    child.stdout.once('data', (d) => resolve(JSON.parse(d.toString()).port));
  });
  return { child, port };
}

function elicitChecks(run, target) {
  it('stdio 2025-11-25: an elicitation during completion exits 6 without input', async () => {
    const r = await run(['complete', target, 'prompt', 'ask', 'x=']);
    assert.equal(r.status, 6, r.stderr);
    assert.equal(r.stdout, '');
    assert.equal(JSON.parse(r.stderr).method, 'elicitation/create');
  });

  it('stdio 2025-11-25: --respond answers an elicitation during completion', async () => {
    const r = await run(['--respond', '{"pick":"z"}', 'complete', target, 'prompt', 'ask', 'x=']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'accept {"pick":"z"}\n');
  });
}

function checks(run, targets) {
  for (const [label, target] of targets) {
    it(`${label}: prompt argument values, one per line`, async () => {
      const r = await run(['complete', target(), 'prompt', 'greet', 'name=al']);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, 'alan\nalonzo\n');
      assert.equal(r.stderr, '');
    });

    it(`${label}: resource template values and a hasMore note`, async () => {
      const r = await run(['complete', target(), 'resource', RESOURCE, 'id=1']);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, '1\n10\n');
      assert.match(r.stderr, /2 of 3 values, more available/);
    });

    it(`${label}: --json prints the completion/complete result`, async () => {
      const r = await run(['--json', 'complete', target(), 'prompt', 'greet', 'name=a']);
      assert.equal(r.status, 0, r.stderr);
      assert.deepEqual(JSON.parse(r.stdout), {
        completion: { values: ['ada', 'alan', 'alonzo'], total: 3, hasMore: false },
      });
    });

    it(`${label}: values are sanitised`, async () => {
      const r = await run(['complete', target(), 'prompt', 'greet', 'name=']);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(!r.stdout.includes('\u001b'), r.stdout);
      assert.ok(r.stdout.includes('ann'), r.stdout);
    });

    it(`${label}: backslashes, newlines and CRs inside a value are escaped`, async () => {
      const r = await run(['complete', target(), 'prompt', 'greet', 'name=l']);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, 'line\\nbreak\\r\nlit\\\\n\n');
    });

    it(`${label}: hasMore without values`, async () => {
      const r = await run(['complete', target(), 'prompt', 'empty', 'x=']);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(r.stdout, '');
      assert.match(r.stderr, /0 values, more available/);
    });

    it(`${label}: a server error exits 5`, async () => {
      const r = await run(['complete', target(), 'prompt', 'nope', 'x=']);
      assert.equal(r.status, 5, r.stderr);
      assert.match(r.stderr, /no completions/);
    });
  }
}

describe('host: complete', () => {
  let home;
  let env;
  const http = {};

  before(async () => {
    home = mkdtempSync(join(tmpdir(), 'mcpcat-complete-'));
    env = {
      ...process.env,
      NODE_NO_WARNINGS: '1',
      HOME: home,
      PI_CODING_AGENT_DIR: join(home, 'agent'),
    };
    http.modern = await startHttp(false);
    http.legacy = await startHttp(true);
  });

  after(() => {
    http.modern?.child.kill('SIGTERM');
    http.legacy?.child.kill('SIGTERM');
    rmSync(home, { recursive: true, force: true });
  });

  function run(args) {
    const { cmd, args: a } = mcpcatArgs(args);
    return collect(spawn(cmd, a, { stdio: ['ignore', 'pipe', 'pipe'], env }));
  }

  checks(run, [
    ['stdio 2026-07-28', () => `stdio:node ${hostFixture}`],
    ['stdio 2025-11-25', () => `stdio:node ${hostFixture} --legacy`],
    ['http 2026-07-28', () => `http://127.0.0.1:${http.modern.port}/mcp`],
    ['http 2025-11-25', () => `http://127.0.0.1:${http.legacy.port}/mcp`],
  ]);
  elicitChecks(run, `stdio:node ${hostFixture} --legacy`);

  for (const args of [
    ['complete', 'x', 'prompt', 'greet'],
    ['complete', 'x', 'tool', 'greet', 'name=a'],
    ['complete', 'x', 'prompt', 'greet', '=a'],
    ['complete', 'x', 'prompt', 'greet', 'name=a', 'extra'],
  ]) {
    it(`usage error for ${args.slice(2).join(' ')}`, async () => {
      const r = await run(args);
      assert.equal(r.status, 2, r.stderr);
      assert.match(
        r.stderr,
        /usage: mcpcat complete <target> prompt\|resource <ref> <arg>=<partial>/
      );
    });
  }

  it('--help names complete', async () => {
    const r = await run(['--help']);
    assert.match(r.stdout, /^ {2}complete <target> prompt\|resource <ref> <arg>=<partial>$/m);
  });
});

describe('kernel: complete', () => {
  let kernel;
  const http = {};

  before(async () => {
    http.modern = await startHttp(false);
    http.legacy = await startHttp(true);
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
      'mcpcat-test-complete',
      'complete-srv',
      'dist/server.mjs',
      readFileSync(join(fixtures, 'complete-server.mjs'))
    );
  });

  after(() => {
    http.modern?.child.kill('SIGTERM');
    http.legacy?.child.kill('SIGTERM');
    kernel?.terminate();
  });

  function run(args) {
    return kernel.run(['mcpcat', ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { PI_CODING_AGENT_DIR: '/etc/mcpcat-complete' },
    });
  }

  checks(run, [
    ['stdio 2026-07-28', () => 'stdio:complete-srv'],
    ['stdio 2025-11-25', () => 'stdio:complete-srv --legacy'],
    ['http 2026-07-28', () => `${hostUrl(http.modern.port)}/mcp`],
    ['http 2025-11-25', () => `${hostUrl(http.legacy.port)}/mcp`],
  ]);
  elicitChecks(run, 'stdio:complete-srv --legacy');
});
