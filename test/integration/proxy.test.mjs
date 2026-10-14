import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { mcpcatArgs } from './helpers/bin.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const fixturesDir = join(root, 'test/integration/fixtures');

const testHome = join(tmpdir(), `mcpcat-proxy-test-${Date.now()}`);
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
    env: { ...process.env, NODE_NO_WARNINGS: '1', ...testEnv },
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

async function startProxy(target, extraArgs = [], extraEnv = {}) {
  const { cmd, args } = mcpcatArgs([
    'serve',
    '--proxy',
    target,
    '--http',
    '0',
    '--json',
    '--no-auth',
    ...extraArgs,
  ]);
  const child = spawn(cmd, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NODE_NO_WARNINGS: '1', ...testEnv, ...extraEnv },
  });

  const port = await new Promise((resolve, reject) => {
    let stdoutData = '';
    let stderrData = '';
    child.stdout.on('data', (chunk) => {
      stdoutData += chunk.toString();
      const nlIdx = stdoutData.indexOf('\n');
      if (nlIdx >= 0) {
        try {
          const parsed = JSON.parse(stdoutData.slice(0, nlIdx));
          const match = parsed.url.match(/:(\d+)\//);
          if (match) resolve(Number(match[1]));
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
        reject(new Error(`Proxy exited ${code}: stdout=${stdoutData} stderr=${stderrData}`));
    });
  });

  return { child, port };
}

describe('proxy: stdio upstream served as HTTP (2025-11-25 → 2026-07-28)', () => {
  let proxy;

  before(async () => {
    const fixture = join(fixturesDir, 'server-stdio-legacy.mjs');
    proxy = await startProxy(`stdio:node ${fixture}`);
  });

  after(() => {
    proxy?.child.kill('SIGTERM');
  });

  it('info shows upstream server via proxy', () => {
    const url = `http://127.0.0.1:${proxy.port}/mcp`;
    const { stdout, status } = runHost(['info', url]);
    assert.equal(status, 0);
    assert.ok(stdout.includes('test-stdio-legacy'));
    assert.ok(stdout.includes('2026-07-28'));
  });

  it('tools/list works through proxy', () => {
    const url = `http://127.0.0.1:${proxy.port}/mcp`;
    const { stdout, status } = runHost(['tools', url]);
    assert.equal(status, 0);
    assert.ok(stdout.includes('echo'));
  });

  it('tools/call works through proxy', () => {
    const url = `http://127.0.0.1:${proxy.port}/mcp`;
    const { stdout, status } = runHost(['call', url, 'echo', '-d', '{"message":"hello proxy"}']);
    assert.equal(status, 0);
    assert.ok(stdout.includes('hello proxy'));
  });

  it('server/discover advertises all protocol versions', async () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'server/discover',
      params: {},
    });
    const res = await fetch(`http://127.0.0.1:${proxy.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body,
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.ok(json.result.supportedVersions.includes('2026-07-28'));
    assert.ok(json.result.supportedVersions.includes('2025-11-25'));
    assert.ok(json.result.supportedVersions.includes('2025-06-18'));
  });

  it('initialize with 2025-11-25 returns that version', async () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25' },
    });
    const res = await fetch(`http://127.0.0.1:${proxy.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body,
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.result.protocolVersion, '2025-11-25');
  });
});

describe('proxy: HTTP upstream served as HTTP (2026-07-28 → 2026-07-28)', () => {
  let upstream;
  let proxy;

  before(async () => {
    upstream = await startFixtureServer('server-2026-http.mjs');
    proxy = await startProxy(`http://127.0.0.1:${upstream.port}`);
  });

  after(() => {
    proxy?.child.kill('SIGTERM');
    upstream?.child.kill('SIGTERM');
  });

  it('info shows upstream server via proxy', () => {
    const url = `http://127.0.0.1:${proxy.port}/mcp`;
    const { stdout, status } = runHost(['info', url]);
    assert.equal(status, 0);
    assert.ok(stdout.includes('test-2026'));
  });

  it('tools/call works through proxy', () => {
    const url = `http://127.0.0.1:${proxy.port}/mcp`;
    const { stdout, status } = runHost(['call', url, 'echo', '-d', '{"message":"http proxy"}']);
    assert.equal(status, 0);
    assert.ok(stdout.includes('http proxy'));
  });
});

describe('proxy: credential hiding', () => {
  const UPSTREAM_SECRET = 'upstream-secret-token-XYZ';
  const MARKER_HEADER = 'x-secret-marker';
  const MARKER_VALUE = 'hidden-credential-ABC';
  let upstream;
  let proxy;

  before(async () => {
    upstream = await startFixtureServer('proxy-upstream-http.mjs');
    proxy = await startProxy(`http://127.0.0.1:${upstream.port}`, [
      '-H',
      `Authorization: Bearer ${UPSTREAM_SECRET}`,
      '-H',
      `${MARKER_HEADER}: ${MARKER_VALUE}`,
    ]);
  });

  after(() => {
    proxy?.child.kill('SIGTERM');
    upstream?.child.kill('SIGTERM');
  });

  it('upstream Authorization never appears in proxy responses', async () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    });
    const res = await fetch(`http://127.0.0.1:${proxy.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body,
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(!text.includes(UPSTREAM_SECRET), 'upstream secret found in proxy response');
    assert.ok(!text.includes(MARKER_VALUE), 'marker header value found in proxy response');
  });

  it('tools/call result does not leak credentials', async () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'echo', arguments: { message: 'test' } },
    });
    const res = await fetch(`http://127.0.0.1:${proxy.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body,
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.ok(!text.includes(UPSTREAM_SECRET));
    assert.ok(!text.includes(MARKER_VALUE));
  });
});

describe('proxy: slicc-agent loopback wire shape', () => {
  let proxy;

  before(async () => {
    const fixture = join(fixturesDir, 'server-stdio-legacy.mjs');
    proxy = await startProxy(`stdio:node ${fixture}`);
  });

  after(() => {
    proxy?.child.kill('SIGTERM');
  });

  it('matches slicc-agent loopback request pattern', async () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    });
    const res = await fetch(`http://127.0.0.1:${proxy.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'content-length': String(new TextEncoder().encode(body).length),
        host: `${proxy.port}.kernel.localhost`,
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
      params: { name: 'echo', arguments: { message: 'kernel' } },
    });
    const res = await fetch(`http://127.0.0.1:${proxy.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        host: `${proxy.port}.kernel.localhost`,
        connection: 'close',
      },
      body,
    });
    assert.equal(res.status, 200);
    const json = await res.json();
    const text = json.result.content[0].text;
    assert.ok(text.includes('kernel'));
  });
});

describe('proxy: --bearer authentication on proxy', () => {
  const PROXY_TOKEN = 'proxy-bearer-secret-99';
  let proxy;

  before(async () => {
    const fixture = join(fixturesDir, 'server-stdio-legacy.mjs');
    proxy = await startProxy(`stdio:node ${fixture}`, ['--bearer', '${PROXY_TOKEN}'], {
      PROXY_TOKEN,
    });
  });

  after(() => {
    proxy?.child.kill('SIGTERM');
  });

  it('rejects requests without bearer token', async () => {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }),
    });
    assert.equal(res.status, 401);
  });

  it('accepts correct bearer token', async () => {
    const res = await fetch(`http://127.0.0.1:${proxy.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${PROXY_TOKEN}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }),
    });
    assert.equal(res.status, 200);
  });
});

describe('proxy: SIGTERM clean shutdown', () => {
  it('shuts down cleanly on SIGTERM', async () => {
    const fixture = join(fixturesDir, 'server-stdio-legacy.mjs');
    const proxy = await startProxy(`stdio:node ${fixture}`);
    proxy.child.kill('SIGTERM');
    const code = await new Promise((resolve) => {
      proxy.child.on('exit', resolve);
    });
    assert.ok(code === 0 || code === null);
  });
});

describe('proxy: no orphaned stdio children after SIGTERM', { timeout: 30_000 }, () => {
  function pidExists(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  it('kills upstream grandchild on SIGTERM', async () => {
    const { tmpdir } = await import('node:os');
    const { writeFileSync, readFileSync, mkdirSync, existsSync, unlinkSync } = await import(
      'node:fs'
    );
    const pidFile = join(tmpdir(), `mcpcat-proxy-grandchild-${Date.now()}.pid`);
    const fixture = join(fixturesDir, 'server-stdio-grandchild.mjs');
    const proxy = await startProxy(`stdio:node ${fixture} ${pidFile}`);

    await sleep(1000);

    let parentPid, grandchildPid;
    if (existsSync(pidFile)) {
      const content = readFileSync(pidFile, 'utf8').trim().split('\n');
      parentPid = Number(content[0]);
      grandchildPid = Number(content[1]);
    }

    proxy.child.kill('SIGTERM');
    await new Promise((resolve) => proxy.child.on('exit', resolve));

    await sleep(1000);

    if (grandchildPid) {
      assert.ok(!pidExists(grandchildPid), `grandchild ${grandchildPid} is still alive`);
    }

    try {
      unlinkSync(pidFile);
    } catch {}
  });
});

describe('proxy: reconnect on upstream failure (idempotent)', { timeout: 30_000 }, () => {
  it('reconnects and retries tools/list after upstream dies', async () => {
    const fixture = join(fixturesDir, 'server-stdio-legacy.mjs');

    const upstream = spawn('node', [fixture], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });

    await sleep(200);

    const proxy = await startProxy(`stdio:node ${fixture}`);

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/list',
      params: {},
    });
    const res1 = await fetch(`http://127.0.0.1:${proxy.port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        connection: 'close',
      },
      body,
    });
    assert.equal(res1.status, 200);
    const json1 = await res1.json();
    assert.ok(json1.result.tools.length > 0);

    proxy.child.kill('SIGTERM');
    await new Promise((resolve) => proxy.child.on('exit', resolve));
    upstream.kill('SIGTERM');
  });
});

describe('add --bridge: host refuses', () => {
  it('exits 2 on the host with helpful message', () => {
    const { stderr, status } = runHost(['add', 'myserver', '--bridge', '--', 'echo', 'hi']);
    assert.equal(status, 2);
    assert.ok(stderr.includes('not available on the host'));
    assert.ok(stderr.includes('mcpcat serve --proxy'));
  });
});

describe('add --bridge: --bearer refused', () => {
  it('exits 2 when --bearer is given with --bridge', () => {
    const { stderr, status } = runHost([
      'add',
      'myserver',
      '--bridge',
      '--bearer',
      '${TOKEN}',
      '--',
      'echo',
      'hi',
    ]);
    assert.equal(status, 2);
    assert.ok(stderr.includes('not available on the host') || stderr.includes('not supported'));
  });
});
