import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const hostBin = join(root, 'dist/host/mcpcat.mjs');
const fixturesDir = join(root, 'test/integration/fixtures');
const fixtureCli = join(fixturesDir, 'serve-cli.mjs');

function runHost(args, opts = {}) {
  try {
    const result = execFileSync('node', [hostBin, ...args], {
      encoding: 'utf8',
      timeout: 15_000,
      env: { ...process.env, NODE_NO_WARNINGS: '1', ...opts.env },
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

async function startServeHttp(extraArgs = []) {
  const child = spawn(
    'node',
    [hostBin, 'serve', '--http', '0', `node=${fixtureCli}`, ...extraArgs],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    }
  );

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
  const child = spawn('node', [hostBin, 'serve', '--stdio', `node=${fixtureCli}`, ...extraArgs], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
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
        origin: 'https://evil.example.com',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }),
    });
    assert.equal(res.status, 403);
  });

  it('loopback Origin is accepted', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: 'http://localhost:3000',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }),
    });
    assert.equal(res.status, 200);
  });

  it('absent Origin is accepted (slicc-agent wire shape)', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }),
    });
    assert.equal(res.status, 200);
  });

  it('no Mcp-Session-Id in response (stateless)', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
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
        connection: 'close',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }),
    });
    assert.equal(res.status, 200);
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

  it('server/discover returns supported versions', async () => {
    const resp = await sendJsonRpc(child, 'server/discover', {});
    assert.ok(resp.result);
    assert.ok(resp.result.supportedVersions.includes('2026-07-28'));
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
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    });

    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(new TextEncoder().encode(body).length),
        host: `${server.port}.kernel.localhost`,
        connection: 'close',
      },
      body,
    });

    assert.equal(res.status, 200);
    const json = await res.json();
    assert.ok(json.result);
    assert.ok(json.result.tools.length > 0);
  });

  it('works with no Origin header (agent pattern)', async () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'node_echo',
        arguments: { text: 'kernel' },
      },
    });

    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
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

describe('serve: --bearer authentication', () => {
  let server;
  const TOKEN = 'test-token-12345';

  before(async () => {
    server = await startServeHttp(['--bearer', TOKEN]);
  });

  after(() => {
    server?.child.kill('SIGTERM');
  });

  it('rejects requests without bearer token', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }),
    });
    assert.equal(res.status, 401);
  });

  it('rejects wrong bearer token', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
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
        authorization: `Bearer ${TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }),
    });
    assert.equal(res.status, 200);
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

describe('serve: no args returns error', () => {
  it('exits 2 when no commands given', () => {
    const { stderr, status } = runHost(['serve']);
    assert.equal(status, 2);
    assert.ok(stderr.includes('no commands'));
  });
});

describe('serve: secrets never passed to children', () => {
  let server;

  before(async () => {
    server = await startServeHttp(['--bearer', 'secret-token']);
  });

  after(() => {
    server?.child.kill('SIGTERM');
  });

  it('Authorization header is not forwarded to child process', async () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'node_invoke',
        arguments: { argv: ['echo', 'test'] },
      },
    });
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: 'Bearer secret-token',
      },
      body,
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.ok(!JSON.stringify(json).includes('secret-token'));
  });
});

describe('serve: SIGINT/SIGTERM clean shutdown', () => {
  it('shuts down cleanly on SIGTERM', async () => {
    const server = await startServeHttp();
    server.child.kill('SIGTERM');
    const code = await new Promise((resolve) => {
      server.child.on('exit', resolve);
    });
    assert.ok(code === 0 || code === null);
  });
});
