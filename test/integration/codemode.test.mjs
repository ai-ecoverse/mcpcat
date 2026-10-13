import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const hostBin = join(root, 'dist/host/mcpcat.mjs');
const alphaServer = join(root, 'test/integration/fixtures/server-codemode-alpha.mjs');
const betaServer = join(root, 'test/integration/fixtures/server-codemode-beta.mjs');

const tmpDir = join(tmpdir(), `mcpcat-code-test-${Date.now()}`);
const agentDir = join(tmpDir, '.pi', 'agent');
const stateDir = join(tmpDir, 'state');
const configPath = join(agentDir, 'mcp.json');

function setup() {
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const config = {
    mcpServers: {
      alpha: { command: 'node', args: [alphaServer] },
      beta: { command: 'node', args: [betaServer] },
    },
  };
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}

function cleanup() {
  rmSync(tmpDir, { recursive: true, force: true });
}

function run(args, options = {}) {
  const env = {
    ...process.env,
    NODE_NO_WARNINGS: '1',
    PI_CODING_AGENT_DIR: agentDir,
    XDG_STATE_HOME: stateDir,
    HOME: tmpDir,
  };
  try {
    const result = execFileSync('node', [hostBin, ...args], {
      encoding: 'utf8',
      timeout: 30_000,
      env,
      ...options,
    });
    return { stdout: result, stderr: '', status: 0 };
  } catch (err) {
    return {
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
      status: err.status ?? 1,
    };
  }
}

describe('codemode integration', () => {
  before(setup);
  after(cleanup);

  describe('describe --ts', () => {
    it('renders TypeScript declarations for a single server', () => {
      const { stdout, status } = run(['describe', '--ts', 'alpha']);
      assert.equal(status, 0);
      assert.ok(stdout.includes('mcp__alpha__greet'), 'should have mcp__alpha__greet');
      assert.ok(stdout.includes('mcp__alpha__add'), 'should have mcp__alpha__add');
      assert.ok(stdout.includes('declare const tools'), 'should have tools declaration');
    });

    it('renders declarations for multiple servers', () => {
      const { stdout, status } = run(['describe', '--ts', 'alpha', 'beta']);
      assert.equal(status, 0);
      assert.ok(stdout.includes('mcp__alpha__greet'));
      assert.ok(stdout.includes('mcp__beta__uppercase'));
      assert.ok(stdout.includes('mcp__beta__reverse'));
    });
  });

  describe('code', () => {
    it('runs inline script calling one server', () => {
      const { stdout, status } = run([
        'code',
        '-s',
        'alpha',
        '-e',
        'const r = await tools.mcp__alpha__greet({ name: "World" }); text(r);',
      ]);
      assert.equal(status, 0);
      assert.ok(stdout.includes('Hello, World!'));
    });

    it('runs script calling two servers', () => {
      const { stdout, status } = run([
        'code',
        '-s',
        'alpha',
        '-s',
        'beta',
        '-e',
        'const g = await tools.mcp__alpha__greet({ name: "Test" }); const u = await tools.mcp__beta__uppercase({ text: g }); text(u);',
      ]);
      assert.equal(status, 0);
      assert.ok(stdout.includes('HELLO, TEST!'));
    });

    it('returns value with --json', () => {
      const { stdout, status } = run(['code', '--json', '-s', 'alpha', '-e', 'return 42;']);
      assert.equal(status, 0);
      const result = JSON.parse(stdout);
      assert.equal(result.ok, true);
      assert.equal(result.value, 42);
    });

    it('timeout stops a runaway script', () => {
      const { status, stderr } = run(['code', '-s', 'alpha', '-m', '1', '-e', 'while(true){}']);
      assert.equal(status, 124);
    });

    it('store persists across runs', () => {
      run(['code', '-s', 'alpha', '-e', 'store("counter", (load("counter") ?? 0) + 1);']);
      const { stdout, status } = run([
        'code',
        '--json',
        '-s',
        'alpha',
        '-e',
        'return load("counter");',
      ]);
      assert.equal(status, 0);
      const result = JSON.parse(stdout);
      assert.ok(result.ok);
      assert.ok(result.value >= 1);
    });

    it('reads script from a file', () => {
      const scriptPath = join(tmpDir, 'test-script.js');
      writeFileSync(scriptPath, 'text("from-file");');
      const { stdout, status } = run(['code', '-s', 'alpha', scriptPath]);
      assert.equal(status, 0);
      assert.ok(stdout.includes('from-file'));
    });

    it('supports ALL_TOOLS listing', () => {
      const { stdout, status } = run([
        'code',
        '--json',
        '-s',
        'alpha',
        '-e',
        'return ALL_TOOLS.map(t => t.name);',
      ]);
      assert.equal(status, 0);
      const result = JSON.parse(stdout);
      assert.ok(result.ok);
      assert.ok(result.value.includes('mcp__alpha__greet'));
    });

    it('searchTools finds tools by query', () => {
      const { stdout, status } = run([
        'code',
        '--json',
        '-s',
        'alpha',
        '-s',
        'beta',
        '-e',
        'const found = await searchTools("uppercase"); return found.map(t => t.name);',
      ]);
      assert.equal(status, 0);
      const result = JSON.parse(stdout);
      assert.ok(result.ok);
      assert.ok(result.value.some((n) => n.includes('uppercase')));
    });

    it('describeTool returns tool description', () => {
      const { stdout, status } = run([
        'code',
        '--json',
        '-s',
        'alpha',
        '-e',
        'const d = await describeTool("mcp__alpha__greet"); return typeof d;',
      ]);
      assert.equal(status, 0);
      const result = JSON.parse(stdout);
      assert.ok(result.ok);
      assert.equal(result.value, 'string');
    });
  });

  describe('grep', () => {
    it('finds tools matching a pattern', () => {
      const { stdout, status } = run(['grep', 'greet', 'alpha']);
      assert.equal(status, 0);
      assert.ok(stdout.includes('mcp__alpha__greet'));
    });

    it('exits 1 when nothing matches', () => {
      const { status } = run(['grep', 'nonexistent_xyz', 'alpha']);
      assert.equal(status, 1);
    });

    it('ranks results with --rank', () => {
      const { stdout, status } = run(['grep', '--rank', 'text', 'beta']);
      assert.equal(status, 0);
      assert.ok(stdout.includes('mcp__beta__'));
    });
  });
});
