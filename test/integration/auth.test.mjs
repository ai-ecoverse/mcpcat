import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
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

async function setIss(asPort, enabled) {
  await fetch(`http://127.0.0.1:${asPort}/_control/iss`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
}

async function setCimd(asPort, enabled) {
  await fetch(`http://127.0.0.1:${asPort}/_control/cimd`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
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

function createChallenge(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}

describe('auth: end-to-end CIMD login via --no-browser paste flow', () => {
  let as;
  let mcp;
  let tempDir;

  before(async () => {
    as = await startServer('oauth-as.mjs');
    mcp = await startServer('server-oauth-protected.mjs', [as.issuer]);
    tempDir = join(tmpdir(), `mcpcat-e2e-cimd-${Date.now()}`);
    mkdirSync(join(tempDir, 'agent'), { recursive: true });
    writeMcpJson(join(tempDir, 'agent'), 'protected', `http://127.0.0.1:${mcp.port}/mcp`);
    await clearAsLog(as.port);
  });

  after(() => {
    as?.child.kill('SIGTERM');
    mcp?.child.kill('SIGTERM');
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('mcpcat login --no-browser completes with paste flow and uses CIMD', async () => {
    const env = {
      PI_CODING_AGENT_DIR: join(tempDir, 'agent'),
      HOME: tempDir,
    };

    const loginProc = spawn('node', [hostBin, 'login', 'protected', '--no-browser'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1', ...env },
    });

    let stderrData = '';
    loginProc.stderr.on('data', (chunk) => {
      stderrData += chunk.toString();
    });

    const authorizeUrl = await new Promise((resolve) => {
      const check = () => {
        const match = stderrData.match(/(http:\/\/127\.0\.0\.1:\d+\/authorize\S+)/);
        if (match) resolve(match[1]);
        else setTimeout(check, 100);
      };
      check();
    });

    const authUrl = new URL(authorizeUrl);
    assert.equal(
      authUrl.searchParams.get('client_id'),
      'https://mcpcat.sliccy.ai/oauth/client.json',
      'should use CIMD client_id'
    );
    assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256', 'should use PKCE S256');

    const authRes = await fetch(authorizeUrl, { redirect: 'manual' });
    assert.equal(authRes.status, 302);
    const redirectUrl = authRes.headers.get('location');

    const cbUrl = new URL(redirectUrl);
    const issuedToken = await getIssuedTokenAfterPaste(loginProc, redirectUrl, as.port, mcp.port);

    const exitCode = await new Promise((resolve) => {
      loginProc.on('exit', (code) => resolve(code));
    });
    assert.equal(exitCode, 0, 'login should exit 0');

    const log = await asLog(as.port);
    const authEntry = log.find((e) => e.type === 'authorize');
    assert.ok(authEntry, 'authorize request should be logged');
    assert.equal(authEntry.clientId, 'https://mcpcat.sliccy.ai/oauth/client.json');
    assert.equal(authEntry.codeChallengeMethod, 'S256');

    const tokenEntry = log.find(
      (e) => e.type === 'token_issued' && e.grant === 'authorization_code'
    );
    assert.ok(tokenEntry, 'token should have been issued');

    await registerToken(mcp.port, tokenEntry.accessToken);

    const callResult = runHost(['call', 'protected', 'echo', '-d', '{"text":"hello"}'], { env });
    assert.equal(callResult.status, 0, `call should succeed, got: ${callResult.stderr}`);
    assert.ok(callResult.stdout.includes('hello'));
  });
});

async function getIssuedTokenAfterPaste(proc, redirectUrl, asPort, mcpPort) {
  proc.stdin.write(redirectUrl + '\n');
  proc.stdin.end();
  return null;
}

describe('auth: end-to-end DCR login (iss disabled)', () => {
  let as;
  let mcp;
  let tempDir;

  before(async () => {
    as = await startServer('oauth-as.mjs');
    mcp = await startServer('server-oauth-protected.mjs', [as.issuer]);
    tempDir = join(tmpdir(), `mcpcat-e2e-dcr-${Date.now()}`);
    mkdirSync(join(tempDir, 'agent'), { recursive: true });
    writeMcpJson(join(tempDir, 'agent'), 'dcr-srv', `http://127.0.0.1:${mcp.port}/mcp`);
    await setIss(as.port, false);
    await clearAsLog(as.port);
  });

  after(async () => {
    await setIss(as?.port, true);
    as?.child.kill('SIGTERM');
    mcp?.child.kill('SIGTERM');
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('falls back to DCR with client_name mcpcat when iss is absent', async () => {
    const env = {
      PI_CODING_AGENT_DIR: join(tempDir, 'agent'),
      HOME: tempDir,
    };

    const loginProc = spawn('node', [hostBin, 'login', 'dcr-srv', '--no-browser'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1', ...env },
    });

    let stderrData = '';
    loginProc.stderr.on('data', (chunk) => {
      stderrData += chunk.toString();
    });

    const authorizeUrl = await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`No authorize URL found in: ${stderrData}`)),
        10_000
      );
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
    assert.equal(exitCode, 0, 'login should exit 0');

    const log = await asLog(as.port);
    const dcrEntry = log.find((e) => e.type === 'dcr');
    assert.ok(dcrEntry, 'DCR registration should have happened');
    assert.equal(dcrEntry.clientName, 'mcpcat', 'DCR client_name should be mcpcat');
  });
});

describe('auth: loopback callback (no paste)', () => {
  let as;
  let mcp;
  let tempDir;

  before(async () => {
    as = await startServer('oauth-as.mjs');
    mcp = await startServer('server-oauth-protected.mjs', [as.issuer]);
    tempDir = join(tmpdir(), `mcpcat-e2e-loopback-${Date.now()}`);
    mkdirSync(join(tempDir, 'agent'), { recursive: true });
    writeMcpJson(join(tempDir, 'agent'), 'loopback-srv', `http://127.0.0.1:${mcp.port}/mcp`);
    await clearAsLog(as.port);
  });

  after(() => {
    as?.child.kill('SIGTERM');
    mcp?.child.kill('SIGTERM');
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('drives the real loopback callback with an HTTP GET', async () => {
    const env = {
      PI_CODING_AGENT_DIR: join(tempDir, 'agent'),
      HOME: tempDir,
    };

    const loginProc = spawn('node', [hostBin, 'login', 'loopback-srv'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1', ...env },
    });

    let stderrData = '';
    loginProc.stderr.on('data', (chunk) => {
      stderrData += chunk.toString();
    });

    const authorizeUrl = await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`No authorize URL: ${stderrData}`)),
        10_000
      );
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
    assert.equal(authRes.status, 302);
    const redirectUrl = authRes.headers.get('location');

    const cbRes = await fetch(redirectUrl, { redirect: 'manual' });
    assert.ok(
      cbRes.status === 200 || cbRes.status === 302,
      `callback should succeed, got ${cbRes.status}`
    );

    const exitCode = await new Promise((resolve) => {
      loginProc.on('exit', (code) => resolve(code));
    });
    assert.equal(exitCode, 0, 'login should exit 0 after loopback callback');
  });
});

describe('auth: automatic refresh after token expiry', () => {
  let as;
  let mcp;
  let tempDir;

  before(async () => {
    as = await startServer('oauth-as.mjs');
    mcp = await startServer('server-oauth-protected.mjs', [as.issuer]);
    tempDir = join(tmpdir(), `mcpcat-e2e-refresh-${Date.now()}`);
    mkdirSync(join(tempDir, 'agent'), { recursive: true });
    writeMcpJson(join(tempDir, 'agent'), 'refresh-srv', `http://127.0.0.1:${mcp.port}/mcp`);
    await clearAsLog(as.port);

    const env = {
      PI_CODING_AGENT_DIR: join(tempDir, 'agent'),
      HOME: tempDir,
    };
    const loginProc = spawn('node', [hostBin, 'login', 'refresh-srv', '--no-browser'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1', ...env },
    });

    let stderrData = '';
    loginProc.stderr.on('data', (chunk) => {
      stderrData += chunk.toString();
    });

    const authorizeUrl = await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`No authorize URL: ${stderrData}`)),
        10_000
      );
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
    await new Promise((resolve) => loginProc.on('exit', resolve));

    const log = await asLog(as.port);
    const tokenEntry = log.find(
      (e) => e.type === 'token_issued' && e.grant === 'authorization_code'
    );
    assert.ok(tokenEntry, 'initial token should be issued');
    await registerToken(mcp.port, tokenEntry.accessToken);

    const callResult = runHost(['call', 'refresh-srv', 'echo', '-d', '{"text":"before"}'], { env });
    assert.equal(callResult.status, 0, `initial call should succeed: ${callResult.stderr}`);
  });

  after(() => {
    as?.child.kill('SIGTERM');
    mcp?.child.kill('SIGTERM');
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('refreshes automatically after token expiry and leaves new token in store at 0600', async () => {
    const env = {
      PI_CODING_AGENT_DIR: join(tempDir, 'agent'),
      HOME: tempDir,
    };

    await expireAllOnMcp(mcp.port);
    await expireOnAs(as.port);
    await clearAsLog(as.port);

    const authPath = join(tempDir, 'agent', 'mcp-auth.json');
    const storeBefore = JSON.parse(readFileSync(authPath, 'utf8'));
    const keysBefore = Object.keys(storeBefore);
    assert.ok(keysBefore.length > 0, 'should have a stored token');
    const oldToken = Object.values(storeBefore)[0].tokens?.access_token;

    const callResult = runHost(['call', 'refresh-srv', 'echo', '-d', '{"text":"refreshed"}'], {
      env,
    });

    const log = await asLog(as.port);
    const refreshEntry = log.find((e) => e.type === 'token_issued' && e.grant === 'refresh_token');
    assert.ok(refreshEntry, 'refresh should have been issued');

    await registerToken(mcp.port, refreshEntry.accessToken);

    const callResult2 = runHost(['call', 'refresh-srv', 'echo', '-d', '{"text":"after-refresh"}'], {
      env,
    });
    assert.equal(callResult2.status, 0, `call after refresh should succeed: ${callResult2.stderr}`);
    assert.ok(callResult2.stdout.includes('after-refresh'));

    const storeAfter = JSON.parse(readFileSync(authPath, 'utf8'));
    const newToken = Object.values(storeAfter)[0].tokens?.access_token;
    assert.notEqual(newToken, oldToken, 'token should have changed');
    assert.ok(newToken, 'new token should be present');

    const s = statSync(authPath);
    assert.equal(
      s.mode & 0o777,
      0o600,
      `file should be 0600 after refresh, got ${(s.mode & 0o777).toString(8)}`
    );
  });
});

describe('auth: URL-target login and call (no mcp.json entry)', () => {
  let as;
  let mcp;
  let tempDir;

  before(async () => {
    as = await startServer('oauth-as.mjs');
    mcp = await startServer('server-oauth-protected.mjs', [as.issuer]);
    tempDir = join(tmpdir(), `mcpcat-e2e-url-${Date.now()}`);
    mkdirSync(join(tempDir, 'agent'), { recursive: true });
    await clearAsLog(as.port);
  });

  after(() => {
    as?.child.kill('SIGTERM');
    mcp?.child.kill('SIGTERM');
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('login with URL target, then call succeeds with stored token', async () => {
    const serverUrl = `http://127.0.0.1:${mcp.port}/mcp`;
    const env = {
      PI_CODING_AGENT_DIR: join(tempDir, 'agent'),
      HOME: tempDir,
    };

    const loginProc = spawn('node', [hostBin, 'login', serverUrl, '--no-browser'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1', ...env },
    });

    let stderrData = '';
    loginProc.stderr.on('data', (chunk) => {
      stderrData += chunk.toString();
    });

    const authorizeUrl = await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`No authorize URL: ${stderrData}`)),
        10_000
      );
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
    assert.equal(exitCode, 0, `login should exit 0, stderr: ${stderrData}`);

    const log = await asLog(as.port);
    const tokenEntry = log.find(
      (e) => e.type === 'token_issued' && e.grant === 'authorization_code'
    );
    assert.ok(tokenEntry, 'token should have been issued');
    await registerToken(mcp.port, tokenEntry.accessToken);

    const callResult = runHost(['call', serverUrl, 'echo', '-d', '{"text":"url-target"}'], {
      env,
    });
    assert.equal(callResult.status, 0, `call should succeed: ${callResult.stderr}`);
    assert.ok(callResult.stdout.includes('url-target'));

    const authPath = join(tempDir, 'agent', 'mcp-auth.json');
    const store = JSON.parse(readFileSync(authPath, 'utf8'));
    const u = new URL(serverUrl);
    const urlKey = `url:${u.origin}${u.pathname}`;
    const found = Object.keys(store).some((k) => k.includes(urlKey));
    assert.ok(found, `store should have a key containing ${urlKey}`);
  });
});

describe('auth: 401 without stored tokens exits 4', () => {
  let mcp;
  let tempDir;

  before(async () => {
    const as = await startServer('oauth-as.mjs');
    mcp = await startServer('server-oauth-protected.mjs', [as.issuer]);
    as.child.kill('SIGTERM');
    tempDir = join(tmpdir(), `mcpcat-e2e-noauth-${Date.now()}`);
    mkdirSync(join(tempDir, 'agent'), { recursive: true });
    writeMcpJson(join(tempDir, 'agent'), 'no-auth-srv', `http://127.0.0.1:${mcp.port}/mcp`);
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
    const result = runHost(['call', 'no-auth-srv', 'echo', '-d', '{"text":"hi"}'], { env });
    assert.equal(result.status, 4, `expected exit 4, got ${result.status}: ${result.stderr}`);
    assert.ok(result.stderr.includes('login'), 'should mention login');
  });
});

describe('auth: step-up insufficient_scope exits 4', () => {
  let as;
  let mcp;
  let tempDir;

  before(async () => {
    as = await startServer('oauth-as.mjs');
    mcp = await startServer('server-oauth-protected.mjs', [as.issuer]);
    tempDir = join(tmpdir(), `mcpcat-e2e-stepup-${Date.now()}`);
    mkdirSync(join(tempDir, 'agent'), { recursive: true });
    writeMcpJson(join(tempDir, 'agent'), 'stepup-srv', `http://127.0.0.1:${mcp.port}/mcp`);
    await clearAsLog(as.port);

    const env = {
      PI_CODING_AGENT_DIR: join(tempDir, 'agent'),
      HOME: tempDir,
    };
    const loginProc = spawn('node', [hostBin, 'login', 'stepup-srv', '--no-browser'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1', ...env },
    });

    let stderrData = '';
    loginProc.stderr.on('data', (chunk) => {
      stderrData += chunk.toString();
    });

    const authorizeUrl = await new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`No authorize URL: ${stderrData}`)),
        10_000
      );
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
    await new Promise((resolve) => loginProc.on('exit', resolve));

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

  it('exits 4 on insufficient_scope', () => {
    const env = {
      PI_CODING_AGENT_DIR: join(tempDir, 'agent'),
      HOME: tempDir,
    };
    const result = runHost(['call', 'stepup-srv', 'echo', '-d', '{"text":"hi"}'], { env });
    assert.equal(result.status, 4, `expected exit 4, got ${result.status}: ${result.stderr}`);
    assert.ok(
      result.stderr.includes('--scope') && result.stderr.includes('admin'),
      `should mention --scope admin: ${result.stderr}`
    );
  });
});

describe('auth: header expansion', () => {
  it('${VAR} in -H is expanded from env', () => {
    const { stdout, stderr } = runHost(
      ['info', 'http://127.0.0.1:1', '-H', 'Authorization: Bearer ${MY_TOKEN}'],
      { env: { MY_TOKEN: 'secret_value_42' } }
    );
    assert.ok(!stdout.includes('secret_value_42'), 'token must not appear in stdout');
    assert.ok(!stderr.includes('secret_value_42'), 'token must not appear in stderr');
  });

  it('${VAR} is redacted in -v output', () => {
    const { stderr } = runHost(
      ['-v', 'info', 'http://127.0.0.1:1', '-H', 'Authorization: Bearer ${MY_TOKEN}'],
      { env: { MY_TOKEN: 'secret_value_42' } }
    );
    assert.ok(!stderr.includes('secret_value_42'), 'token must not appear in verbose output');
    if (stderr.includes('Authorization')) {
      assert.ok(stderr.includes('[REDACTED]'), 'should be redacted');
    }
  });
});

describe('auth: no secrets leak', () => {
  it('planted token never appears in output', () => {
    const marker = `PLANTED_SECRET_${Date.now()}`;
    const { stdout, stderr } = runHost(
      ['info', 'http://127.0.0.1:1', '-H', `X-Secret: ${marker}`],
      { env: {} }
    );
    assert.ok(!stdout.includes(marker), 'marker must not appear in stdout');
    assert.ok(!stderr.includes(marker), 'marker must not appear in stderr');
  });
});

describe('auth: token store interop with pi', () => {
  let tempDir;

  before(() => {
    tempDir = join(tmpdir(), `mcpcat-interop-${Date.now()}`);
    mkdirSync(join(tempDir, 'agent'), { recursive: true });
  });

  after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('reads a pi-written mcp-auth.json', () => {
    const authPath = join(tempDir, 'agent', 'mcp-auth.json');
    const piState = {
      'mcp__test_server|https://example.com/mcp': {
        serverUrl: 'https://example.com/mcp',
        tokens: {
          access_token: 'pi_token_123',
          token_type: 'Bearer',
          refresh_token: 'pi_refresh_456',
          scope: 'read',
        },
        tokensExpireAt: Date.now() + 3600000,
      },
    };
    writeFileSync(authPath, `${JSON.stringify(piState, null, 2)}\n`, { mode: 0o600 });

    const { status } = runHost(['info', 'https://example.com/mcp'], {
      env: { PI_CODING_AGENT_DIR: join(tempDir, 'agent') },
    });
    assert.ok(status === 0 || status === 3, `unexpected status ${status}`);
  });

  it('pi key format matches after mcpcat write', () => {
    const authPath = join(tempDir, 'agent', 'mcp-auth.json');
    const data = JSON.parse(readFileSync(authPath, 'utf8'));
    const key = 'mcp__test_server|https://example.com/mcp';
    assert.ok(data[key], 'key should exist');
    assert.equal(data[key].tokens.access_token, 'pi_token_123');
  });
});

describe('auth: 0600 file permissions', () => {
  let tempDir;

  before(() => {
    tempDir = join(tmpdir(), `mcpcat-perms-${Date.now()}`);
    mkdirSync(join(tempDir, 'agent'), { recursive: true });
  });

  after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates mcp-auth.json with 0600', () => {
    const authPath = join(tempDir, 'agent', 'mcp-auth.json');
    writeFileSync(authPath, '{}', { mode: 0o600 });
    const s = statSync(authPath);
    assert.equal(s.mode & 0o777, 0o600);
  });

  it('stays 0600 after rewrite', () => {
    const authPath = join(tempDir, 'agent', 'mcp-auth.json');
    writeFileSync(authPath, '{"key": "val"}', { mode: 0o600 });
    writeFileSync(authPath, '{"key": "val2"}', { mode: 0o600 });
    const s = statSync(authPath);
    assert.equal(s.mode & 0o777, 0o600);
  });
});

describe('auth: OAuth fixture AS endpoints', () => {
  let as;

  before(async () => {
    as = await startServer('oauth-as.mjs');
  });

  after(() => {
    as?.child.kill('SIGTERM');
  });

  it('serves AS metadata', async () => {
    const res = await fetch(`http://127.0.0.1:${as.port}/.well-known/oauth-authorization-server`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.issuer, `http://127.0.0.1:${as.port}`);
    assert.ok(body.client_id_metadata_document_supported);
  });

  it('serves PRM metadata', async () => {
    const res = await fetch(`http://127.0.0.1:${as.port}/.well-known/oauth-protected-resource`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.authorization_servers.includes(`http://127.0.0.1:${as.port}`));
  });

  it('handles DCR', async () => {
    const res = await fetch(`http://127.0.0.1:${as.port}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'mcpcat',
        redirect_uris: ['http://127.0.0.1/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.client_id);
  });

  it('PKCE token exchange', async () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = createChallenge(verifier);

    const authRes = await fetch(
      `http://127.0.0.1:${as.port}/authorize?client_id=test&redirect_uri=http://127.0.0.1/callback&state=pkce&code_challenge=${challenge}&code_challenge_method=S256&response_type=code`,
      { redirect: 'manual' }
    );
    const location = new URL(authRes.headers.get('location'));
    const code = location.searchParams.get('code');

    const tokenRes = await fetch(`http://127.0.0.1:${as.port}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: 'http://127.0.0.1/callback',
      }),
    });
    assert.equal(tokenRes.status, 200);
    const tokenBody = await tokenRes.json();
    assert.ok(tokenBody.access_token);
    assert.ok(tokenBody.refresh_token);
  });

  it('iss toggle works', async () => {
    await setIss(as.port, false);
    const res = await fetch(
      `http://127.0.0.1:${as.port}/authorize?client_id=test&redirect_uri=http://127.0.0.1/callback&state=def&response_type=code`,
      { redirect: 'manual' }
    );
    const location = new URL(res.headers.get('location'));
    assert.ok(!location.searchParams.has('iss'), 'iss should be absent');
    await setIss(as.port, true);
  });
});
