import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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

function writeMcpJson(dir, serverName, url) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'mcp.json'),
    JSON.stringify({ mcpServers: { [serverName]: { url } } }, null, 2)
  );
}

async function asLog(asPort) {
  return (await fetch(`http://127.0.0.1:${asPort}/_control/log`)).json();
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

async function expireOnAs(asPort) {
  await fetch(`http://127.0.0.1:${asPort}/_control/expire`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
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

describe('B5r2-1: refreshed tokens are redacted in error output', () => {
  let as;
  let mcp;
  let tempDir;

  before(async () => {
    as = await startServer('oauth-as.mjs');
    mcp = await startServer('server-oauth-protected.mjs', [as.issuer]);
    tempDir = join(tmpdir(), `mcpcat-b5r2-1-${Date.now()}`);
    mkdirSync(join(tempDir, 'agent'), { recursive: true });
    writeMcpJson(join(tempDir, 'agent'), 'redact-srv', `http://127.0.0.1:${mcp.port}/mcp`);
    await clearAsLog(as.port);
    await doLogin('redact-srv', tempDir, as.port);
    const log = await asLog(as.port);
    const tok = log.find((e) => e.type === 'token_issued' && e.grant === 'authorization_code');
    await registerToken(mcp.port, tok.accessToken);
  });

  after(() => {
    as?.child.kill('SIGTERM');
    mcp?.child.kill('SIGTERM');
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('new token from refresh is not printed raw in errors', async () => {
    const env = { PI_CODING_AGENT_DIR: join(tempDir, 'agent'), HOME: tempDir };
    await expireAllOnMcp(mcp.port);
    await expireOnAs(as.port);
    await clearAsLog(as.port);

    const result = runHost(['call', 'redact-srv', 'echo', '-d', '{"text":"t"}'], { env });

    const log = await asLog(as.port);
    const refreshed = log.find((e) => e.type === 'token_issued' && e.grant === 'refresh_token');
    assert.ok(refreshed, 'refresh should have happened');

    const newToken = refreshed.accessToken;
    assert.ok(newToken, 'new token should exist');
    assert.ok(!result.stdout.includes(newToken), 'new token must not appear in stdout');
    assert.ok(!result.stderr.includes(newToken), 'new token must not appear in stderr');

    const jsonResult = runHost(['--json', 'call', 'redact-srv', 'echo', '-d', '{"text":"t"}'], {
      env,
    });
    assert.ok(!jsonResult.stdout.includes(newToken), 'new token must not appear in --json stdout');
    assert.ok(!jsonResult.stderr.includes(newToken), 'new token must not appear in --json stderr');
  });
});

describe('B5r2-2: no auth lock leak on --json info legacy server', () => {
  let server;
  let tempDir;

  before(async () => {
    server = await startServer('server-legacy-http.mjs');
    tempDir = join(tmpdir(), `mcpcat-b5r2-2-${Date.now()}`);
    const agent = join(tempDir, 'agent');
    mkdirSync(agent, { recursive: true });
    const url = `http://127.0.0.1:${server.port}`;
    writeFileSync(
      join(agent, 'mcp-auth.json'),
      JSON.stringify({
        [`mcp__legacy|${url}/`]: {
          serverUrl: `${url}/`,
          tokens: { access_token: 'tok_legacy_123', token_type: 'Bearer' },
        },
      }),
      { mode: 0o600 }
    );
    writeMcpJson(agent, 'legacy', url);
  });

  after(() => {
    server?.child.kill('SIGTERM');
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('--json info on legacy server leaves no lock behind', () => {
    const env = { PI_CODING_AGENT_DIR: join(tempDir, 'agent'), HOME: tempDir };
    const result = runHost(['--json', 'info', 'legacy'], { env });
    assert.equal(result.status, 0, `should succeed: ${result.stderr}`);

    const locks = readdirSync(join(tempDir, 'agent')).filter((f) => f.includes('.lock'));
    assert.equal(locks.length, 0, `no lock files should remain, found: ${locks.join(', ')}`);
  });

  it('subsequent tools call succeeds (no stale lock)', () => {
    const env = { PI_CODING_AGENT_DIR: join(tempDir, 'agent'), HOME: tempDir };
    runHost(['--json', 'info', 'legacy'], { env });
    const result = runHost(['tools', 'legacy'], { env });
    assert.equal(result.status, 0, `tools should succeed after --json info: ${result.stderr}`);
  });
});

describe('B5r2-3: jerk asked on 401 (no pi-file token)', () => {
  let mcp;
  let tempDir;
  let invocationLog;

  before(async () => {
    const as = await startServer('oauth-as.mjs');
    mcp = await startServer('server-oauth-protected.mjs', [as.issuer]);
    tempDir = join(tmpdir(), `mcpcat-b5r2-3-${Date.now()}`);
    mkdirSync(join(tempDir, 'bin'), { recursive: true });
    mkdirSync(join(tempDir, 'agent'), { recursive: true });
    invocationLog = join(tempDir, 'jerk.log');
    writeFileSync(invocationLog, '');

    await clearAsLog(as.port);
    const controlRes = await fetch(`http://127.0.0.1:${as.port}/_control/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'default' }),
    });
    const { access_token } = await controlRes.json();
    await registerToken(mcp.port, access_token);

    const fakeJerk = join(tempDir, 'bin', 'jerk');
    writeFileSync(
      fakeJerk,
      `#!/bin/sh
echo "$@" >> ${invocationLog}
case "$1" in
  --version) echo "jerk 0.14.1"; exit 0;;
esac
# mcp:* get --reveal --json
if echo "$@" | grep -q "get.*--reveal.*--json"; then
  echo '{"token":"${access_token}","expires_at":9999999999}'
  exit 0
fi
exit 4
`,
      { mode: 0o755 }
    );

    writeMcpJson(join(tempDir, 'agent'), 'jerk-srv', `http://127.0.0.1:${mcp.port}/mcp`);
    as.child.kill('SIGTERM');
  });

  after(() => {
    mcp?.child.kill('SIGTERM');
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('401 triggers jerk get, call succeeds with jerk token', () => {
    const env = {
      PATH: `${join(tempDir, 'bin')}:${process.env.PATH}`,
      PI_CODING_AGENT_DIR: join(tempDir, 'agent'),
      HOME: tempDir,
    };
    const result = runHost(['call', 'jerk-srv', 'echo', '-d', '{"text":"jerk-auth"}'], { env });

    const log = readFileSync(invocationLog, 'utf8').trim();
    const calls = log ? log.split('\n') : [];
    const getCalls = calls.filter((l) => l.includes('get') && l.includes('--reveal'));
    assert.ok(
      getCalls.length >= 1,
      `should have at least one jerk get call, got: ${calls.join('; ')}`
    );

    assert.equal(result.status, 0, `call should succeed with jerk token: ${result.stderr}`);
    assert.ok(result.stdout.includes('jerk-auth'));
  });
});

describe('B5r2-4: SIGINT during refresh releases lock', () => {
  let as;
  let mcp;
  let tempDir;

  before(async () => {
    as = await startServer('oauth-as.mjs');
    mcp = await startServer('server-oauth-protected.mjs', [as.issuer]);
    tempDir = join(tmpdir(), `mcpcat-b5r2-4-${Date.now()}`);
    mkdirSync(join(tempDir, 'agent'), { recursive: true });
    writeMcpJson(join(tempDir, 'agent'), 'sig-srv', `http://127.0.0.1:${mcp.port}/mcp`);
    await clearAsLog(as.port);
    await doLogin('sig-srv', tempDir, as.port);
    const log = await asLog(as.port);
    const tok = log.find((e) => e.type === 'token_issued' && e.grant === 'authorization_code');
    await registerToken(mcp.port, tok.accessToken);
  });

  after(async () => {
    await fetch(`http://127.0.0.1:${as.port}/_control/delay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ms: 0 }),
    }).catch(() => {});
    as?.child.kill('SIGTERM');
    mcp?.child.kill('SIGTERM');
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('SIGINT during slow refresh leaves no lock, next command succeeds', async () => {
    const env = { PI_CODING_AGENT_DIR: join(tempDir, 'agent'), HOME: tempDir };
    await expireAllOnMcp(mcp.port);
    await expireOnAs(as.port);

    await fetch(`http://127.0.0.1:${as.port}/_control/delay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ms: 5000 }),
    });

    const child = spawn('node', [hostBin, 'call', 'sig-srv', 'echo', '-d', '{"text":"sig"}'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1', ...env },
    });

    await new Promise((r) => setTimeout(r, 500));
    child.kill('SIGINT');
    await new Promise((resolve) => child.on('exit', resolve));

    await fetch(`http://127.0.0.1:${as.port}/_control/delay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ms: 0 }),
    });

    const agentDir = join(tempDir, 'agent');
    const locks = readdirSync(agentDir).filter((f) => f.includes('.lock'));
    assert.equal(locks.length, 0, `no lock files should remain, found: ${locks.join(', ')}`);

    const result = runHost(['info', 'sig-srv'], { env });
    assert.ok(
      !result.stderr.includes('could not acquire lock'),
      `next command should not fail with lock timeout: ${result.stderr}`
    );
  });
});

describe('B5r2-4b: timeout releases lock', () => {
  let as;
  let mcp;
  let tempDir;

  before(async () => {
    as = await startServer('oauth-as.mjs');
    mcp = await startServer('server-oauth-protected.mjs', [as.issuer]);
    tempDir = join(tmpdir(), `mcpcat-b5r2-4b-${Date.now()}`);
    mkdirSync(join(tempDir, 'agent'), { recursive: true });
    writeMcpJson(join(tempDir, 'agent'), 'timeout-srv', `http://127.0.0.1:${mcp.port}/mcp`);
    await clearAsLog(as.port);
    await doLogin('timeout-srv', tempDir, as.port);
    const log = await asLog(as.port);
    const tok = log.find((e) => e.type === 'token_issued' && e.grant === 'authorization_code');
    await registerToken(mcp.port, tok.accessToken);
  });

  after(async () => {
    await fetch(`http://127.0.0.1:${as.port}/_control/delay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ms: 0 }),
    }).catch(() => {});
    as?.child.kill('SIGTERM');
    mcp?.child.kill('SIGTERM');
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('-m 1 timeout leaves no lock, next command succeeds', async () => {
    const env = { PI_CODING_AGENT_DIR: join(tempDir, 'agent'), HOME: tempDir };
    await expireAllOnMcp(mcp.port);
    await expireOnAs(as.port);

    await fetch(`http://127.0.0.1:${as.port}/_control/delay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ms: 5000 }),
    });

    const result = runHost(['call', 'timeout-srv', 'echo', '-d', '{"text":"t"}', '-m', '1'], {
      env,
    });

    await fetch(`http://127.0.0.1:${as.port}/_control/delay`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ms: 0 }),
    });

    const agentDir = join(tempDir, 'agent');
    const locks = readdirSync(agentDir).filter((f) => f.includes('.lock'));
    assert.equal(locks.length, 0, `no lock files should remain, found: ${locks.join(', ')}`);

    const result2 = runHost(['info', 'timeout-srv'], { env });
    assert.ok(
      !result2.stderr.includes('could not acquire lock'),
      `next command should not fail with lock timeout: ${result2.stderr}`
    );
  });
});
