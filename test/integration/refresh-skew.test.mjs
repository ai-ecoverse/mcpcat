import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { waitForAuthorizeUrl } from './helpers/authorize.mjs';

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
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', status: err.status ?? 1 };
  }
}

async function startServer(script, extraArgs = []) {
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

async function asLog(port) {
  return (await fetch(`http://127.0.0.1:${port}/_control/log`)).json();
}

async function clearAsLog(port) {
  await fetch(`http://127.0.0.1:${port}/_control/log`, { method: 'DELETE' });
}

async function setTtl(port, seconds) {
  await fetch(`http://127.0.0.1:${port}/_control/ttl`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ seconds }),
  });
}

async function registerToken(mcpPort, token) {
  await fetch(`http://127.0.0.1:${mcpPort}/_control/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ add: token }),
  });
}

async function doLogin(serverName, tempDir, asPort) {
  const env = { PI_CODING_AGENT_DIR: join(tempDir, 'agent'), HOME: tempDir };
  const loginProc = spawn('node', [hostBin, 'login', serverName, '--no-browser'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NODE_NO_WARNINGS: '1', ...env },
  });
  let stderrData = '';
  loginProc.stderr.on('data', (chunk) => {
    stderrData += chunk.toString();
  });
  const authorizeUrl = await waitForAuthorizeUrl(loginProc, () => stderrData);
  const authRes = await fetch(authorizeUrl, { redirect: 'manual' });
  loginProc.stdin.write(authRes.headers.get('location') + '\n');
  loginProc.stdin.end();
  await new Promise((resolve) => loginProc.on('exit', resolve));
}

describe('refresh skew: 20s TTL tokens do not refresh on every request', () => {
  let as;
  let mcp;
  let tempDir;

  before(async () => {
    as = await startServer('oauth-as.mjs');
    mcp = await startServer('server-oauth-protected.mjs', [as.issuer]);
    tempDir = join(tmpdir(), `mcpcat-skew-${Date.now()}`);
    mkdirSync(join(tempDir, 'agent'), { recursive: true });
    writeFileSync(
      join(tempDir, 'agent', 'mcp.json'),
      JSON.stringify({ mcpServers: { skewsrv: { url: `http://127.0.0.1:${mcp.port}/mcp` } } })
    );
    await setTtl(as.port, 20);
    await clearAsLog(as.port);
    await doLogin('skewsrv', tempDir, as.port);

    const log = await asLog(as.port);
    const tok = log.find((e) => e.type === 'token_issued' && e.grant === 'authorization_code');
    assert.ok(tok, 'initial token issued');
    await registerToken(mcp.port, tok.accessToken);
  });

  after(async () => {
    await setTtl(as?.port, 3600).catch(() => {});
    as?.child.kill('SIGTERM');
    mcp?.child.kill('SIGTERM');
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('three calls in a row make at most one refresh', async () => {
    const env = { PI_CODING_AGENT_DIR: join(tempDir, 'agent'), HOME: tempDir };
    await clearAsLog(as.port);

    for (let i = 0; i < 3; i++) {
      const result = runHost(['call', 'skewsrv', 'echo', '-d', `{"text":"call${i}"}`], { env });
      if (result.status !== 0) {
        const log = await asLog(as.port);
        const refreshed = log.filter(
          (e) => e.type === 'token_issued' && e.grant === 'refresh_token'
        );
        for (const r of refreshed) await registerToken(mcp.port, r.accessToken);
      }
    }

    const log = await asLog(as.port);
    const tokenRequests = log.filter((e) => e.type === 'token_request');
    const refreshRequests = tokenRequests.filter((e) => e.grantType === 'refresh_token');
    assert.ok(
      refreshRequests.length <= 1,
      `expected at most 1 refresh request for 3 calls with 20s TTL, got ${refreshRequests.length}`
    );
  });
});
