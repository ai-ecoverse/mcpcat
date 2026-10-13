import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

async function asLog(asPort) {
  const res = await fetch(`http://127.0.0.1:${asPort}/_control/log`);
  return res.json();
}

async function clearAsLog(asPort) {
  await fetch(`http://127.0.0.1:${asPort}/_control/log`, { method: 'DELETE' });
}

async function registerToken(mcpPort, token) {
  await fetch(`http://127.0.0.1:${mcpPort}/_control/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ add: token }),
  });
}

async function expireAllOnMcp(mcpPort) {
  await fetch(`http://127.0.0.1:${mcpPort}/_control/expire-all`, { method: 'POST' });
}

async function setStepUp(mcpPort, enabled, scope) {
  await fetch(`http://127.0.0.1:${mcpPort}/_control/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ stepUp: enabled, stepUpScope: scope }),
  });
}

async function expireOnAs(asPort, token) {
  await fetch(`http://127.0.0.1:${asPort}/_control/expire`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: token ? JSON.stringify({ token }) : JSON.stringify({}),
  });
}

function writeMcpJson(dir, serverName, url) {
  const config = {
    mcpServers: {
      [serverName]: { url },
    },
  };
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify(config, null, 2));
}

async function loginViaPaste(hostBin, target, env, asPort) {
  const loginProc = spawn('node', [hostBin, 'login', target, '--no-browser'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NODE_NO_WARNINGS: '1', ...env },
  });

  let stderrData = '';
  loginProc.stderr.on('data', (chunk) => {
    stderrData += chunk.toString();
  });

  const authorizeUrl = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`No authorize URL: ${stderrData}`)), 10_000);
    const check = () => {
      const match = stderrData.match(/(http:\/\/127\.0\.0\.1:\d+\/authorize\S+)/);
      if (match) {
        clearTimeout(timeout);
        resolve(match[1]);
      } else {
        setTimeout(check, 100);
      }
    };
    check();
  });

  const authRes = await fetch(authorizeUrl, { redirect: 'manual' });
  const redirectUrl = authRes.headers.get('location');
  loginProc.stdin.write(redirectUrl + '\n');
  loginProc.stdin.end();

  const exitCode = await new Promise((resolve) => {
    loginProc.on('exit', (code) => resolve(code));
  });

  return { exitCode, redirectUrl, authorizeUrl, stderrData };
}

describe('auth-2026: login against 2026-only protected server', () => {
  let as;
  let mcp;
  let tempDir;

  before(async () => {
    as = await startServer('oauth-as.mjs');
    mcp = await startServer('server-2026-oauth-protected.mjs', [as.issuer]);
    tempDir = join(tmpdir(), `mcpcat-2026-auth-login-${Date.now()}`);
    mkdirSync(join(tempDir, 'agent'), { recursive: true });
    writeMcpJson(join(tempDir, 'agent'), 'protected-2026', `http://127.0.0.1:${mcp.port}/mcp`);
    await clearAsLog(as.port);
  });

  after(() => {
    as?.child.kill('SIGTERM');
    mcp?.child.kill('SIGTERM');
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('login succeeds with paste flow against 2026-only server', async () => {
    const env = {
      PI_CODING_AGENT_DIR: join(tempDir, 'agent'),
      HOME: tempDir,
    };

    const { exitCode } = await loginViaPaste(hostBin, 'protected-2026', env, as.port);
    assert.equal(exitCode, 0, 'login should exit 0');

    const log = await asLog(as.port);
    const tokenEntry = log.find(
      (e) => e.type === 'token_issued' && e.grant === 'authorization_code'
    );
    assert.ok(tokenEntry, 'token should have been issued');
  });
});

describe('auth-2026: call with stored token via stateless path', () => {
  let as;
  let mcp;
  let tempDir;

  before(async () => {
    as = await startServer('oauth-as.mjs');
    mcp = await startServer('server-2026-oauth-protected.mjs', [as.issuer]);
    tempDir = join(tmpdir(), `mcpcat-2026-auth-call-${Date.now()}`);
    mkdirSync(join(tempDir, 'agent'), { recursive: true });
    writeMcpJson(join(tempDir, 'agent'), 'call-2026', `http://127.0.0.1:${mcp.port}/mcp`);
    await clearAsLog(as.port);

    const env = {
      PI_CODING_AGENT_DIR: join(tempDir, 'agent'),
      HOME: tempDir,
    };
    const { exitCode } = await loginViaPaste(hostBin, 'call-2026', env, as.port);
    assert.equal(exitCode, 0, 'login should succeed');

    const log = await asLog(as.port);
    const tokenEntry = log.find(
      (e) => e.type === 'token_issued' && e.grant === 'authorization_code'
    );
    assert.ok(tokenEntry, 'token should have been issued');
    await registerToken(mcp.port, tokenEntry.accessToken);
  });

  after(() => {
    as?.child.kill('SIGTERM');
    mcp?.child.kill('SIGTERM');
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('call succeeds with stored token on 2026 stateless path', () => {
    const env = {
      PI_CODING_AGENT_DIR: join(tempDir, 'agent'),
      HOME: tempDir,
    };
    const result = runHost(['call', 'call-2026', 'echo', '-d', '{"text":"hello-2026"}'], { env });
    assert.equal(result.status, 0, `call should succeed, got: ${result.stderr}`);
    assert.ok(result.stdout.includes('hello-2026'));
  });

  it('info shows 2026-07-28 protocol version', () => {
    const env = {
      PI_CODING_AGENT_DIR: join(tempDir, 'agent'),
      HOME: tempDir,
    };
    const result = runHost(['info', 'call-2026', '--json'], { env });
    assert.equal(result.status, 0, `info should succeed, got: ${result.stderr}`);
    const info = JSON.parse(result.stdout);
    assert.equal(info.protocolVersion, '2026-07-28');
  });
});

describe('auth-2026: automatic refresh after token expiry', () => {
  let as;
  let mcp;
  let tempDir;

  before(async () => {
    as = await startServer('oauth-as.mjs');
    mcp = await startServer('server-2026-oauth-protected.mjs', [as.issuer]);
    tempDir = join(tmpdir(), `mcpcat-2026-auth-refresh-${Date.now()}`);
    mkdirSync(join(tempDir, 'agent'), { recursive: true });
    writeMcpJson(join(tempDir, 'agent'), 'refresh-2026', `http://127.0.0.1:${mcp.port}/mcp`);
    await clearAsLog(as.port);

    const env = {
      PI_CODING_AGENT_DIR: join(tempDir, 'agent'),
      HOME: tempDir,
    };
    const { exitCode } = await loginViaPaste(hostBin, 'refresh-2026', env, as.port);
    assert.equal(exitCode, 0, 'login should succeed');

    const log = await asLog(as.port);
    const tokenEntry = log.find(
      (e) => e.type === 'token_issued' && e.grant === 'authorization_code'
    );
    assert.ok(tokenEntry, 'token should have been issued');
    await registerToken(mcp.port, tokenEntry.accessToken);

    const callResult = runHost(['call', 'refresh-2026', 'echo', '-d', '{"text":"before"}'], {
      env,
    });
    assert.equal(callResult.status, 0, `initial call should succeed: ${callResult.stderr}`);
  });

  after(() => {
    as?.child.kill('SIGTERM');
    mcp?.child.kill('SIGTERM');
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('refreshes automatically and recovers after token expiry', async () => {
    const env = {
      PI_CODING_AGENT_DIR: join(tempDir, 'agent'),
      HOME: tempDir,
    };

    await expireAllOnMcp(mcp.port);
    await expireOnAs(as.port);
    await clearAsLog(as.port);

    const authPath = join(tempDir, 'agent', 'mcp-auth.json');
    const storeBefore = JSON.parse(readFileSync(authPath, 'utf8'));
    const oldToken = Object.values(storeBefore)[0].tokens?.access_token;

    const callResult = runHost(['call', 'refresh-2026', 'echo', '-d', '{"text":"refreshed"}'], {
      env,
    });

    const log = await asLog(as.port);
    const refreshEntry = log.find((e) => e.type === 'token_issued' && e.grant === 'refresh_token');
    assert.ok(refreshEntry, 'refresh should have been issued');

    await registerToken(mcp.port, refreshEntry.accessToken);

    const callResult2 = runHost(
      ['call', 'refresh-2026', 'echo', '-d', '{"text":"after-refresh"}'],
      { env }
    );
    assert.equal(callResult2.status, 0, `call after refresh should succeed: ${callResult2.stderr}`);
    assert.ok(callResult2.stdout.includes('after-refresh'));

    const storeAfter = JSON.parse(readFileSync(authPath, 'utf8'));
    const newToken = Object.values(storeAfter)[0].tokens?.access_token;
    assert.notEqual(newToken, oldToken, 'token should have changed');

    const s = statSync(authPath);
    assert.equal(
      s.mode & 0o777,
      0o600,
      `file should be 0600 after refresh, got ${(s.mode & 0o777).toString(8)}`
    );
  });
});

describe('auth-2026: step-up insufficient_scope exits 4', () => {
  let as;
  let mcp;
  let tempDir;

  before(async () => {
    as = await startServer('oauth-as.mjs');
    mcp = await startServer('server-2026-oauth-protected.mjs', [as.issuer]);
    tempDir = join(tmpdir(), `mcpcat-2026-auth-stepup-${Date.now()}`);
    mkdirSync(join(tempDir, 'agent'), { recursive: true });
    writeMcpJson(join(tempDir, 'agent'), 'stepup-2026', `http://127.0.0.1:${mcp.port}/mcp`);
    await clearAsLog(as.port);

    const env = {
      PI_CODING_AGENT_DIR: join(tempDir, 'agent'),
      HOME: tempDir,
    };
    const { exitCode } = await loginViaPaste(hostBin, 'stepup-2026', env, as.port);
    assert.equal(exitCode, 0, 'login should succeed');

    const log = await asLog(as.port);
    const tokenEntry = log.find((e) => e.type === 'token_issued');
    if (tokenEntry) await registerToken(mcp.port, tokenEntry.accessToken);
    await setStepUp(mcp.port, true, 'admin');
  });

  after(async () => {
    await setStepUp(mcp?.port, false);
    as?.child.kill('SIGTERM');
    mcp?.child.kill('SIGTERM');
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('exits 4 on insufficient_scope with --scope hint', () => {
    const env = {
      PI_CODING_AGENT_DIR: join(tempDir, 'agent'),
      HOME: tempDir,
    };
    const result = runHost(['call', 'stepup-2026', 'echo', '-d', '{"text":"hi"}'], { env });
    assert.equal(result.status, 4, `expected exit 4, got ${result.status}: ${result.stderr}`);
    assert.ok(
      result.stderr.includes('--scope') && result.stderr.includes('admin'),
      `should mention --scope admin: ${result.stderr}`
    );
  });
});

describe('auth-2026: 401 without stored tokens exits 4', () => {
  let as;
  let mcp;
  let tempDir;

  before(async () => {
    as = await startServer('oauth-as.mjs');
    mcp = await startServer('server-2026-oauth-protected.mjs', [as.issuer]);
    as.child.kill('SIGTERM');
    tempDir = join(tmpdir(), `mcpcat-2026-auth-noauth-${Date.now()}`);
    mkdirSync(join(tempDir, 'agent'), { recursive: true });
    writeMcpJson(join(tempDir, 'agent'), 'no-auth-2026', `http://127.0.0.1:${mcp.port}/mcp`);
  });

  after(() => {
    mcp?.child.kill('SIGTERM');
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('exits 4 and names mcpcat login', () => {
    const env = {
      PI_CODING_AGENT_DIR: join(tempDir, 'agent'),
      HOME: tempDir,
    };
    const result = runHost(['call', 'no-auth-2026', 'echo', '-d', '{"text":"hi"}'], { env });
    assert.equal(result.status, 4, `expected exit 4, got ${result.status}: ${result.stderr}`);
    assert.ok(result.stderr.includes('login'), 'should mention login');
  });
});

describe('auth-2026: URL-target login and call', () => {
  let as;
  let mcp;
  let tempDir;

  before(async () => {
    as = await startServer('oauth-as.mjs');
    mcp = await startServer('server-2026-oauth-protected.mjs', [as.issuer]);
    tempDir = join(tmpdir(), `mcpcat-2026-auth-url-${Date.now()}`);
    mkdirSync(join(tempDir, 'agent'), { recursive: true });
    await clearAsLog(as.port);
  });

  after(() => {
    as?.child.kill('SIGTERM');
    mcp?.child.kill('SIGTERM');
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('login with URL target, then call succeeds on 2026 path', async () => {
    const serverUrl = `http://127.0.0.1:${mcp.port}/mcp`;
    const env = {
      PI_CODING_AGENT_DIR: join(tempDir, 'agent'),
      HOME: tempDir,
    };

    const { exitCode } = await loginViaPaste(hostBin, serverUrl, env, as.port);
    assert.equal(exitCode, 0, 'login should exit 0');

    const log = await asLog(as.port);
    const tokenEntry = log.find(
      (e) => e.type === 'token_issued' && e.grant === 'authorization_code'
    );
    assert.ok(tokenEntry, 'token should have been issued');
    await registerToken(mcp.port, tokenEntry.accessToken);

    const callResult = runHost(['call', serverUrl, 'echo', '-d', '{"text":"url-2026"}'], { env });
    assert.equal(callResult.status, 0, `call should succeed: ${callResult.stderr}`);
    assert.ok(callResult.stdout.includes('url-2026'));
  });
});
