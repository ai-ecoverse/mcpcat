import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from '@ai-ecoverse/slicc-kernel/node';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const kernelBundle = join(root, 'dist/kernel/mcpcat.mjs');
const wasmFile = join(root, 'dist/quickjs.wasm');
const fixturesDir = join(root, 'test/integration/fixtures');
const hostBin = join(root, 'dist/host/mcpcat.mjs');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const AGENT_DIR = '/etc/mcpcat-test';

async function installMcpcat(kernel) {
  const bundleData = readFileSync(kernelBundle);
  const wasmData = readFileSync(wasmFile);
  await kernel.writeFile('/node_modules/@ai-ecoverse/mcpcat/dist/kernel/mcpcat.mjs', bundleData);
  await kernel.writeFile('/node_modules/@ai-ecoverse/mcpcat/dist/quickjs.wasm', wasmData);
  await kernel.writeFile(
    '/node_modules/@ai-ecoverse/mcpcat/package.json',
    JSON.stringify({
      name: '@ai-ecoverse/mcpcat',
      version: pkg.version,
      type: 'module',
      slicc: {
        commands: {
          mcpcat: { abi: 'js', module: 'dist/kernel/mcpcat.mjs' },
        },
      },
    })
  );
}

async function installFixture(kernel, name, pkgName, file) {
  const data = readFileSync(join(fixturesDir, file));
  await kernel.writeFile(`/node_modules/@ai-ecoverse/${pkgName}/dist/server.mjs`, data);
  await kernel.writeFile(
    `/node_modules/@ai-ecoverse/${pkgName}/package.json`,
    JSON.stringify({
      name: `@ai-ecoverse/${pkgName}`,
      version: '1.0.0',
      type: 'module',
      slicc: {
        commands: { [name]: { abi: 'js', module: 'dist/server.mjs' } },
      },
    })
  );
}

async function writeMcpJson(kernel, config) {
  await kernel.writeFile(`${AGENT_DIR}/mcp.json`, JSON.stringify(config, null, 2));
}

function runOpts() {
  return { stdout: 'pipe', stderr: 'pipe', env: { PI_CODING_AGENT_DIR: AGENT_DIR } };
}

describe('kernel: codemode with two servers', () => {
  let kernel;

  before(async () => {
    kernel = await createNodeKernel({});
    await installMcpcat(kernel);
    await installFixture(kernel, 'alpha-srv', 'mcpcat-test-alpha', 'kernel-codemode-alpha.mjs');
    await installFixture(kernel, 'beta-srv', 'mcpcat-test-beta', 'kernel-codemode-beta.mjs');
    await writeMcpJson(kernel, {
      mcpServers: {
        alpha: { command: 'alpha-srv' },
        beta: { command: 'beta-srv' },
      },
    });
  });

  after(() => kernel?.terminate());

  it('code calls tool on one server and prints output', async () => {
    const { status, stdout, stderr } = await kernel.run(
      [
        'mcpcat',
        'code',
        '-s',
        'alpha',
        '-e',
        'const r = await tools.mcp__alpha__greet({ name: "Kernel" }); text(r);',
      ],
      runOpts()
    );
    assert.equal(status, 0, `stderr: ${stderr}`);
    assert.ok(stdout.includes('Hello, Kernel!'), `stdout: ${stdout}`);
  });

  it('code calls tools on two servers', async () => {
    const { status, stdout, stderr } = await kernel.run(
      [
        'mcpcat',
        'code',
        '-s',
        'alpha',
        '-s',
        'beta',
        '-e',
        'const g = await tools.mcp__alpha__greet({ name: "Test" }); const u = await tools.mcp__beta__uppercase({ text: g }); text(u);',
      ],
      runOpts()
    );
    assert.equal(status, 0, `stderr: ${stderr}`);
    assert.ok(stdout.includes('HELLO, TEST!'), `stdout: ${stdout}`);
  });

  it('--json returns {ok, value, output, calls}', async () => {
    const { status, stdout, stderr } = await kernel.run(
      [
        'mcpcat',
        'code',
        '--json',
        '-s',
        'alpha',
        '-e',
        'const r = await tools.mcp__alpha__add({ a: 3, b: 4 }); return r;',
      ],
      runOpts()
    );
    assert.equal(status, 0, `stderr: ${stderr}`);
    const result = JSON.parse(stdout);
    assert.equal(result.ok, true);
    assert.ok(result.value !== undefined, 'value should be present');
    assert.ok(Array.isArray(result.output), 'output should be array');
    assert.ok(Array.isArray(result.calls), 'calls should be array');
    assert.ok(result.calls.length > 0, 'should have at least one call');
  });
});

describe('kernel: codemode timeout', () => {
  let kernel;

  before(async () => {
    kernel = await createNodeKernel({});
    await installMcpcat(kernel);
    await installFixture(kernel, 'alpha-srv', 'mcpcat-test-alpha', 'kernel-codemode-alpha.mjs');
    await writeMcpJson(kernel, {
      mcpServers: { alpha: { command: 'alpha-srv' } },
    });
  });

  after(() => kernel?.terminate());

  it('runaway while(true){} is stopped by interrupt budget', async () => {
    const { status, stderr } = await kernel.run(
      ['mcpcat', 'code', '-s', 'alpha', '-m', '1', '-e', 'while(true){}'],
      runOpts()
    );
    assert.equal(status, 124, `expected exit 124, got ${status}; stderr: ${stderr}`);
    assert.ok(
      stderr.includes('timed out') ||
        stderr.includes('timeout') ||
        stderr.includes('interrupt') ||
        stderr.includes('budget'),
      `stderr should mention timeout: ${stderr}`
    );
  });
});

describe('kernel: codemode sandbox security (cert item 6)', () => {
  let kernel;

  before(async () => {
    kernel = await createNodeKernel({});
    await installMcpcat(kernel);
    await installFixture(kernel, 'alpha-srv', 'mcpcat-test-alpha', 'kernel-codemode-alpha.mjs');
    await writeMcpJson(kernel, {
      mcpServers: { alpha: { command: 'alpha-srv' } },
    });
  });

  after(() => kernel?.terminate());

  it('script cannot access ctx', async () => {
    const { status, stdout } = await kernel.run(
      ['mcpcat', 'code', '--json', '-s', 'alpha', '-e', 'return typeof ctx;'],
      runOpts()
    );
    assert.equal(status, 0);
    const result = JSON.parse(stdout);
    assert.ok(result.ok);
    assert.equal(result.value, 'undefined');
  });

  it('script cannot access globalThis of the JS program', async () => {
    const { status, stdout } = await kernel.run(
      ['mcpcat', 'code', '--json', '-s', 'alpha', '-e', 'return typeof globalThis.process;'],
      runOpts()
    );
    assert.equal(status, 0);
    const result = JSON.parse(stdout);
    assert.ok(result.ok);
    assert.equal(result.value, 'undefined');
  });

  it('script cannot access process', async () => {
    const { status, stdout } = await kernel.run(
      ['mcpcat', 'code', '--json', '-s', 'alpha', '-e', 'return typeof process;'],
      runOpts()
    );
    assert.equal(status, 0);
    assert.equal(JSON.parse(stdout).value, 'undefined');
  });

  it('script cannot access fetch', async () => {
    const { status, stdout } = await kernel.run(
      ['mcpcat', 'code', '--json', '-s', 'alpha', '-e', 'return typeof fetch;'],
      runOpts()
    );
    assert.equal(status, 0);
    assert.equal(JSON.parse(stdout).value, 'undefined');
  });

  it('script cannot use import()', async () => {
    const { status, stdout } = await kernel.run(
      [
        'mcpcat',
        'code',
        '--json',
        '-s',
        'alpha',
        '-e',
        'try { await import("fs"); return "leaked"; } catch(e) { return "blocked"; }',
      ],
      runOpts()
    );
    assert.equal(status, 0);
    assert.equal(JSON.parse(stdout).value, 'blocked');
  });

  it('script cannot access require', async () => {
    const { status, stdout } = await kernel.run(
      ['mcpcat', 'code', '--json', '-s', 'alpha', '-e', 'return typeof require;'],
      runOpts()
    );
    assert.equal(status, 0);
    assert.equal(JSON.parse(stdout).value, 'undefined');
  });

  it('script cannot access fs', async () => {
    const { status, stdout } = await kernel.run(
      [
        'mcpcat',
        'code',
        '--json',
        '-s',
        'alpha',
        '-e',
        'try { const fs = require("fs"); return "leaked"; } catch(e) { return "blocked"; }',
      ],
      runOpts()
    );
    assert.equal(status, 0);
    assert.equal(JSON.parse(stdout).value, 'blocked');
  });
});

describe('host: npm pack layout', () => {
  const tmpDir = join(tmpdir(), `mcpcat-pack-test-${Date.now()}`);

  before(() => {
    mkdirSync(tmpDir, { recursive: true });
    const raw = execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', tmpDir], {
      cwd: root,
      encoding: 'utf8',
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    const tgzName = raw.trim().split('\n').pop();
    execFileSync('tar', ['xzf', tgzName], { cwd: tmpDir });
    mkdirSync(join(tmpDir, 'package', '.pi', 'agent'), { recursive: true });
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('mcpcat code -e works from installed tarball', () => {
    const bin = join(tmpDir, 'package', 'dist', 'host', 'mcpcat.mjs');
    const result = execFileSync('node', [bin, 'code', '--json', '-e', 'return 1;'], {
      cwd: join(tmpDir, 'package'),
      encoding: 'utf8',
      timeout: 30_000,
      env: {
        ...process.env,
        NODE_NO_WARNINGS: '1',
        HOME: join(tmpDir, 'package'),
      },
    });
    const parsed = JSON.parse(result);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.value, 1);
  });
});
