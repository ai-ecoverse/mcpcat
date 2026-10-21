import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isStandalone, mcpcatArgs, mcpcatBin } from './helpers/bin.mjs';
import { createNodeKernel } from './helpers/kernel.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const kernelFixture = join(here, 'fixtures/stdio-elicit-server.mjs');
const target = `stdio:node ${join(here, 'fixtures/stdio-elicit-server-host.mjs')}`;
const fakeTty = join(here, 'helpers/fake-tty.mjs');

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

describe('host: elicitation retry over a stdio server', () => {
  let home;
  let env;

  before(() => {
    home = mkdtempSync(join(tmpdir(), 'mcpcat-elicit-stdio-'));
    env = {
      ...process.env,
      NODE_NO_WARNINGS: '1',
      HOME: home,
      PI_CODING_AGENT_DIR: join(home, 'agent'),
    };
  });

  after(() => rmSync(home, { recursive: true, force: true }));

  function runTty(args, input) {
    const child = spawn(process.execPath, ['--import', fakeTty, mcpcatBin, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
    });
    return collect(child, input);
  }

  it('retries on the same server with typed answers', { skip: isStandalone }, async () => {
    const r = await runTty(['call', target, 'whoami'], 'ada\n');
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stderr.includes('Who are you?'), r.stderr);
    assert.equal(r.stdout.trim(), 'call 2 answers {"name":"ada"}');
  });

  it('retries a URL-mode elicitation after Enter', { skip: isStandalone }, async () => {
    const r = await runTty(['call', target, 'confirm-url'], '\n');
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stderr.includes('https://example.com/confirm'), r.stderr);
    assert.equal(r.stdout.trim(), 'call 2 answers {}');
  });

  it('--no-input on a TTY prints the request and exits 6', { skip: isStandalone }, async () => {
    const r = await runTty(['--no-input', 'call', target, 'whoami'], 'ada\n');
    assert.equal(r.status, 6, r.stderr);
    assert.ok(r.stderr.includes('"inputRequest'), r.stderr);
    assert.ok(!r.stderr.includes('name:'), r.stderr);
    assert.equal(r.stdout, '');
  });

  it('--no-input on a TTY does not wait for Enter on a URL', { skip: isStandalone }, async () => {
    const r = await runTty(['--no-input', 'call', target, 'confirm-url'], '\n');
    assert.equal(r.status, 6, r.stderr);
    assert.ok(!r.stderr.includes('Press Enter'), r.stderr);
    assert.ok(r.stderr.includes('https://example.com/confirm'), r.stderr);
    assert.equal(r.stdout, '');
  });

  it('--no-input on a TTY still takes --respond answers', { skip: isStandalone }, async () => {
    const r = await runTty(
      ['--no-input', '--respond', '{"name":"bob"}', 'call', target, 'whoami'],
      ''
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'call 2 answers {"name":"bob"}');
  });

  it('retries with --respond answers', async () => {
    const { cmd, args } = mcpcatArgs(['--respond', '{"name":"bob"}', 'call', target, 'whoami']);
    const r = await collect(spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env }));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'call 2 answers {"name":"bob"}');
  });
});

describe('kernel: elicitation retry over a stdio server', () => {
  let kernel;

  before(async () => {
    kernel = await createNodeKernel({});
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
      'mcpcat-test-elicit',
      'elicit-srv',
      'dist/server.mjs',
      readFileSync(kernelFixture)
    );
  });

  after(() => kernel?.terminate());

  it('retries with --respond answers', async () => {
    const r = await kernel.run(
      ['mcpcat', '--respond', '{"name":"bob"}', 'call', 'stdio:elicit-srv', 'whoami'],
      { stdout: 'pipe', stderr: 'pipe', env: { PI_CODING_AGENT_DIR: '/etc/mcpcat-elicit' } }
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout.trim(), 'call 2 answers {"name":"bob"}');
  });

  it('accepts --no-input and exits 6 with the request', async () => {
    const r = await kernel.run(['mcpcat', '--no-input', 'call', 'stdio:elicit-srv', 'whoami'], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { PI_CODING_AGENT_DIR: '/etc/mcpcat-elicit' },
    });
    assert.equal(r.status, 6, r.stderr);
    assert.ok(r.stderr.includes('inputRequest'), r.stderr);
  });
});
