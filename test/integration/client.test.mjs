import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { mcpcatArgs } from './helpers/bin.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const fixturesDir = join(root, 'test/integration/fixtures');

let homeCounter = 0;
function createTestHome() {
  const dir = join(tmpdir(), `mcpcat-client-test-${process.pid}-${Date.now()}-${homeCounter++}`);
  mkdirSync(join(dir, '.pi', 'agent'), { recursive: true });
  return dir;
}

function runHost(args, opts = {}) {
  const home = opts.home;
  const { cmd, args: cmdArgs } = mcpcatArgs(args);
  try {
    const result = execFileSync(cmd, cmdArgs, {
      encoding: 'utf8',
      timeout: 15_000,
      env: {
        ...process.env,
        NODE_NO_WARNINGS: '1',
        HOME: home,
        PI_CODING_AGENT_DIR: join(home, '.pi', 'agent'),
        ...opts.env,
        ...(opts.env?.HOME ? { PI_CODING_AGENT_DIR: '' } : {}),
      },
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
  let testHome;

  before(async () => {
    testHome = createTestHome();
    server = await startFixtureServer('server-2026-http.mjs');
  });

  after(() => {
    server?.child.kill('SIGTERM');
    rmSync(testHome, { recursive: true, force: true });
  });

  it('info shows server details', () => {
    const url = `http://127.0.0.1:${server.port}`;
    const { stdout, status } = runHost(['info', url], { home: testHome });
    assert.equal(status, 0);
    assert.ok(stdout.includes('test-2026'));
    assert.ok(stdout.includes('2026-07-28'));
  });

  it('tools lists tools', () => {
    const url = `http://127.0.0.1:${server.port}`;
    const { stdout, status } = runHost(['tools', url], { home: testHome });
    assert.equal(status, 0);
    assert.ok(stdout.includes('echo'));
    assert.ok(stdout.includes('add'));
  });

  it('call invokes a tool', () => {
    const url = `http://127.0.0.1:${server.port}`;
    const { stdout, status } = runHost(['call', url, 'echo', '-d', '{"message":"hello world"}'], {
      home: testHome,
    });
    assert.equal(status, 0);
    assert.ok(stdout.includes('hello world'));
  });

  it('call with add tool', () => {
    const url = `http://127.0.0.1:${server.port}`;
    const { stdout, status } = runHost(['call', url, 'add', '-d', '{"a":3,"b":4}'], {
      home: testHome,
    });
    assert.equal(status, 0);
    assert.ok(stdout.includes('7'));
  });

  it('call with isError returns exit 1', () => {
    const url = `http://127.0.0.1:${server.port}`;
    const { stderr, status } = runHost(['call', url, 'fail', '-d', '{}'], { home: testHome });
    assert.equal(status, 1);
    assert.ok(stderr.includes('something went wrong'));
  });

  it('describe shows tool schema', () => {
    const url = `http://127.0.0.1:${server.port}`;
    const { stdout, status } = runHost(['describe', url, 'echo'], { home: testHome });
    assert.equal(status, 0);
    assert.ok(stdout.includes('echo'));
    assert.ok(stdout.includes('message'));
  });

  it('describe --schema prints raw JSON Schema', () => {
    const url = `http://127.0.0.1:${server.port}`;
    const { stdout, status } = runHost(['describe', '--schema', url, 'echo'], { home: testHome });
    assert.equal(status, 0);
    const schema = JSON.parse(stdout);
    assert.equal(schema.type, 'object');
    assert.ok(schema.properties.message);
  });

  it('describe unknown tool exits 2', () => {
    const url = `http://127.0.0.1:${server.port}`;
    const { stderr, status } = runHost(['describe', url, 'nonexistent'], { home: testHome });
    assert.equal(status, 2);
    assert.ok(stderr.includes('not found'));
  });

  it('curl form: target alone is info', () => {
    const url = `http://127.0.0.1:${server.port}`;
    const { stdout, status } = runHost([url], { home: testHome });
    assert.equal(status, 0);
    assert.ok(stdout.includes('test-2026'));
  });

  it('curl form: target + tool is call', () => {
    const url = `http://127.0.0.1:${server.port}`;
    const { stdout, status } = runHost([url, 'echo', '-d', '{"message":"curl form"}'], {
      home: testHome,
    });
    assert.equal(status, 0);
    assert.ok(stdout.includes('curl form'));
  });

  it('ls is an alias for tools', () => {
    const url = `http://127.0.0.1:${server.port}`;
    const { stdout, status } = runHost(['ls', url], { home: testHome });
    assert.equal(status, 0);
    assert.ok(stdout.includes('echo'));
  });
});

describe('client: 2025-11-25 HTTP (JSON)', () => {
  let server;
  let testHome;

  before(async () => {
    testHome = createTestHome();
    server = await startFixtureServer('server-legacy-http.mjs');
  });

  after(() => {
    server?.child.kill('SIGTERM');
    rmSync(testHome, { recursive: true, force: true });
  });

  it('info shows server details via fallback', () => {
    const url = `http://127.0.0.1:${server.port}`;
    const { stdout, status } = runHost(['info', url], { home: testHome });
    assert.equal(status, 0);
    assert.ok(stdout.includes('test-legacy'));
    assert.ok(stdout.includes('2025-11-25'));
  });

  it('tools lists tools', () => {
    const url = `http://127.0.0.1:${server.port}`;
    const { stdout, status } = runHost(['tools', url], { home: testHome });
    assert.equal(status, 0);
    assert.ok(stdout.includes('echo'));
    assert.ok(stdout.includes('add'));
  });

  it('call invokes a tool', () => {
    const url = `http://127.0.0.1:${server.port}`;
    const { stdout, status } = runHost(['call', url, 'echo', '-d', '{"message":"legacy hello"}'], {
      home: testHome,
    });
    assert.equal(status, 0);
    assert.ok(stdout.includes('legacy hello'));
  });
});

describe('client: 2025-11-25 HTTP (SSE)', () => {
  let server;
  let testHome;

  before(async () => {
    testHome = createTestHome();
    server = await startFixtureServer('server-legacy-http.mjs', ['--sse']);
  });

  after(() => {
    server?.child.kill('SIGTERM');
    rmSync(testHome, { recursive: true, force: true });
  });

  it('info works over SSE', () => {
    const url = `http://127.0.0.1:${server.port}`;
    const { stdout, status } = runHost(['info', url], { home: testHome });
    assert.equal(status, 0);
    assert.ok(stdout.includes('test-legacy'));
  });

  it('call works over SSE', () => {
    const url = `http://127.0.0.1:${server.port}`;
    const { stdout, status } = runHost(['call', url, 'echo', '-d', '{"message":"sse hello"}'], {
      home: testHome,
    });
    assert.equal(status, 0);
    assert.ok(stdout.includes('sse hello'));
  });
});

describe('client: stdio', () => {
  let testHome;

  before(() => {
    testHome = createTestHome();
  });

  after(() => {
    rmSync(testHome, { recursive: true, force: true });
  });

  it('info via stdio: prefix', () => {
    const script = join(fixturesDir, 'server-stdio-legacy.mjs');
    const { stdout, status } = runHost(['info', `stdio:node ${script}`], { home: testHome });
    assert.equal(status, 0);
    assert.ok(stdout.includes('test-stdio-legacy'));
  });

  it('tools via trailing --', () => {
    const script = join(fixturesDir, 'server-stdio-legacy.mjs');
    const { stdout, status } = runHost(['tools', '--', 'node', script], { home: testHome });
    assert.equal(status, 0);
    assert.ok(stdout.includes('echo'));
  });

  it('call via stdio: prefix', () => {
    const script = join(fixturesDir, 'server-stdio-legacy.mjs');
    const { stdout, status } = runHost(
      ['call', `stdio:node ${script}`, 'echo', '-d', '{"message":"stdio test"}'],
      { home: testHome }
    );
    assert.equal(status, 0);
    assert.ok(stdout.includes('stdio test'));
  });
});

describe('client: version selection', () => {
  let server2026;
  let serverLegacy;
  let testHome;

  before(async () => {
    testHome = createTestHome();
    server2026 = await startFixtureServer('server-2026-http.mjs');
    serverLegacy = await startFixtureServer('server-legacy-http.mjs');
  });

  after(() => {
    server2026?.child.kill('SIGTERM');
    serverLegacy?.child.kill('SIGTERM');
    rmSync(testHome, { recursive: true, force: true });
  });

  it('auto-selects 2026-07-28 for modern server', () => {
    const url = `http://127.0.0.1:${server2026.port}`;
    const { stdout, status } = runHost(['info', url], { home: testHome });
    assert.equal(status, 0);
    assert.ok(stdout.includes('2026-07-28'));
  });

  it('falls back to legacy for legacy server', () => {
    const url = `http://127.0.0.1:${serverLegacy.port}`;
    const { stdout, status } = runHost(['info', url], { home: testHome });
    assert.equal(status, 0);
    assert.ok(stdout.includes('2025-11-25'));
  });
});

describe('client: configured names', () => {
  let server;
  let configDir;

  before(async () => {
    server = await startFixtureServer('server-2026-http.mjs');
    configDir = createTestHome();
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
      home: configDir,
      env: { HOME: configDir },
    });
    assert.equal(status, 0);
    assert.ok(stdout.includes('test-2026'));
  });

  it('resolves name with dash/underscore normalization', () => {
    const { stdout, status } = runHost(['info', 'test_server'], {
      home: configDir,
      env: { HOME: configDir },
    });
    assert.equal(status, 0);
    assert.ok(stdout.includes('test-2026'));
  });
});

describe('client: error handling', () => {
  let testHome;

  before(() => {
    testHome = createTestHome();
  });

  after(() => {
    rmSync(testHome, { recursive: true, force: true });
  });

  it('connection failure exits 3', () => {
    const { stderr, status } = runHost(['info', 'http://127.0.0.1:1'], { home: testHome });
    assert.equal(status, 3);
    assert.ok(stderr.includes('connection failed'));
  });

  it('missing target exits 2', () => {
    const { stderr, status } = runHost(['info'], { home: testHome });
    assert.equal(status, 2);
    assert.ok(stderr.includes('requires a target'));
  });

  it('call without tool name exits 2', () => {
    const { stderr, status } = runHost(['call', 'http://127.0.0.1:1'], { home: testHome });
    assert.equal(status, 2);
    assert.ok(stderr.includes('requires a tool name'));
  });
});

describe('client: input_required (resultType)', () => {
  let server;
  let testHome;

  before(async () => {
    testHome = createTestHome();
    server = await startFixtureServer('server-2026-http.mjs');
  });

  after(() => {
    server?.child.kill('SIGTERM');
    rmSync(testHome, { recursive: true, force: true });
  });

  it('exits 6 when tool returns input_required', () => {
    const url = `http://127.0.0.1:${server.port}`;
    const { stderr, status } = runHost(['call', url, 'needs-input', '-d', '{}'], {
      home: testHome,
    });
    assert.equal(status, 6);
    const parsed = JSON.parse(stderr.trim());
    assert.equal(parsed.name, 'needs-input');
  });
});

describe('client: lifecycle (D4)', () => {
  let testHome;

  before(() => {
    testHome = createTestHome();
  });

  after(() => {
    rmSync(testHome, { recursive: true, force: true });
  });

  it('stateful HTTP session is DELETEd on close', async () => {
    const server = await startFixtureServer('server-legacy-http.mjs');
    try {
      const url = `http://127.0.0.1:${server.port}`;
      runHost(['info', url], { home: testHome });
      await sleep(200);
      const res = await fetch(`http://127.0.0.1:${server.port}/_test/deletes`);
      const deletes = await res.json();
      assert.ok(deletes.length > 0, `expected at least one DELETE, got ${JSON.stringify(deletes)}`);
      assert.ok(deletes[0].startsWith('session-'), `expected session id, got ${deletes[0]}`);
    } finally {
      server.child.kill('SIGTERM');
    }
  });

  it('stdio server process group is gone after command', async () => {
    const pidFile = join(tmpdir(), `mcpcat-gc-test-${process.pid}-${Date.now()}.pid`);
    const script = join(fixturesDir, 'server-stdio-grandchild.mjs');
    try {
      const { status } = runHost(
        ['call', `stdio:node ${script} ${pidFile}`, 'echo', '-d', '{"message":"gc test"}'],
        { home: testHome }
      );
      assert.equal(status, 0);
      assert.ok(existsSync(pidFile), 'pid file should have been written');
      const pids = readFileSync(pidFile, 'utf8').trim().split('\n').map(Number);
      const serverPid = pids[0];
      const grandchildPid = pids[1];
      await sleep(500);
      assert.ok(!isAlive(serverPid), `server pid ${serverPid} should be dead`);
      assert.ok(!isAlive(grandchildPid), `grandchild pid ${grandchildPid} should be dead`);
    } finally {
      rmSync(pidFile, { force: true });
    }
  });
});

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('client: parallel calls sharing one HOME', () => {
  let server;
  let testHome;

  before(async () => {
    testHome = createTestHome();
    server = await startFixtureServer('server-legacy-http.mjs');
  });

  after(() => {
    server?.child.kill('SIGTERM');
    rmSync(testHome, { recursive: true, force: true });
  });

  function spawnCall(i) {
    const { cmd, args } = mcpcatArgs([
      'call',
      `http://127.0.0.1:${server.port}`,
      'echo',
      '-d',
      JSON.stringify({ message: `parallel-${i}` }),
    ]);
    return new Promise((resolve) => {
      const child = spawn(cmd, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NODE_NO_WARNINGS: '1',
          HOME: testHome,
          PI_CODING_AGENT_DIR: join(testHome, '.pi', 'agent'),
        },
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (c) => (out += c));
      child.stderr.on('data', (c) => (err += c));
      child.on('exit', (code) => resolve({ i, status: code, stdout: out, stderr: err }));
    });
  }

  it('10 parallel calls all succeed with no leftover locks', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => spawnCall(i)));
    for (const r of results) {
      assert.equal(r.status, 0, `call #${r.i} failed (exit ${r.status}): ${r.stderr.trim()}`);
      assert.ok(r.stdout.includes(`parallel-${r.i}`), `call #${r.i} missing expected output`);
    }
    const agentDir = join(testHome, '.pi', 'agent');
    const locks = readdirSync(agentDir).filter((f) => f.endsWith('.lock'));
    assert.equal(locks.length, 0, `leftover locks: ${locks.join(', ')}`);
  });
});

describe('client: parallel calls with auth refresh contention', () => {
  let as;
  let mcp;
  let testHome;

  before(async () => {
    testHome = createTestHome();
    as = await startFixtureServer('oauth-as.mjs');
    mcp = await startFixtureServer('server-oauth-accept-any.mjs', [as.issuer]);
    const agentDir = join(testHome, '.pi', 'agent');
    const config = {
      mcpServers: {
        'par-refresh': { url: `http://127.0.0.1:${mcp.port}/mcp` },
      },
    };
    writeFileSync(join(agentDir, 'mcp.json'), JSON.stringify(config, null, 2));
    await clearAsLog(as.port);
    await doLogin('par-refresh', testHome, as.port);
    const log = await asLog(as.port);
    const tokenEntry = log.find(
      (e) => e.type === 'token_issued' && e.grant === 'authorization_code'
    );
    assert.ok(tokenEntry, 'initial login must issue a token');
    await registerToken(mcp.port, tokenEntry.accessToken);
    await fetch(`http://127.0.0.1:${mcp.port}/_control/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ acceptAny: true }),
    });
  });

  after(() => {
    as?.child.kill('SIGTERM');
    mcp?.child.kill('SIGTERM');
    rmSync(testHome, { recursive: true, force: true });
  });

  async function asLog(port) {
    const res = await fetch(`http://127.0.0.1:${port}/_control/log`);
    return res.json();
  }

  async function clearAsLog(port) {
    await fetch(`http://127.0.0.1:${port}/_control/log`, { method: 'DELETE' });
  }

  async function registerToken(port, token) {
    await fetch(`http://127.0.0.1:${port}/_control/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ add: token }),
    });
  }

  async function doLogin(serverName, tempDir, asPort) {
    const env = {
      PI_CODING_AGENT_DIR: join(tempDir, '.pi', 'agent'),
      HOME: tempDir,
    };
    const { cmd, args } = mcpcatArgs(['login', serverName, '--no-browser']);
    const loginProc = spawn(cmd, args, {
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

  function spawnCall(i) {
    const { cmd, args } = mcpcatArgs([
      'call',
      'par-refresh',
      'echo',
      '-d',
      JSON.stringify({ text: `refresh-${i}` }),
    ]);
    return new Promise((resolve) => {
      const child = spawn(cmd, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NODE_NO_WARNINGS: '1',
          HOME: testHome,
          PI_CODING_AGENT_DIR: join(testHome, '.pi', 'agent'),
        },
      });
      let out = '';
      let err = '';
      child.stdout.on('data', (c) => (out += c));
      child.stderr.on('data', (c) => (err += c));
      child.on('exit', (code) => resolve({ i, status: code, stdout: out, stderr: err }));
    });
  }

  it('10 parallel calls with stored valid token all succeed', async () => {
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => spawnCall(i)));
    for (const r of results) {
      assert.equal(r.status, 0, `call #${r.i} failed (exit ${r.status}): ${r.stderr.trim()}`);
    }
    const agentDir = join(testHome, '.pi', 'agent');
    const locks = readdirSync(agentDir).filter((f) => f.endsWith('.lock'));
    assert.equal(locks.length, 0, `leftover locks: ${locks.join(', ')}`);
  });

  it('10 parallel calls after token expiry all succeed via refresh', async () => {
    const agentDir = join(testHome, '.pi', 'agent');
    const authPath = join(agentDir, 'mcp-auth.json');
    const store = JSON.parse(readFileSync(authPath, 'utf8'));
    for (const key of Object.keys(store)) {
      store[key].tokensExpireAt = Date.now() - 60_000;
    }
    writeFileSync(authPath, JSON.stringify(store, null, 2));
    await clearAsLog(as.port);

    const results = await Promise.all(Array.from({ length: 10 }, (_, i) => spawnCall(i)));
    for (const r of results) {
      assert.equal(r.status, 0, `call #${r.i} failed (exit ${r.status}): ${r.stderr.trim()}`);
    }

    const log = await asLog(as.port);
    const refreshes = log.filter((e) => e.type === 'token_issued' && e.grant === 'refresh_token');
    assert.ok(refreshes.length >= 1, 'at least one refresh should have occurred');

    const agentDir2 = join(testHome, '.pi', 'agent');
    const locks = readdirSync(agentDir2).filter((f) => f.endsWith('.lock'));
    assert.equal(locks.length, 0, `leftover locks: ${locks.join(', ')}`);

    const authPath2 = join(agentDir2, 'mcp-auth.json');
    const store2 = JSON.parse(readFileSync(authPath2, 'utf8'));
    const state = Object.values(store2)[0];
    assert.ok(
      state?.tokens?.access_token,
      'store should have a valid token after parallel refresh'
    );
  });
});
