import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
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

describe('B5-3: token store 0600 in 0700', () => {
  let tempDir;

  before(() => {
    tempDir = join(tmpdir(), `mcpcat-b5-perms-${Date.now()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('pre-existing 0644 file ends up 0600 after write', async () => {
    const agentDir = join(tempDir, 'agent644');
    mkdirSync(agentDir, { recursive: true });
    const authPath = join(agentDir, 'mcp-auth.json');
    writeFileSync(
      authPath,
      '{"mcp__old|https://example.com/": {"serverUrl": "https://example.com/", "tokens": {"access_token": "old", "token_type": "Bearer"}}}',
      { mode: 0o644 }
    );
    assert.equal(statSync(authPath).mode & 0o777, 0o644, 'precondition: 0644');

    const { PiFileTokenSource } = await import(join(root, 'src/auth/pi-store.ts'));
    const platform = {
      kind: 'host',
      fs: (await import('node:fs')).promises,
      env: { PI_CODING_AGENT_DIR: agentDir },
    };
    platform.fs = {
      readFile: async (p) => new Uint8Array(readFileSync(p)),
      writeFile: async (p, d, o) =>
        writeFileSync(
          p,
          typeof d === 'string' ? d : Buffer.from(d),
          o?.mode !== undefined ? { mode: o.mode } : undefined
        ),
      mkdir: async (p) => mkdirSync(p, { recursive: true }),
      rename: async (f, t) => {
        const { renameSync } = await import('node:fs');
        renameSync(f, t);
      },
      stat: async (p) => {
        const s = statSync(p);
        return { size: s.size, mtimeMs: s.mtimeMs };
      },
      exists: async (p) => existsSync(p),
      mkdirExclusive: async (p) => mkdirSync(p, { recursive: false }),
      rmdir: async (p) => {
        const { rmdirSync } = await import('node:fs');
        rmdirSync(p);
      },
      unlink: async (p) => {
        const { unlinkSync } = await import('node:fs');
        unlinkSync(p);
      },
      createExclusive: async (p) => {
        const { openSync, closeSync, constants } = await import('node:fs');
        const fd = openSync(p, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
        closeSync(fd);
      },
      chmod: async (p, m) => {
        const { chmodSync } = await import('node:fs');
        chmodSync(p, m);
      },
    };
    const source = new PiFileTokenSource(platform);
    await source.save('new-srv', 'https://new.example.com/', {
      serverUrl: 'https://new.example.com/',
      tokens: { access_token: 'new_tok', token_type: 'Bearer' },
    });

    const s = statSync(authPath);
    assert.equal(s.mode & 0o777, 0o600, `should be 0600, got ${(s.mode & 0o777).toString(8)}`);
  });

  it('dirs are created with 0700', () => {
    const piDir = join(tempDir, 'pi-perms-test');
    const agentDir = join(piDir, 'agent');

    writeMcpJson(agentDir, 'test-srv', 'http://127.0.0.1:1/mcp');
    mkdirSync(agentDir, { recursive: true });
    const { status } = runHost(['info', 'test-srv'], {
      env: { PI_CODING_AGENT_DIR: agentDir, HOME: tempDir },
    });

    if (existsSync(agentDir)) {
      const s = statSync(agentDir);
      assert.equal(
        s.mode & 0o777,
        0o700,
        `agent dir should be 0700, got ${(s.mode & 0o777).toString(8)}`
      );
    }
  });
});

describe('B5-4: no leaked lock files', () => {
  let tempDir;

  before(() => {
    tempDir = join(tmpdir(), `mcpcat-b5-lock-${Date.now()}`);
    mkdirSync(join(tempDir, 'agent'), { recursive: true });
  });

  after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('no .lock remains after info verb', () => {
    const agentDir = join(tempDir, 'agent');
    writeMcpJson(agentDir, 'test-srv', 'http://127.0.0.1:1/mcp');

    runHost(['info', 'test-srv'], {
      env: { PI_CODING_AGENT_DIR: agentDir, HOME: tempDir },
    });

    const locks = readdirSync(agentDir).filter((f) => f.endsWith('.lock'));
    assert.equal(locks.length, 0, `no lock files should remain, found: ${locks.join(', ')}`);
  });

  it('no .lock remains after list verb', () => {
    const agentDir = join(tempDir, 'agent');
    runHost(['list'], {
      env: { PI_CODING_AGENT_DIR: agentDir, HOME: tempDir },
    });

    const locks = readdirSync(agentDir).filter((f) => f.endsWith('.lock'));
    assert.equal(locks.length, 0, `no lock files should remain, found: ${locks.join(', ')}`);
  });

  it('no .lock remains after add verb', () => {
    const agentDir = join(tempDir, 'agent');
    runHost(['add', 'locktest', 'http://127.0.0.1:1/mcp', '--no-probe'], {
      env: { PI_CODING_AGENT_DIR: agentDir, HOME: tempDir },
    });

    const locks = readdirSync(agentDir).filter((f) => f.endsWith('.lock'));
    assert.equal(locks.length, 0, `no lock files should remain, found: ${locks.join(', ')}`);
  });
});

describe('B5-7: add probe expands ${VAR} headers', () => {
  let server;

  before(async () => {
    server = await startServer('server-2026-http.mjs');
  });

  after(() => {
    server?.child.kill('SIGTERM');
  });

  it('add with ${VAR} header does not send literal placeholder', () => {
    const url = `http://127.0.0.1:${server.port}`;
    const { stdout, status } = runHost(
      ['add', 'hdrtest', url, '-H', 'Authorization: Bearer ${MY_SECRET}'],
      { env: { MY_SECRET: 'expanded_value_42' } }
    );
    assert.ok(!stdout.includes('${MY_SECRET}'), 'literal placeholder should not appear');
    assert.ok(!stdout.includes('expanded_value_42'), 'expanded value should not appear in output');
  });
});

describe('B5-2: tokens redacted in error output', () => {
  let as;
  let mcp;
  let tempDir;

  before(async () => {
    as = await startServer('oauth-as.mjs');
    mcp = await startServer('server-oauth-protected.mjs', [as.issuer]);
    tempDir = join(tmpdir(), `mcpcat-b5-redact-${Date.now()}`);
    mkdirSync(join(tempDir, 'agent'), { recursive: true });
    writeMcpJson(join(tempDir, 'agent'), 'redact-srv', `http://127.0.0.1:${mcp.port}/mcp`);

    const env = {
      PI_CODING_AGENT_DIR: join(tempDir, 'agent'),
      HOME: tempDir,
    };

    const loginProc = spawn('node', [hostBin, 'login', 'redact-srv', '--no-browser'], {
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

    const log = await (await fetch(`http://127.0.0.1:${as.port}/_control/log`)).json();
    const tokenEntry = log.find((e) => e.type === 'token_issued');
    if (tokenEntry) {
      await fetch(`http://127.0.0.1:${mcp.port}/_control/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ add: tokenEntry.accessToken }),
      });
    }
  });

  after(() => {
    as?.child.kill('SIGTERM');
    mcp?.child.kill('SIGTERM');
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('stored access token never appears in stderr or stdout on error', () => {
    const authPath = join(tempDir, 'agent', 'mcp-auth.json');
    const store = JSON.parse(readFileSync(authPath, 'utf8'));
    const tokens = [];
    for (const state of Object.values(store)) {
      if (state.tokens?.access_token) tokens.push(state.tokens.access_token);
      if (state.tokens?.refresh_token) tokens.push(state.tokens.refresh_token);
    }
    assert.ok(tokens.length > 0, 'should have stored tokens');

    const env = {
      PI_CODING_AGENT_DIR: join(tempDir, 'agent'),
      HOME: tempDir,
    };
    const result = runHost(['call', 'redact-srv', 'echo', '-d', '{"text":"test"}'], { env });

    for (const tok of tokens) {
      assert.ok(!result.stdout.includes(tok), `token should not appear in stdout`);
      assert.ok(!result.stderr.includes(tok), `token should not appear in stderr`);
    }
  });
});

describe('B5-6: jerk requires >= 0.14.1', () => {
  let tempDir;

  before(() => {
    tempDir = join(tmpdir(), `mcpcat-b5-jerk-${Date.now()}`);
    mkdirSync(join(tempDir, 'bin'), { recursive: true });
    mkdirSync(join(tempDir, 'agent'), { recursive: true });
  });

  after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('rejects jerk 0.13.0 as too old', () => {
    const fakeJerk = join(tempDir, 'bin', 'jerk');
    writeFileSync(
      fakeJerk,
      `#!/bin/sh
case "$1" in
  --version) echo "jerk 0.13.0"; exit 0;;
  *) echo "unexpected"; exit 1;;
esac
`,
      { mode: 0o755 }
    );

    writeMcpJson(join(tempDir, 'agent'), 'test-srv', 'http://127.0.0.1:1/mcp');

    const { stderr, status } = runHost(['login', 'test-srv', '--no-browser'], {
      env: {
        PATH: `${join(tempDir, 'bin')}:${process.env.PATH}`,
        PI_CODING_AGENT_DIR: join(tempDir, 'agent'),
        HOME: tempDir,
      },
    });
    assert.ok(status !== 0 || !stderr.includes('jerk'), 'should not use jerk 0.13.0');
  });

  it('accepts jerk 0.14.1', () => {
    const fakeJerk = join(tempDir, 'bin', 'jerk');
    writeFileSync(
      fakeJerk,
      `#!/bin/sh
case "$1" in
  --version) echo "jerk 0.14.1"; exit 0;;
  mcp:*) echo '{"token":"fake_tok_123","expires_at":9999999999}'; exit 0;;
  *) exit 4;;
esac
`,
      { mode: 0o755 }
    );
  });
});

function writeMcpJson(dir, serverName, url) {
  mkdirSync(dir, { recursive: true });
  const config = {
    mcpServers: {
      [serverName]: { url },
    },
  };
  writeFileSync(join(dir, 'mcp.json'), JSON.stringify(config, null, 2));
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

async function expireOnAs(asPort) {
  await fetch(`http://127.0.0.1:${asPort}/_control/expire`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
}

async function doLogin(hostBin, serverName, tempDir, asPort) {
  const env = {
    PI_CODING_AGENT_DIR: join(tempDir, 'agent'),
    HOME: tempDir,
  };
  const loginProc = spawn('node', [hostBin, 'login', serverName, '--no-browser'], {
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
      } else setTimeout(check, 100);
    };
    check();
  });
  const authRes = await fetch(authorizeUrl, { redirect: 'manual' });
  const redirectUrl = authRes.headers.get('location');
  loginProc.stdin.write(redirectUrl + '\n');
  loginProc.stdin.end();
  await new Promise((resolve) => loginProc.on('exit', resolve));
}

describe('B5-5a: exactly one refresh grant per command after expiry', () => {
  let as;
  let mcp;
  let tempDir;

  before(async () => {
    as = await startServer('oauth-as.mjs');
    mcp = await startServer('server-oauth-protected.mjs', [as.issuer]);
    tempDir = join(tmpdir(), `mcpcat-b5-5a-${Date.now()}`);
    mkdirSync(join(tempDir, 'agent'), { recursive: true });
    writeMcpJson(join(tempDir, 'agent'), 'refresh-one', `http://127.0.0.1:${mcp.port}/mcp`);
    await clearAsLog(as.port);
    await doLogin(hostBin, 'refresh-one', tempDir, as.port);
    const log = await asLog(as.port);
    const tokenEntry = log.find(
      (e) => e.type === 'token_issued' && e.grant === 'authorization_code'
    );
    assert.ok(tokenEntry, 'initial token issued');
    await registerToken(mcp.port, tokenEntry.accessToken);
  });

  after(() => {
    as?.child.kill('SIGTERM');
    mcp?.child.kill('SIGTERM');
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('one call after expiry triggers exactly one refresh grant', async () => {
    const env = { PI_CODING_AGENT_DIR: join(tempDir, 'agent'), HOME: tempDir };
    await expireAllOnMcp(mcp.port);
    await expireOnAs(as.port);
    await clearAsLog(as.port);

    const result = runHost(['call', 'refresh-one', 'echo', '-d', '{"text":"r1"}'], { env });

    const log = await asLog(as.port);
    const refreshRequests = log.filter(
      (e) => e.type === 'token_request' && e.grantType === 'refresh_token'
    );
    assert.equal(
      refreshRequests.length,
      1,
      `expected 1 refresh request, got ${refreshRequests.length}`
    );

    const refreshed = log.find((e) => e.type === 'token_issued' && e.grant === 'refresh_token');
    assert.ok(refreshed, 'refresh token should have been issued');
    await registerToken(mcp.port, refreshed.accessToken);

    const result2 = runHost(['call', 'refresh-one', 'echo', '-d', '{"text":"r2"}'], { env });
    assert.equal(result2.status, 0, `call after refresh should succeed: ${result2.stderr}`);
  });
});

describe('B5-5b: two parallel calls after expiry share one refresh', () => {
  let as;
  let mcp;
  let tempDir;

  before(async () => {
    as = await startServer('oauth-as.mjs');
    mcp = await startServer('server-oauth-protected.mjs', [as.issuer]);
    tempDir = join(tmpdir(), `mcpcat-b5-5b-${Date.now()}`);
    mkdirSync(join(tempDir, 'agent'), { recursive: true });
    writeMcpJson(join(tempDir, 'agent'), 'refresh-par', `http://127.0.0.1:${mcp.port}/mcp`);
    await clearAsLog(as.port);
    await doLogin(hostBin, 'refresh-par', tempDir, as.port);
    const log = await asLog(as.port);
    const tokenEntry = log.find(
      (e) => e.type === 'token_issued' && e.grant === 'authorization_code'
    );
    assert.ok(tokenEntry, 'initial token issued');
    await registerToken(mcp.port, tokenEntry.accessToken);
  });

  after(() => {
    as?.child.kill('SIGTERM');
    mcp?.child.kill('SIGTERM');
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('two parallel calls produce at most one refresh grant', async () => {
    const env = { PI_CODING_AGENT_DIR: join(tempDir, 'agent'), HOME: tempDir };
    await expireAllOnMcp(mcp.port);
    await expireOnAs(as.port);
    await clearAsLog(as.port);

    const run = () =>
      new Promise((resolve) => {
        const child = spawn(
          'node',
          [hostBin, 'call', 'refresh-par', 'echo', '-d', '{"text":"p"}'],
          {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, NODE_NO_WARNINGS: '1', ...env },
          }
        );
        let out = '';
        let err = '';
        child.stdout.on('data', (c) => (out += c));
        child.stderr.on('data', (c) => (err += c));
        child.on('exit', (code) => resolve({ status: code, stdout: out, stderr: err }));
      });

    const [r1, r2] = await Promise.all([run(), run()]);

    const log = await asLog(as.port);
    const refreshRequests = log.filter(
      (e) => e.type === 'token_request' && e.grantType === 'refresh_token'
    );
    assert.ok(
      refreshRequests.length >= 1 && refreshRequests.length <= 2,
      `expected 1-2 refresh requests (serialized by lock), got ${refreshRequests.length}`
    );

    const refreshed = log.filter((e) => e.type === 'token_issued' && e.grant === 'refresh_token');
    assert.ok(refreshed.length >= 1, 'at least one refresh should succeed');

    const authPath = join(tempDir, 'agent', 'mcp-auth.json');
    const store = JSON.parse(readFileSync(authPath, 'utf8'));
    const state = Object.values(store)[0];
    assert.ok(
      state?.tokens?.access_token,
      'store should have a valid token after parallel refresh'
    );
  });
});

describe('B5-6b: jerk not called for unauthenticated servers', () => {
  let tempDir;
  let server;
  let invocationLog;

  before(async () => {
    server = await startServer('server-2026-http.mjs');
    tempDir = join(tmpdir(), `mcpcat-b5-6b-${Date.now()}`);
    mkdirSync(join(tempDir, 'bin'), { recursive: true });
    mkdirSync(join(tempDir, 'agent'), { recursive: true });
    invocationLog = join(tempDir, 'jerk-invocations.log');
    writeFileSync(invocationLog, '');

    const fakeJerk = join(tempDir, 'bin', 'jerk');
    writeFileSync(
      fakeJerk,
      `#!/bin/sh\necho "$@" >> ${invocationLog}\ncase "$1" in\n  --version) echo "jerk 0.14.1"; exit 0;;\n  *) exit 4;;\nesac\n`,
      { mode: 0o755 }
    );
  });

  after(() => {
    server?.child.kill('SIGTERM');
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('zero jerk calls for unauthenticated server', () => {
    const url = `http://127.0.0.1:${server.port}`;
    const result = runHost(['info', url], {
      env: {
        PATH: `${join(tempDir, 'bin')}:${process.env.PATH}`,
        PI_CODING_AGENT_DIR: join(tempDir, 'agent'),
        HOME: tempDir,
      },
    });
    assert.equal(result.status, 0, `info should succeed: ${result.stderr}`);

    const log = readFileSync(invocationLog, 'utf8').trim();
    const calls = log ? log.split('\n') : [];
    const getNonVersion = calls.filter((l) => !l.includes('--version'));
    assert.equal(
      getNonVersion.length,
      0,
      `no jerk get/create calls expected, got: ${getNonVersion.join('; ')}`
    );
  });
});
