import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const hostBin = join(root, 'dist/host/mcpcat.mjs');
const fixturesDir = join(root, 'test/integration/fixtures');

function runHost(args, opts = {}) {
  try {
    const result = execFileSync('node', [hostBin, ...args], {
      encoding: 'utf8',
      timeout: 15_000,
      env: { ...process.env, NODE_NO_WARNINGS: '1', ...opts.env },
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

async function startFixtureServer(script, extraArgs = []) {
  const child = spawn('node', [join(fixturesDir, script), ...extraArgs], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });

  const info = await new Promise((resolve, reject) => {
    let data = '';
    child.stdout.on('data', (chunk) => {
      data += chunk.toString();
      if (data.includes('\n')) {
        try {
          resolve(JSON.parse(data.trim()));
        } catch (e) {
          reject(e);
        }
      }
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (!data.includes('\n')) reject(new Error(`Server exited ${code}: ${data}`));
    });
  });

  return { child, ...info };
}

describe('client: 2026-07-28 HTTP', () => {
  let server;

  before(async () => {
    server = await startFixtureServer('server-2026-http.mjs');
  });

  after(() => {
    server?.child.kill('SIGTERM');
  });

  it('info shows server details', () => {
    const url = `http://127.0.0.1:${server.port}`;
    const { stdout, status } = runHost(['info', url]);
    assert.equal(status, 0);
    assert.ok(stdout.includes('test-2026'));
    assert.ok(stdout.includes('2026-07-28'));
  });

  it('tools lists tools', () => {
    const url = `http://127.0.0.1:${server.port}`;
    const { stdout, status } = runHost(['tools', url]);
    assert.equal(status, 0);
    assert.ok(stdout.includes('echo'));
    assert.ok(stdout.includes('add'));
  });

  it('call invokes a tool', () => {
    const url = `http://127.0.0.1:${server.port}`;
    const { stdout, status } = runHost(['call', url, 'echo', '-d', '{"message":"hello world"}']);
    assert.equal(status, 0);
    assert.ok(stdout.includes('hello world'));
  });

  it('call with add tool', () => {
    const url = `http://127.0.0.1:${server.port}`;
    const { stdout, status } = runHost(['call', url, 'add', '-d', '{"a":3,"b":4}']);
    assert.equal(status, 0);
    assert.ok(stdout.includes('7'));
  });

  it('call with isError returns exit 1', () => {
    const url = `http://127.0.0.1:${server.port}`;
    const { stderr, status } = runHost(['call', url, 'fail', '-d', '{}']);
    assert.equal(status, 1);
    assert.ok(stderr.includes('something went wrong'));
  });

  it('describe shows tool schema', () => {
    const url = `http://127.0.0.1:${server.port}`;
    const { stdout, status } = runHost(['describe', url, 'echo']);
    assert.equal(status, 0);
    assert.ok(stdout.includes('echo'));
    assert.ok(stdout.includes('message'));
  });

  it('describe --schema prints raw JSON Schema', () => {
    const url = `http://127.0.0.1:${server.port}`;
    const { stdout, status } = runHost(['describe', '--schema', url, 'echo']);
    assert.equal(status, 0);
    const schema = JSON.parse(stdout);
    assert.equal(schema.type, 'object');
    assert.ok(schema.properties.message);
  });

  it('describe unknown tool exits 2', () => {
    const url = `http://127.0.0.1:${server.port}`;
    const { stderr, status } = runHost(['describe', url, 'nonexistent']);
    assert.equal(status, 2);
    assert.ok(stderr.includes('not found'));
  });

  it('curl form: target alone is info', () => {
    const url = `http://127.0.0.1:${server.port}`;
    const { stdout, status } = runHost([url]);
    assert.equal(status, 0);
    assert.ok(stdout.includes('test-2026'));
  });

  it('curl form: target + tool is call', () => {
    const url = `http://127.0.0.1:${server.port}`;
    const { stdout, status } = runHost([url, 'echo', '-d', '{"message":"curl form"}']);
    assert.equal(status, 0);
    assert.ok(stdout.includes('curl form'));
  });

  it('ls is an alias for tools', () => {
    const url = `http://127.0.0.1:${server.port}`;
    const { stdout, status } = runHost(['ls', url]);
    assert.equal(status, 0);
    assert.ok(stdout.includes('echo'));
  });
});

describe('client: 2025-11-25 HTTP (JSON)', () => {
  let server;

  before(async () => {
    server = await startFixtureServer('server-legacy-http.mjs');
  });

  after(() => {
    server?.child.kill('SIGTERM');
  });

  it('info shows server details via fallback', () => {
    const url = `http://127.0.0.1:${server.port}`;
    const { stdout, status } = runHost(['info', url]);
    assert.equal(status, 0);
    assert.ok(stdout.includes('test-legacy'));
    assert.ok(stdout.includes('2025-11-25'));
  });

  it('tools lists tools', () => {
    const url = `http://127.0.0.1:${server.port}`;
    const { stdout, status } = runHost(['tools', url]);
    assert.equal(status, 0);
    assert.ok(stdout.includes('echo'));
    assert.ok(stdout.includes('add'));
  });

  it('call invokes a tool', () => {
    const url = `http://127.0.0.1:${server.port}`;
    const { stdout, status } = runHost(['call', url, 'echo', '-d', '{"message":"legacy hello"}']);
    assert.equal(status, 0);
    assert.ok(stdout.includes('legacy hello'));
  });
});

describe('client: 2025-11-25 HTTP (SSE)', () => {
  let server;

  before(async () => {
    server = await startFixtureServer('server-legacy-http.mjs', ['--sse']);
  });

  after(() => {
    server?.child.kill('SIGTERM');
  });

  it('info works over SSE', () => {
    const url = `http://127.0.0.1:${server.port}`;
    const { stdout, status } = runHost(['info', url]);
    assert.equal(status, 0);
    assert.ok(stdout.includes('test-legacy'));
  });

  it('call works over SSE', () => {
    const url = `http://127.0.0.1:${server.port}`;
    const { stdout, status } = runHost(['call', url, 'echo', '-d', '{"message":"sse hello"}']);
    assert.equal(status, 0);
    assert.ok(stdout.includes('sse hello'));
  });
});

describe('client: stdio', () => {
  it('info via stdio: prefix', () => {
    const script = join(fixturesDir, 'server-stdio-legacy.mjs');
    const { stdout, status } = runHost(['info', `stdio:node ${script}`]);
    assert.equal(status, 0);
    assert.ok(stdout.includes('test-stdio-legacy'));
  });

  it('tools via trailing --', () => {
    const script = join(fixturesDir, 'server-stdio-legacy.mjs');
    const { stdout, status } = runHost(['tools', '--', 'node', script]);
    assert.equal(status, 0);
    assert.ok(stdout.includes('echo'));
  });

  it('call via stdio: prefix', () => {
    const script = join(fixturesDir, 'server-stdio-legacy.mjs');
    const { stdout, status } = runHost([
      'call',
      `stdio:node ${script}`,
      'echo',
      '-d',
      '{"message":"stdio test"}',
    ]);
    assert.equal(status, 0);
    assert.ok(stdout.includes('stdio test'));
  });
});

describe('client: version selection', () => {
  let server2026;
  let serverLegacy;

  before(async () => {
    server2026 = await startFixtureServer('server-2026-http.mjs');
    serverLegacy = await startFixtureServer('server-legacy-http.mjs');
  });

  after(() => {
    server2026?.child.kill('SIGTERM');
    serverLegacy?.child.kill('SIGTERM');
  });

  it('auto-selects 2026-07-28 for modern server', () => {
    const url = `http://127.0.0.1:${server2026.port}`;
    const { stdout, status } = runHost(['info', url]);
    assert.equal(status, 0);
    assert.ok(stdout.includes('2026-07-28'));
  });

  it('falls back to legacy for legacy server', () => {
    const url = `http://127.0.0.1:${serverLegacy.port}`;
    const { stdout, status } = runHost(['info', url]);
    assert.equal(status, 0);
    assert.ok(stdout.includes('2025-11-25'));
  });
});

describe('client: configured names', () => {
  let server;
  let configDir;

  before(async () => {
    server = await startFixtureServer('server-2026-http.mjs');
    configDir = join(tmpdir(), `mcpcat-test-${process.pid}-${Date.now()}`);
    mkdirSync(join(configDir, '.pi', 'agent'), { recursive: true });
    const config = {
      mcpServers: {
        'test-server': {
          url: `http://127.0.0.1:${server.port}`,
        },
      },
    };
    writeFileSync(join(configDir, '.pi', 'agent', 'mcp.json'), JSON.stringify(config));
  });

  after(() => {
    server?.child.kill('SIGTERM');
    rmSync(configDir, { recursive: true, force: true });
  });

  it('resolves configured name', () => {
    const { stdout, status } = runHost(['info', 'test-server'], {
      env: { HOME: configDir },
    });
    assert.equal(status, 0);
    assert.ok(stdout.includes('test-2026'));
  });

  it('resolves name with dash/underscore normalization', () => {
    const { stdout, status } = runHost(['info', 'test_server'], {
      env: { HOME: configDir },
    });
    assert.equal(status, 0);
    assert.ok(stdout.includes('test-2026'));
  });
});

describe('client: error handling', () => {
  it('connection failure exits 3', () => {
    const { stderr, status } = runHost(['info', 'http://127.0.0.1:1']);
    assert.equal(status, 3);
    assert.ok(stderr.includes('connection failed'));
  });

  it('missing target exits 2', () => {
    const { stderr, status } = runHost(['info']);
    assert.equal(status, 2);
    assert.ok(stderr.includes('requires a target'));
  });

  it('call without tool name exits 2', () => {
    const { stderr, status } = runHost(['call', 'http://127.0.0.1:1']);
    assert.equal(status, 2);
    assert.ok(stderr.includes('requires a tool name'));
  });
});
