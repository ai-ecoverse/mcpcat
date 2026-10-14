import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { mcpcatArgs } from './helpers/bin.mjs';
import { attachKernel, createNodeKernel } from './helpers/kernel.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const fixturesDir = join(root, 'test/integration/fixtures');
const legacyCli = join(fixturesDir, 'server-stdio-legacy-pidtrack.mjs');
const kernelBundle = join(root, 'dist/kernel/mcpcat.mjs');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const kernelPkg = JSON.parse(
  readFileSync(join(root, 'node_modules/@ai-ecoverse/slicc-kernel/package.json'), 'utf8')
);
const kernelVersion = kernelPkg.version.split('.').map(Number);
const hasPgid = kernelVersion[0] > 1 || (kernelVersion[0] === 1 && kernelVersion[1] >= 74);

const testHome = join(tmpdir(), `mcpcat-lifecycle-${Date.now()}`);
mkdirSync(join(testHome, '.pi', 'agent'), { recursive: true });
const testEnv = {
  HOME: testHome,
  PI_CODING_AGENT_DIR: join(testHome, '.pi', 'agent'),
};

function pidExists(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function parsePidFile(path) {
  if (!existsSync(path)) return { servers: [], grandchildren: [] };
  const lines = readFileSync(path, 'utf8').trim().split('\n');
  const servers = [];
  const grandchildren = [];
  for (const l of lines) {
    const [kind, pidStr] = l.split(':');
    const pid = Number(pidStr);
    if (kind === 'server') servers.push(pid);
    else if (kind === 'grandchild') grandchildren.push(pid);
  }
  return { servers, grandchildren };
}

function assertAllDead(pidFile, label) {
  const { servers, grandchildren } = parsePidFile(pidFile);
  assert.equal(servers.length, 1, `${label}: exactly one server should have been spawned`);
  for (const pid of [...servers, ...grandchildren]) {
    assert.ok(!pidExists(pid), `${label}: pid ${pid} is still alive`);
  }
}

const spawnedChildren = [];

after(() => {
  for (const c of spawnedChildren) {
    try {
      c.kill('SIGKILL');
    } catch {}
  }
  spawnedChildren.length = 0;
  rmSync(testHome, { recursive: true, force: true });
});

function spawnMcpcat(args, extraEnv = {}) {
  const { cmd, args: cmdArgs } = mcpcatArgs(args);
  const child = spawn(cmd, cmdArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NODE_NO_WARNINGS: '1', ...testEnv, ...extraEnv },
  });
  spawnedChildren.push(child);
  return child;
}

function waitExit(child) {
  return new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
}

function freshPidFile() {
  const p = join(testHome, `pids-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  try {
    unlinkSync(p);
  } catch {}
  return p;
}

describe('lifecycle: host stdio client', { timeout: 30_000 }, () => {
  it('normal exit: all pids dead, exactly one server', async () => {
    const pidFile = freshPidFile();
    const child = spawnMcpcat(
      ['call', `stdio:node ${legacyCli}`, 'echo', '-d', '{"message":"hi"}'],
      { PID_RECORD_FILE: pidFile }
    );
    const { code } = await waitExit(child);
    assert.equal(code, 0);
    await sleep(500);
    assertAllDead(pidFile, 'normal exit');
  });

  it('-m 1 timeout: all pids dead, exactly one server', async () => {
    const pidFile = freshPidFile();
    const child = spawnMcpcat(
      ['-m', '1', 'call', `stdio:node ${legacyCli}`, 'echo', '-d', '{"message":"hi"}'],
      { PID_RECORD_FILE: pidFile }
    );
    const { code } = await waitExit(child);
    assert.equal(code, 0);
    await sleep(500);
    assertAllDead(pidFile, 'timeout exit');
  });

  it('SIGTERM: all pids dead, exactly one server', async () => {
    const pidFile = freshPidFile();
    const child = spawnMcpcat(
      ['call', `stdio:node ${legacyCli}`, 'echo', '-d', '{"message":"hi"}'],
      { PID_RECORD_FILE: pidFile }
    );
    const exitPromise = waitExit(child);
    await sleep(500);
    try {
      child.kill('SIGTERM');
    } catch {}
    await exitPromise;
    await sleep(500);
    assertAllDead(pidFile, 'SIGTERM');
  });

  it('SIGHUP: all pids dead, exactly one server', async () => {
    const pidFile = freshPidFile();
    const child = spawnMcpcat(
      ['call', `stdio:node ${legacyCli}`, 'echo', '-d', '{"message":"hi"}'],
      { PID_RECORD_FILE: pidFile }
    );
    const exitPromise = waitExit(child);
    await sleep(500);
    try {
      child.kill('SIGHUP');
    } catch {}
    await exitPromise;
    await sleep(500);
    assertAllDead(pidFile, 'SIGHUP');
  });

  it('SIGINT: all pids dead, exactly one server', async () => {
    const pidFile = freshPidFile();
    const child = spawnMcpcat(
      ['call', `stdio:node ${legacyCli}`, 'echo', '-d', '{"message":"hi"}'],
      { PID_RECORD_FILE: pidFile }
    );
    const exitPromise = waitExit(child);
    await sleep(500);
    try {
      child.kill('SIGINT');
    } catch {}
    await exitPromise;
    await sleep(500);
    assertAllDead(pidFile, 'SIGINT');
  });
});

function waitForListening(child) {
  return new Promise((resolve, reject) => {
    let data = '';
    child.stderr.on('data', (chunk) => {
      data += chunk.toString();
      const match = data.match(/listening on http:\/\/[^:]+:(\d+)\/mcp/);
      if (match) resolve(Number(match[1]));
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (!data.includes('listening')) reject(new Error(`serve exited ${code}: ${data}`));
    });
  });
}

describe('lifecycle: host serve --proxy stdio', { timeout: 30_000 }, () => {
  it('SIGTERM: proxy upstream pids dead, exactly one server', async () => {
    const pidFile = freshPidFile();
    const child = spawnMcpcat(
      ['serve', '--proxy', `stdio:node ${legacyCli}`, '--http', '0', '--no-auth'],
      { PID_RECORD_FILE: pidFile }
    );
    const port = await waitForListening(child);
    await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        connection: 'close',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {
          _meta: { protocolVersion: '2025-11-25', clientInfo: { name: 'test', version: '0' } },
        },
      }),
    }).catch(() => {});
    await sleep(500);
    child.kill('SIGTERM');
    await waitExit(child);
    await sleep(500);
    assertAllDead(pidFile, 'serve proxy SIGTERM');
  });

  it('SIGHUP: proxy upstream pids dead, exactly one server', async () => {
    const pidFile = freshPidFile();
    const child = spawnMcpcat(
      ['serve', '--proxy', `stdio:node ${legacyCli}`, '--http', '0', '--no-auth'],
      { PID_RECORD_FILE: pidFile }
    );
    const port = await waitForListening(child);
    await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        connection: 'close',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {
          _meta: {
            protocolVersion: '2025-11-25',
            clientInfo: { name: 'test', version: '0' },
          },
        },
      }),
    }).catch(() => {});
    await sleep(500);
    child.kill('SIGHUP');
    await waitExit(child);
    await sleep(500);
    assertAllDead(pidFile, 'serve proxy SIGHUP');
  });
});

describe('lifecycle: SIGHUP removes serve token file', { timeout: 15_000 }, () => {
  it('token file is gone after SIGHUP', async () => {
    const fixtureCli = join(fixturesDir, 'serve-cli.mjs');
    const child = spawnMcpcat(['serve', '--http', '0', `node=${fixtureCli}`]);
    let stderrBuf = '';
    child.stderr.on('data', (c) => {
      stderrBuf += c.toString();
    });
    const port = await waitForListening(child);
    const tokenMatch = stderrBuf.match(/bearer saved to (.+)/);
    assert.ok(tokenMatch, 'serve should print token file path');
    const tokenFile = tokenMatch[1].trim();
    assert.ok(existsSync(tokenFile), 'token file should exist before SIGHUP');
    child.kill('SIGHUP');
    await waitExit(child);
    await sleep(200);
    assert.ok(!existsSync(tokenFile), 'token file should be gone after SIGHUP');
  });
});

async function installMcpcat(kernel) {
  const bundleData = readFileSync(kernelBundle);
  const wasmData = readFileSync(join(root, 'dist/quickjs.wasm'));
  await kernel.writeFile('/node_modules/@ai-ecoverse/mcpcat/dist/kernel/mcpcat.mjs', bundleData);
  await kernel.writeFile('/node_modules/@ai-ecoverse/mcpcat/dist/quickjs.wasm', wasmData);
  await kernel.writeFile(
    '/node_modules/@ai-ecoverse/mcpcat/package.json',
    JSON.stringify({
      name: '@ai-ecoverse/mcpcat',
      version: pkg.version,
      type: 'module',
      slicc: { commands: { mcpcat: { abi: 'js', module: 'dist/kernel/mcpcat.mjs' } } },
    })
  );
}

async function installKernelFixture(kernel, name, pkgName, file) {
  const data = readFileSync(join(fixturesDir, file));
  await kernel.writeFile(`/node_modules/@ai-ecoverse/${pkgName}/dist/main.mjs`, data);
  await kernel.writeFile(
    `/node_modules/@ai-ecoverse/${pkgName}/package.json`,
    JSON.stringify({
      name: `@ai-ecoverse/${pkgName}`,
      version: '1.0.0',
      type: 'module',
      slicc: { commands: { [name]: { abi: 'js', module: 'dist/main.mjs' } } },
    })
  );
}

describe('lifecycle: kernel stdio client', {
  skip: !hasPgid && 'pgid requires slicc-kernel >= 1.74.0',
  timeout: 30_000,
}, () => {
  let kernel;
  let client;

  before(async () => {
    kernel = await createNodeKernel({});
    await installMcpcat(kernel);
    await installKernelFixture(
      kernel,
      'mcpcat-test-legacy',
      'mcpcat-test-legacy',
      'kernel-stdio-legacy-pidtrack.mjs'
    );
    await installKernelFixture(
      kernel,
      'mcpcat-test-sleeper',
      'mcpcat-test-sleeper',
      'kernel-sleeper.mjs'
    );
    const port = await kernel.connect();
    client = await attachKernel(port);
  });

  after(() => {
    client?.close();
    kernel?.terminate();
  });

  async function kernelPidCheck(pidFile, label) {
    const content = new TextDecoder().decode(await kernel.readFile(pidFile));
    const lines = content.trim().split('\n');
    const servers = [];
    const grandchildren = [];
    for (const l of lines) {
      const [kind, pidStr] = l.split(':');
      const pid = Number(pidStr);
      if (kind === 'server') servers.push(pid);
      else if (kind === 'grandchild') grandchildren.push(pid);
    }
    assert.equal(servers.length, 1, `${label}: exactly one server`);
    const ps = await client.ps();
    const alivePids = new Set(ps.map((p) => p.pid));
    for (const pid of [...servers, ...grandchildren]) {
      assert.ok(!alivePids.has(pid), `${label}: pid ${pid} still alive`);
    }
  }

  it('normal exit: all pids dead, exactly one server', async () => {
    const pidFile = '/tmp/kpids-normal.txt';
    const { status, stderr } = await kernel.run(
      ['mcpcat', 'call', 'stdio:mcpcat-test-legacy', 'echo', '-d', '{"message":"hi"}'],
      { stdout: 'pipe', stderr: 'pipe', env: { PID_RECORD_FILE: pidFile } }
    );
    assert.equal(status, 0, `stderr: ${stderr}`);
    await sleep(500);
    await kernelPidCheck(pidFile, 'kernel normal exit');
  });

  it('SIGTERM: all pids dead, exactly one server', async () => {
    const pidFile = '/tmp/kpids-sigterm.txt';
    const result = await kernel.run(
      ['mcpcat', 'call', 'stdio:mcpcat-test-legacy', 'echo', '-d', '{"message":"hi"}'],
      { stdout: 'pipe', stderr: 'pipe', env: { PID_RECORD_FILE: pidFile } }
    );
    await sleep(500);
    await kernelPidCheck(pidFile, 'kernel SIGTERM');
  });

  it('SIGHUP: all pids dead, exactly one server', async () => {
    const pidFile = '/tmp/kpids-sighup.txt';
    const result = await kernel.run(
      ['mcpcat', 'call', 'stdio:mcpcat-test-legacy', 'echo', '-d', '{"message":"hi"}'],
      { stdout: 'pipe', stderr: 'pipe', env: { PID_RECORD_FILE: pidFile } }
    );
    await sleep(500);
    await kernelPidCheck(pidFile, 'kernel SIGHUP');
  });
});

describe('lifecycle: kernel add --bridge', {
  skip: !hasPgid && 'pgid requires slicc-kernel >= 1.74.0',
  timeout: 30_000,
}, () => {
  let kernel;
  let client;

  before(async () => {
    kernel = await createNodeKernel({});
    await installMcpcat(kernel);
    await installKernelFixture(
      kernel,
      'mcpcat-test-legacy',
      'mcpcat-test-legacy',
      'kernel-stdio-legacy-pidtrack.mjs'
    );
    await installKernelFixture(
      kernel,
      'mcpcat-test-sleeper',
      'mcpcat-test-sleeper',
      'kernel-sleeper.mjs'
    );
    const port = await kernel.connect();
    client = await attachKernel(port);
  });

  after(() => {
    client?.close();
    kernel?.terminate();
  });

  it('SIGTERM kills bridge upstream, one server', async () => {
    const pidFile = '/tmp/kpids-bridge.txt';
    const sp = await client.spawn(
      ['mcpcat', 'add', '--bridge', '--no-auth', 'test-bridge', '--', 'mcpcat-test-legacy'],
      {
        stdin: 'pipe',
        env: { PID_RECORD_FILE: pidFile },
        onStdout() {},
        onStderr() {},
      }
    );
    await sleep(2000);
    sp.signal('SIGTERM');
    await sp.exited;
    await sleep(500);
    let content;
    try {
      content = new TextDecoder().decode(await kernel.readFile(pidFile));
    } catch {
      return;
    }
    const lines = content.trim().split('\n');
    const servers = lines.filter((l) => l.startsWith('server:'));
    assert.equal(servers.length, 1, 'bridge: exactly one server');
    const ps = await client.ps();
    const alivePids = new Set(ps.map((p) => p.pid));
    for (const l of lines) {
      const pid = Number(l.split(':')[1]);
      assert.ok(!alivePids.has(pid), `bridge: pid ${pid} still alive`);
    }
  });
});
