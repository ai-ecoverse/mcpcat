import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { mcpcatArgs } from './helpers/bin.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const fixturesDir = join(root, 'test/integration/fixtures');
const fixtureCli = join(fixturesDir, 'serve-cli.mjs');
const slowCli = join(fixturesDir, 'serve-slow-cli.mjs');

const testHome = join(tmpdir(), `mcpcat-serve-test-${Date.now()}`);
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

async function startServeHttp(extraArgs = [], extraEnv = {}) {
  const { cmd, args } = mcpcatArgs([
    'serve',
    '--http',
    '0',
    '--no-auth',
    `node=${fixtureCli}`,
    ...extraArgs,
  ]);
  const child = spawn(cmd, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NODE_NO_WARNINGS: '1', ...testEnv, ...extraEnv },
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

  return { child, port };
}

async function startServeStdio(extraArgs = []) {
  const { cmd, args } = mcpcatArgs(['serve', '--stdio', `node=${fixtureCli}`, ...extraArgs]);
  const child = spawn(cmd, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NODE_NO_WARNINGS: '1', ...testEnv },
  });
  await sleep(500);
  return child;
}

function sendJsonRpc(child, method, params, id = 1) {
  return new Promise((resolve, reject) => {
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    let data = '';
    const onData = (chunk) => {
      data += chunk.toString();
      const nlIdx = data.indexOf('\n');
      if (nlIdx >= 0) {
        child.stdout.removeListener('data', onData);
        try {
          resolve(JSON.parse(data.slice(0, nlIdx)));
        } catch (e) {
          reject(e);
        }
      }
    };
    child.stdout.on('data', onData);
    child.stdin.write(`${msg}\n`);
  });
}

function pidExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('serve: HTTP transport', () => {
  let server;

  before(async () => {
    server = await startServeHttp();
  });

  after(() => {
    server?.child.kill('SIGTERM');
  });

  it('mcpcat info shows server info', () => {
    const url = `http://127.0.0.1:${server.port}/mcp`;
    const { stdout, status } = runHost(['info', url]);
    assert.equal(status, 0);
    assert.ok(stdout.includes('mcpcat-serve'));
    assert.ok(stdout.includes('2026-07-28'));
  });

  it('mcpcat tools lists discovered tools', () => {
    const url = `http://127.0.0.1:${server.port}/mcp`;
    const { stdout, status } = runHost(['tools', url]);
    assert.equal(status, 0);
    assert.ok(stdout.includes('node_help'));
    assert.ok(stdout.includes('node_invoke'));
    assert.ok(stdout.includes('node_echo'));
    assert.ok(stdout.includes('node_upper'));
  });

  it('mcpcat call invokes a tool via the served command', () => {
    const url = `http://127.0.0.1:${server.port}/mcp`;
    const { stdout, status } = runHost(['call', url, 'node_echo', '-d', '{"text":"hello serve"}']);
    assert.equal(status, 0);
    assert.ok(stdout.includes('hello serve'));
  });

  it('mcpcat call invokes the upper tool', () => {
    const url = `http://127.0.0.1:${server.port}/mcp`;
    const { stdout, status } = runHost(['call', url, 'node_upper', '-d', '{"text":"hello"}']);
    assert.equal(status, 0);
    assert.ok(stdout.includes('HELLO'));
  });

  it('mcpcat call invoke tool with argv', () => {
    const url = `http://127.0.0.1:${server.port}/mcp`;
    const { stdout, status } = runHost([
      'call',
      url,
      'node_invoke',
      '-d',
      '{"argv":["echo","raw args"]}',
    ]);
    assert.equal(status, 0);
    assert.ok(stdout.includes('raw args'));
  });

  it('GET /mcp returns 405', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, { method: 'GET' });
    assert.equal(res.status, 405);
  });

  it('DELETE /mcp returns 405', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, { method: 'DELETE' });
    assert.equal(res.status, 405);
  });

  it('POST /wrong returns 404', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/wrong`, {
      method: 'POST',
      body: '{}',
    });
    assert.equal(res.status, 404);
  });

  it('non-loopback Origin is rejected', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        origin: 'https://evil.example.com',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }),
    });
    assert.equal(res.status, 403);
  });

  it('different-port localhost Origin is rejected (CSRF)', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        origin: 'http://localhost:3000',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }),
    });
    assert.equal(res.status, 403);
  });

  it('same-origin is accepted', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        origin: `http://127.0.0.1:${server.port}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }),
    });
    assert.equal(res.status, 200);
  });

  it('absent Origin is accepted (slicc-agent wire shape)', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }),
    });
    assert.equal(res.status, 200);
  });

  it('text/plain Content-Type is rejected (CSRF)', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'text/plain',
        accept: 'application/json',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }),
    });
    assert.equal(res.status, 415);
  });

  it('wrong Accept is rejected', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/html' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }),
    });
    assert.equal(res.status, 406);
  });

  it('no Mcp-Session-Id in response (stateless)', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-06-18' },
      }),
    });
    assert.equal(res.status, 200);
    assert.ok(!res.headers.has('mcp-session-id'));
  });

  it('Connection: close works', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        connection: 'close',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }),
    });
    assert.equal(res.status, 200);
  });
});

describe('serve: protocol versions', () => {
  let server;

  before(async () => {
    server = await startServeHttp();
  });

  after(() => {
    server?.child.kill('SIGTERM');
  });

  it('server/discover advertises 2025-11-25', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'server/discover', params: {} }),
    });
    const json = await res.json();
    assert.ok(json.result.supportedVersions.includes('2025-11-25'));
    assert.ok(json.result.supportedVersions.includes('2026-07-28'));
    assert.ok(json.result.supportedVersions.includes('2025-06-18'));
  });

  it('initialize with 2025-11-25 is answered with that version', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2025-11-25' },
      }),
    });
    const json = await res.json();
    assert.equal(json.result.protocolVersion, '2025-11-25');
  });
});

describe('serve: stdio transport', () => {
  let child;

  before(async () => {
    child = await startServeStdio();
  });

  after(() => {
    child?.kill('SIGTERM');
  });

  it('server/discover returns supported versions including 2025-11-25', async () => {
    const resp = await sendJsonRpc(child, 'server/discover', {});
    assert.ok(resp.result);
    assert.ok(resp.result.supportedVersions.includes('2026-07-28'));
    assert.ok(resp.result.supportedVersions.includes('2025-11-25'));
    assert.ok(resp.result.supportedVersions.includes('2025-06-18'));
  });

  it('tools/list returns tools', async () => {
    const resp = await sendJsonRpc(child, 'tools/list', {}, 2);
    assert.ok(resp.result);
    const names = resp.result.tools.map((t) => t.name);
    assert.ok(names.includes('node_help'));
    assert.ok(names.includes('node_echo'));
  });

  it('tools/call echo works', async () => {
    const resp = await sendJsonRpc(
      child,
      'tools/call',
      { name: 'node_echo', arguments: { text: 'stdio test' } },
      3
    );
    assert.ok(resp.result);
    assert.ok(resp.result.content[0].text.includes('stdio test'));
  });

  it('notification returns no response', async () => {
    const msg = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} });
    child.stdin.write(`${msg}\n`);
    await sleep(200);
  });
});

describe('serve: slicc-agent loopback wire shape', () => {
  let server;

  before(async () => {
    server = await startServeHttp();
  });

  after(() => {
    server?.child.kill('SIGTERM');
  });

  it('matches slicc-agent loopback request pattern', async () => {
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'content-length': String(new TextEncoder().encode(body).length),
        host: `${server.port}.kernel.localhost`,
        connection: 'close',
      },
      body,
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.ok(json.result.tools.length > 0);
  });

  it('works with no Origin header (agent pattern)', async () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'node_echo', arguments: { text: 'kernel' } },
    });
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        host: `${server.port}.kernel.localhost`,
        connection: 'close',
      },
      body,
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.ok(json.result.content[0].text.includes('kernel'));
  });
});

describe('serve: --bearer ${NAME} authentication', () => {
  const MARKER = 'test-bearer-secret-value-42';
  let server;

  before(async () => {
    server = await startServeHttp(['--bearer', '${SERVE_TOKEN}'], { SERVE_TOKEN: MARKER });
  });

  after(() => {
    server?.child.kill('SIGTERM');
  });

  it('rejects requests without bearer token', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }),
    });
    assert.equal(res.status, 401);
  });

  it('rejects wrong bearer token', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: 'Bearer wrong-token',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }),
    });
    assert.equal(res.status, 401);
  });

  it('accepts correct bearer token', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${MARKER}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }),
    });
    assert.equal(res.status, 200);
  });

  it('serve process cmdline does not contain the marker value', () => {
    const pid = server.child.pid;
    const cmdlinePath = `/proc/${pid}/cmdline`;
    if (existsSync(cmdlinePath)) {
      const cmdline = readFileSync(cmdlinePath, 'utf8');
      assert.ok(!cmdline.includes(MARKER), 'marker found in /proc cmdline');
    } else {
      const ps = execFileSync('ps', ['-p', String(pid), '-o', 'args='], {
        encoding: 'utf8',
        timeout: 5000,
      }).trim();
      assert.ok(!ps.includes(MARKER), `marker found in ps output: ${ps}`);
    }
  });
});

describe('serve: --bearer rejects literal tokens', () => {
  it('exits 2 when bearer is a literal value', () => {
    const { stderr, status } = runHost([
      'serve',
      '--http',
      '0',
      '--bearer',
      'literal-secret',
      fixtureCli,
    ]);
    assert.equal(status, 2);
    assert.ok(stderr.includes('${NAME}'));
    assert.ok(stderr.includes('variable reference'));
  });
});

describe('serve: --tool templates', () => {
  let server;

  before(async () => {
    server = await startServeHttp(['--tool', 'uptime: uptime']);
  });

  after(() => {
    server?.child.kill('SIGTERM');
  });

  it('lists template tools alongside cli tools', () => {
    const url = `http://127.0.0.1:${server.port}/mcp`;
    const { stdout, status } = runHost(['tools', url]);
    assert.equal(status, 0);
    assert.ok(stdout.includes('uptime'));
    assert.ok(stdout.includes('node_echo'));
  });
});

describe('serve: --json prints listening URL', () => {
  it('outputs JSON with url on stdout', async () => {
    const { cmd: jsonCmd, args: jsonArgs } = mcpcatArgs([
      'serve',
      '--http',
      '0',
      '--json',
      '--no-auth',
      `node=${fixtureCli}`,
    ]);
    const child = spawn(jsonCmd, jsonArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1', ...testEnv },
    });

    const jsonLine = await new Promise((resolve, reject) => {
      let data = '';
      child.stdout.on('data', (chunk) => {
        data += chunk.toString();
        const nlIdx = data.indexOf('\n');
        if (nlIdx >= 0) resolve(data.slice(0, nlIdx));
      });
      child.on('error', reject);
      setTimeout(() => reject(new Error('timeout waiting for JSON output')), 10_000);
    });

    child.kill('SIGTERM');
    const parsed = JSON.parse(jsonLine);
    assert.ok(parsed.url);
    assert.ok(parsed.url.startsWith('http://'));
    assert.ok(parsed.url.endsWith('/mcp'));
  });
});

describe('serve: no args returns error', () => {
  it('exits 2 when no commands given', () => {
    const { stderr, status } = runHost(['serve']);
    assert.equal(status, 2);
    assert.ok(stderr.includes('no commands'));
  });
});

describe('serve: secrets never passed to children', () => {
  const MARKER = 'secret-token-for-test';
  let server;

  before(async () => {
    server = await startServeHttp(['--bearer', '${SERVE_SECRET}'], { SERVE_SECRET: MARKER });
  });

  after(() => {
    server?.child.kill('SIGTERM');
  });

  it('Authorization header is not forwarded to child process', async () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'node_invoke', arguments: { argv: ['echo', 'test'] } },
    });
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${MARKER}`,
      },
      body,
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.ok(!JSON.stringify(json).includes(MARKER));
  });
});

describe('serve: SIGTERM kills in-flight children (no orphans)', { timeout: 30_000 }, () => {
  it('kills a running command and its grandchild on SIGTERM', async () => {
    const { cmd: slowCmd, args: slowArgs } = mcpcatArgs([
      'serve',
      '--http',
      '0',
      '--no-auth',
      `slow=${slowCli}`,
    ]);
    const child = spawn(slowCmd, slowArgs, {
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

    const callPromise = fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        connection: 'close',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'slow_slow', arguments: {} },
      }),
    }).catch(() => {});

    let grandchildPid;
    await new Promise((resolve) => {
      let buf = '';
      const onData = (chunk) => {
        buf += chunk.toString();
        const match = buf.match(/grandchild:(\d+)/);
        if (match) {
          grandchildPid = Number(match[1]);
          child.stderr.removeListener('data', onData);
          resolve();
        }
      };
      child.stderr.on('data', onData);
      setTimeout(resolve, 5000);
    });

    child.kill('SIGTERM');

    const exitCode = await new Promise((resolve) => {
      child.on('exit', (code) => resolve(code));
    });

    await callPromise;
    assert.ok(exitCode === 0 || exitCode === null, `serve exited with ${exitCode}`);

    await sleep(1000);

    if (grandchildPid) {
      assert.ok(!pidExists(grandchildPid), `grandchild ${grandchildPid} is still alive`);
    }
  });
});

describe('serve: SIGINT/SIGTERM clean shutdown (idle)', () => {
  it('shuts down cleanly on SIGTERM', async () => {
    const server = await startServeHttp();
    server.child.kill('SIGTERM');
    const code = await new Promise((resolve) => {
      server.child.on('exit', resolve);
    });
    assert.ok(code === 0 || code === null);
  });
});
