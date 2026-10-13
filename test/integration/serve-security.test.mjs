import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { mcpcatArgs } from './helpers/bin.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const fixturesDir = join(root, 'test/integration/fixtures');
const fixtureCli = join(fixturesDir, 'serve-cli.mjs');

const testHome = join(tmpdir(), `mcpcat-sec-test-${Date.now()}`);
mkdirSync(join(testHome, '.pi', 'agent'), { recursive: true });
const testEnv = { HOME: testHome, PI_CODING_AGENT_DIR: join(testHome, '.pi', 'agent') };
after(() => rmSync(testHome, { recursive: true, force: true }));

function runHost(args, opts = {}) {
  const { cmd, args: cmdArgs } = mcpcatArgs(args);
  try {
    const result = execFileSync(cmd, cmdArgs, {
      encoding: 'utf8',
      timeout: 15_000,
      env: { ...process.env, NODE_NO_WARNINGS: '1', ...testEnv, ...opts.env },
      input: opts.input,
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

async function startServeHttpWithBearer(extraArgs = [], extraEnv = {}) {
  const { cmd, args } = mcpcatArgs([
    'serve',
    '--http',
    '0',
    '--json',
    `node=${fixtureCli}`,
    ...extraArgs,
  ]);
  const child = spawn(cmd, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NODE_NO_WARNINGS: '1', ...testEnv, ...extraEnv },
  });

  const info = await new Promise((resolve, reject) => {
    let stdoutData = '';
    let stderrData = '';
    child.stdout.on('data', (chunk) => {
      stdoutData += chunk.toString();
      const nlIdx = stdoutData.indexOf('\n');
      if (nlIdx >= 0) {
        try {
          resolve(JSON.parse(stdoutData.slice(0, nlIdx)));
        } catch (e) {
          reject(e);
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      stderrData += chunk.toString();
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (!stdoutData.includes('\n'))
        reject(new Error(`Server exited ${code}: stdout=${stdoutData} stderr=${stderrData}`));
    });
  });

  let bearer;
  if (info.bearer) {
    bearer = info.bearer;
  } else if (info.bearerFile) {
    bearer = readFileSync(info.bearerFile, 'utf8');
  }

  return { child, ...info, bearer, stateDir: testHome };
}

const MCP_HEADERS = {
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

function mcpFetch(url, body, extra = {}) {
  return fetch(url, {
    method: 'POST',
    headers: { ...MCP_HEADERS, ...extra },
    body: JSON.stringify(body),
  });
}

describe('security: auto-generated bearer on host', () => {
  let server;

  before(async () => {
    server = await startServeHttpWithBearer();
  });

  after(() => {
    server?.child.kill('SIGTERM');
  });

  it('generates a bearer and provides bearerFile via --json', () => {
    assert.ok(server.bearer, 'should have a bearer token');
    assert.equal(server.bearer.length, 64, 'should be 256-bit hex');
    assert.ok(/^[0-9a-f]+$/.test(server.bearer), 'should be hex');
    assert.ok(server.bearerFile, '--json should always use bearerFile, never inline bearer');
  });

  it('rejects requests without the auto-generated bearer', async () => {
    const res = await mcpFetch(server.url, { jsonrpc: '2.0', id: 1, method: 'ping', params: {} });
    assert.equal(res.status, 401);
  });

  it('accepts requests with the auto-generated bearer', async () => {
    const res = await mcpFetch(
      server.url,
      { jsonrpc: '2.0', id: 1, method: 'ping', params: {} },
      { authorization: `Bearer ${server.bearer}` }
    );
    assert.equal(res.status, 200);
  });

  it('token file is 0600 when created', () => {
    if (!server.bearerFile) return;
    const s = statSync(server.bearerFile);
    assert.equal(s.mode & 0o777, 0o600, `expected 0600, got ${(s.mode & 0o777).toString(8)}`);
  });

  it('state dir is 0700', () => {
    if (!server.bearerFile) return;
    const dir = dirname(server.bearerFile);
    const s = statSync(dir);
    assert.equal(s.mode & 0o777, 0o700, `expected 0700, got ${(s.mode & 0o777).toString(8)}`);
  });
});

describe('security: --no-auth on loopback', () => {
  let server;

  before(async () => {
    const { cmd, args } = mcpcatArgs(['serve', '--http', '0', '--no-auth', `node=${fixtureCli}`]);
    const child = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1', ...testEnv },
    });

    const port = await new Promise((resolve, reject) => {
      let data = '';
      child.stderr.on('data', (chunk) => {
        data += chunk.toString();
        const match = data.match(/listening on http:\/\/[^:]+:(\d+)\/mcp/);
        if (match) resolve(Number(match[1]));
      });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (!data.includes('listening')) reject(new Error(`Server exited ${code}: ${data}`));
      });
    });

    server = { child, port };
  });

  after(() => {
    server?.child.kill('SIGTERM');
  });

  it('allows requests without bearer', async () => {
    const res = await mcpFetch(`http://127.0.0.1:${server.port}/mcp`, {
      jsonrpc: '2.0',
      id: 1,
      method: 'ping',
      params: {},
    });
    assert.equal(res.status, 200);
  });
});

describe('security: --no-auth rejected off loopback', () => {
  it('exits 2 when --no-auth is used with non-loopback bind', () => {
    const { status, stderr } = runHost(['serve', '--http', '0.0.0.0:0', '--no-auth', fixtureCli]);
    assert.equal(status, 2);
    assert.ok(stderr.includes('only allowed on loopback'));
  });
});

describe('security: CSRF protection', () => {
  let server;

  before(async () => {
    const { cmd, args } = mcpcatArgs(['serve', '--http', '0', '--no-auth', `node=${fixtureCli}`]);
    const child = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1', ...testEnv },
    });

    const port = await new Promise((resolve, reject) => {
      let data = '';
      child.stderr.on('data', (chunk) => {
        data += chunk.toString();
        const match = data.match(/listening on http:\/\/[^:]+:(\d+)\/mcp/);
        if (match) resolve(Number(match[1]));
      });
      child.on('error', reject);
    });

    server = { child, port };
  });

  after(() => {
    server?.child.kill('SIGTERM');
  });

  it('OPTIONS returns 405 with no CORS headers', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'OPTIONS',
    });
    assert.equal(res.status, 405);
    assert.ok(!res.headers.has('access-control-allow-origin'));
    assert.ok(!res.headers.has('access-control-allow-methods'));
  });

  it('text/plain is rejected with 415', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'text/plain', accept: 'application/json' },
      body: '{"jsonrpc":"2.0","id":1,"method":"ping","params":{}}',
    });
    assert.equal(res.status, 415);
  });

  it('application/x-www-form-urlencoded is rejected with 415', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: 'data=test',
    });
    assert.equal(res.status, 415);
  });

  it('text/html Accept is rejected with 406', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/html' },
      body: '{"jsonrpc":"2.0","id":1,"method":"ping","params":{}}',
    });
    assert.equal(res.status, 406);
  });

  it('cross-port localhost Origin is rejected', async () => {
    const res = await mcpFetch(
      `http://127.0.0.1:${server.port}/mcp`,
      { jsonrpc: '2.0', id: 1, method: 'ping', params: {} },
      { origin: 'http://localhost:9999' }
    );
    assert.equal(res.status, 403);
  });

  it('same-port origin is accepted', async () => {
    const res = await mcpFetch(
      `http://127.0.0.1:${server.port}/mcp`,
      { jsonrpc: '2.0', id: 1, method: 'ping', params: {} },
      { origin: `http://127.0.0.1:${server.port}` }
    );
    assert.equal(res.status, 200);
  });

  it('kernel.localhost origin is accepted', async () => {
    const res = await mcpFetch(
      `http://127.0.0.1:${server.port}/mcp`,
      { jsonrpc: '2.0', id: 1, method: 'ping', params: {} },
      { origin: `http://${server.port}.kernel.localhost` }
    );
    assert.equal(res.status, 200);
  });
});

describe('security: regression guard (slicc-agent wire shape with bearer)', () => {
  let server;

  before(async () => {
    server = await startServeHttpWithBearer();
  });

  after(() => {
    server?.child.kill('SIGTERM');
  });

  it('succeeds with exact slicc-agent request shape', async () => {
    const url = new URL(server.url);
    const port = url.port;
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const res = await fetch(server.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        host: `${port}.kernel.localhost`,
        connection: 'close',
        authorization: `Bearer ${server.bearer}`,
      },
      body,
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.ok(json.result.tools.length > 0);
  });
});

describe('security: token never in argv, env or -v output', () => {
  let server;

  before(async () => {
    server = await startServeHttpWithBearer();
  });

  after(() => {
    server?.child.kill('SIGTERM');
  });

  it('process cmdline does not contain the token', () => {
    const pid = server.child.pid;
    try {
      const ps = execFileSync('ps', ['-p', String(pid), '-o', 'args='], {
        encoding: 'utf8',
        timeout: 5000,
      }).trim();
      assert.ok(!ps.includes(server.bearer), 'token found in ps output');
    } catch {}
  });

  it('--json stdout does not contain token in plaintext (uses bearerFile)', () => {
    if (server.bearerFile) {
      assert.ok(!server.url.includes(server.bearer), 'token should not be in URL');
    }
  });
});

describe('security: token file cleaned up on exit', () => {
  it('removes token file on SIGTERM', async () => {
    const server = await startServeHttpWithBearer();
    const tokenPath = server.bearerFile;
    server.child.kill('SIGTERM');
    await new Promise((resolve) => server.child.on('exit', resolve));
    await sleep(200);
    if (tokenPath) {
      assert.ok(!existsSync(tokenPath), `token file ${tokenPath} should be deleted after exit`);
    }
  });
});

describe('security: host serve auto-generates bearer', () => {
  it('does not exit 2 on host (auto-generates)', () => {
    const { cmd, args: cmdArgs } = mcpcatArgs(['serve', '--http', '0', '--json', fixtureCli]);
    const child = spawn(cmd, cmdArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1', ...testEnv },
    });
    let stdoutData = '';
    child.stdout.on('data', (chunk) => {
      stdoutData += chunk.toString();
      if (stdoutData.includes('\n')) child.kill('SIGTERM');
    });
    return new Promise((resolve) => {
      child.on('exit', (code) => {
        assert.ok(
          stdoutData.includes('url') &&
            (stdoutData.includes('bearer') || stdoutData.includes('bearerFile')),
          'should output URL and bearer info'
        );
        resolve();
      });
    });
  });
});
