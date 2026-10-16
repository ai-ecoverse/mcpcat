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
import { attachKernel, createNodeKernel, hasDeathSignal, hasPgid } from './helpers/kernel.mjs';
import { waitUntil } from './helpers/wait.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const fixturesDir = join(root, 'test/integration/fixtures');
const legacyCli = join(fixturesDir, 'server-stdio-legacy-pidtrack.mjs');
const slowCli = join(fixturesDir, 'server-stdio-legacy-slow-pidtrack.mjs');
const kernelBundle = join(root, 'dist/kernel/mcpcat.mjs');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

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

async function assertAllDead(pidFile, label) {
  const { servers, grandchildren } = parsePidFile(pidFile);
  assert.equal(servers.length, 1, `${label}: exactly one server should have been spawned`);
  const pids = [...servers, ...grandchildren];
  let alive = pids.filter(pidExists);
  const end = Date.now() + 5_000;
  while (alive.length > 0 && Date.now() < end) {
    await sleep(50);
    alive = pids.filter(pidExists);
  }
  assert.deepEqual(alive, [], `${label}: pids still alive 5 s after mcpcat exited`);
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

function serverRecorded(pidFile) {
  return waitUntil(
    () => parsePidFile(pidFile).grandchildren.length > 0,
    `the stdio server to record its pid in ${pidFile}`
  );
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
    await assertAllDead(pidFile, 'normal exit');
  });

  it('-m timeout: all pids dead, exactly one server', async () => {
    const pidFile = freshPidFile();
    const child = spawnMcpcat(['-m', '3', 'call', `stdio:node ${slowCli}`, 'slow', '-d', '{}'], {
      PID_RECORD_FILE: pidFile,
    });
    const { code } = await waitExit(child);
    assert.equal(code, 124);
    await assertAllDead(pidFile, 'timeout exit');
  });

  it('SIGTERM: all pids dead, exactly one server', async () => {
    const pidFile = freshPidFile();
    const child = spawnMcpcat(
      ['call', `stdio:node ${legacyCli}`, 'echo', '-d', '{"message":"hi"}'],
      { PID_RECORD_FILE: pidFile }
    );
    const exitPromise = waitExit(child);
    await serverRecorded(pidFile);
    try {
      child.kill('SIGTERM');
    } catch {}
    await exitPromise;
    await assertAllDead(pidFile, 'SIGTERM');
  });

  it('SIGHUP: all pids dead, exactly one server', async () => {
    const pidFile = freshPidFile();
    const child = spawnMcpcat(
      ['call', `stdio:node ${legacyCli}`, 'echo', '-d', '{"message":"hi"}'],
      { PID_RECORD_FILE: pidFile }
    );
    const exitPromise = waitExit(child);
    await serverRecorded(pidFile);
    try {
      child.kill('SIGHUP');
    } catch {}
    await exitPromise;
    await assertAllDead(pidFile, 'SIGHUP');
  });

  it('SIGINT: all pids dead, exactly one server', async () => {
    const pidFile = freshPidFile();
    const child = spawnMcpcat(
      ['call', `stdio:node ${legacyCli}`, 'echo', '-d', '{"message":"hi"}'],
      { PID_RECORD_FILE: pidFile }
    );
    const exitPromise = waitExit(child);
    await serverRecorded(pidFile);
    try {
      child.kill('SIGINT');
    } catch {}
    await exitPromise;
    await assertAllDead(pidFile, 'SIGINT');
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
    await serverRecorded(pidFile);
    child.kill('SIGTERM');
    await waitExit(child);
    await assertAllDead(pidFile, 'serve proxy SIGTERM');
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
    await serverRecorded(pidFile);
    child.kill('SIGHUP');
    await waitExit(child);
    await assertAllDead(pidFile, 'serve proxy SIGHUP');
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

async function installKernelFixtures(kernel) {
  await installMcpcat(kernel);
  for (const [name, file] of [
    ['mcpcat-test-legacy', 'kernel-stdio-legacy-pidtrack.mjs'],
    ['mcpcat-test-slow-legacy', 'kernel-stdio-legacy-slow-pidtrack.mjs'],
    ['mcpcat-test-sleeper', 'kernel-sleeper.mjs'],
    ['mcpcat-test-stubborn', 'kernel-sleeper-stubborn.mjs'],
    ['mcpcat-test-crash', 'kernel-stdio-crash-pidtrack.mjs'],
  ]) {
    await installKernelFixture(kernel, name, name, file);
  }
}

async function readKernelPids(kernel, pidFile) {
  let content;
  try {
    content = new TextDecoder().decode(await kernel.readFile(pidFile));
  } catch {
    return { servers: [], grandchildren: [] };
  }
  const servers = [];
  const grandchildren = [];
  for (const l of content.trim().split('\n')) {
    const [kind, pidStr] = l.split(':');
    if (kind === 'server') servers.push(Number(pidStr));
    else if (kind === 'grandchild') grandchildren.push(Number(pidStr));
  }
  return { servers, grandchildren };
}

function kernelServerRecorded(kernel, pidFile) {
  return waitUntil(
    async () => (await readKernelPids(kernel, pidFile)).servers.length > 0,
    `the stdio server to record its pid in ${pidFile}`
  );
}

async function assertKernelPidsGone(kernel, client, pidFile, label) {
  const { servers, grandchildren } = await readKernelPids(kernel, pidFile);
  assert.equal(servers.length, 1, `${label}: exactly one server`);
  const live = new Set((await client.ps()).filter((p) => p.state !== 'Z').map((p) => p.pid));
  const alive = [...servers, ...grandchildren].filter((pid) => live.has(pid));
  assert.deepEqual(alive, [], `${label}: pids still alive when mcpcat exited`);
}

async function assertKernelPidsDead(kernel, client, pidFile, label) {
  const { servers, grandchildren } = await readKernelPids(kernel, pidFile);
  assert.equal(servers.length, 1, `${label}: exactly one server`);
  const pids = [...servers, ...grandchildren];
  let alive = [];
  const end = Date.now() + 5_000;
  do {
    const live = new Set((await client.ps()).filter((p) => p.state !== 'Z').map((p) => p.pid));
    alive = pids.filter((pid) => live.has(pid));
    if (alive.length > 0) await sleep(50);
  } while (alive.length > 0 && Date.now() < end);
  assert.deepEqual(alive, [], `${label}: pids still alive 5 s after mcpcat exited`);
}

describe('lifecycle: kernel stdio client', {
  skip: !hasPgid && 'pgid requires slicc-kernel >= 1.74.0',
  timeout: 30_000,
}, () => {
  let kernel;
  let client;

  before(async () => {
    kernel = await createNodeKernel({});
    await installKernelFixtures(kernel);
    const port = await kernel.connect();
    client = await attachKernel(port);
  });

  after(() => {
    client?.close();
    kernel?.terminate();
  });

  it('normal exit: all pids dead, exactly one server', async () => {
    const pidFile = '/tmp/kpids-normal.txt';
    const { status, stderr } = await kernel.run(
      ['mcpcat', 'call', 'stdio:mcpcat-test-legacy', 'echo', '-d', '{"message":"hi"}'],
      { stdout: 'pipe', stderr: 'pipe', env: { PID_RECORD_FILE: pidFile } }
    );
    assert.equal(status, 0, `stderr: ${stderr}`);
    await assertKernelPidsDead(kernel, client, pidFile, 'kernel normal exit');
  });

  for (const [sig, code] of [
    ['SIGTERM', 143],
    ['SIGHUP', 129],
  ]) {
    it(`${sig}: all pids dead, exactly one server`, async () => {
      const pidFile = `/tmp/kpids-${sig.toLowerCase()}.txt`;
      let stderr = '';
      const sp = await client.spawn(
        ['mcpcat', 'call', 'stdio:mcpcat-test-slow-legacy', 'slow', '-d', '{}'],
        {
          stdin: 'pipe',
          env: { PID_RECORD_FILE: pidFile },
          onStdout() {},
          onStderr(chunk) {
            stderr += new TextDecoder().decode(chunk);
          },
        }
      );
      await kernelServerRecorded(kernel, pidFile);
      sp.signal(sig);
      assert.equal(await sp.exited, code, `stderr: ${stderr}`);
      await assertKernelPidsDead(kernel, client, pidFile, `kernel ${sig}`);
    });
  }
});

describe('lifecycle: kernel add --bridge', {
  skip: !hasPgid && 'pgid requires slicc-kernel >= 1.74.0',
  timeout: 30_000,
}, () => {
  let kernel;
  let client;

  before(async () => {
    kernel = await createNodeKernel({});
    await installKernelFixtures(kernel);
    const port = await kernel.connect();
    client = await attachKernel(port);
  });

  after(() => {
    client?.close();
    kernel?.terminate();
  });

  it('SIGTERM kills bridge upstream, one server', async () => {
    const pidFile = '/tmp/kpids-bridge.txt';
    let output = '';
    const collect = (chunk) => {
      output += new TextDecoder().decode(chunk);
    };
    const sp = await client.spawn(
      ['mcpcat', 'add', '--bridge', '--no-auth', 'test-bridge', '--', 'mcpcat-test-legacy'],
      {
        stdin: 'pipe',
        env: { PID_RECORD_FILE: pidFile },
        onStdout: collect,
        onStderr: collect,
      }
    );
    const url = await waitUntil(
      () => /http:\/\/\d+\.kernel\.localhost\/mcp/.exec(output)?.[0],
      'the bridge to print its URL'
    );
    const call = await kernel.run(['mcpcat', 'call', url, 'echo', '-d', '{"message":"hi"}'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assert.equal(call.status, 0, `call through the bridge: ${call.stderr}`);
    await kernelServerRecorded(kernel, pidFile);
    sp.signal('SIGTERM');
    await sp.exited;
    await assertKernelPidsDead(kernel, client, pidFile, 'bridge');
  });
});

describe('lifecycle: kernel stdio servers whose grandchild ignores TERM, HUP and INT', {
  skip: !hasPgid && 'pgid requires slicc-kernel >= 1.74.0',
  timeout: 120_000,
}, () => {
  let kernel;
  let client;

  before(async () => {
    kernel = await createNodeKernel({});
    await installKernelFixtures(kernel);
    const port = await kernel.connect();
    client = await attachKernel(port);
  });

  after(() => {
    client?.close();
    kernel?.terminate();
  });

  it('call: server and grandchild are gone when mcpcat exits, 20 times', {
    skip:
      hasDeathSignal &&
      "slicc-kernel >= 1.88.0 SIGKILLs the stdio server's process group when mcpcat exits (parentDeathSignal on a pgid 0 spawn), so the grandchild cannot outlive a call; the bridge reconnect test below covers the reap",
  }, async () => {
    for (let round = 0; round < 20; round++) {
      const pidFile = `/tmp/kpids-stubborn-call-${round}.txt`;
      const { status, stderr } = await kernel.run(
        ['mcpcat', 'call', 'stdio:mcpcat-test-legacy', 'echo', '-d', '{"message":"hi"}'],
        {
          stdout: 'pipe',
          stderr: 'pipe',
          env: { PID_RECORD_FILE: pidFile, GRANDCHILD: 'mcpcat-test-stubborn' },
        }
      );
      assert.equal(status, 0, `round ${round}: ${stderr}`);
      await assertKernelPidsGone(kernel, client, pidFile, `call round ${round}`);
    }
  });

  async function bridgeRound(round) {
    const pidFile = `/tmp/kpids-stubborn-bridge-${round}.txt`;
    let output = '';
    const collect = (chunk) => {
      output += new TextDecoder().decode(chunk);
    };
    const sp = await client.spawn(
      ['mcpcat', 'add', '--bridge', '--no-auth', `stubborn-${round}`, '--', 'mcpcat-test-legacy'],
      {
        stdin: 'pipe',
        env: { PID_RECORD_FILE: pidFile, GRANDCHILD: 'mcpcat-test-stubborn' },
        onStdout: collect,
        onStderr: collect,
      }
    );
    const url = await waitUntil(
      () => /http:\/\/\d+\.kernel\.localhost\/mcp/.exec(output)?.[0],
      'the bridge to print its URL'
    );
    const call = await kernel.run(['mcpcat', 'call', url, 'echo', '-d', '{"message":"hi"}'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assert.equal(call.status, 0, `round ${round}: call through the bridge: ${call.stderr}`);
    await kernelServerRecorded(kernel, pidFile);
    sp.signal('SIGTERM');
    await sp.exited;
    await assertKernelPidsGone(kernel, client, pidFile, `bridge round ${round}`);
  }

  it('add --bridge: reconnecting after the upstream crashed reaps the old grandchild while the bridge keeps running', async () => {
    const pidFile = '/tmp/kpids-crash-bridge.txt';
    let output = '';
    const collect = (chunk) => {
      output += new TextDecoder().decode(chunk);
    };
    const sp = await client.spawn(
      ['mcpcat', 'add', '--bridge', '--no-auth', 'crash', '--', 'mcpcat-test-crash'],
      {
        stdin: 'pipe',
        env: { PID_RECORD_FILE: pidFile, GRANDCHILD: 'mcpcat-test-stubborn' },
        onStdout: collect,
        onStderr: collect,
      }
    );
    let bridgeExited = false;
    void sp.exited.then(
      () => {
        bridgeExited = true;
      },
      () => {}
    );
    const url = await waitUntil(
      () => /http:\/\/\d+\.kernel\.localhost\/mcp/.exec(output)?.[0],
      'the bridge to print its URL'
    );
    const run = (args) => kernel.run(['mcpcat', ...args], { stdout: 'pipe', stderr: 'pipe' });
    const started = await run(['tools', url]);
    assert.equal(started.status, 0, `tools through the bridge: ${started.stderr}`);
    const first = await readKernelPids(kernel, pidFile);
    assert.equal(first.servers.length, 1, 'one upstream before the crash');
    const sigterm = 1 << 15;
    await waitUntil(
      async () =>
        (await client.ps()).some((p) => p.pid === first.grandchildren[0] && p.sigCgt & sigterm),
      'the grandchild to trap SIGTERM'
    );
    const crash = await run(['call', url, 'crash']);
    assert.equal(crash.status, 0, `call crash through the bridge: ${crash.stderr}`);
    const live = async () =>
      new Set((await client.ps()).filter((p) => p.state !== 'Z').map((p) => p.pid));
    await waitUntil(
      async () => !(await live()).has(first.servers[0]),
      'the first upstream to exit'
    );
    assert.ok(
      (await live()).has(first.grandchildren[0]),
      'the crashed upstream left its grandchild'
    );
    const tools = await run(['tools', url]);
    assert.equal(tools.status, 0, `tools after the crash: ${tools.stderr}`);
    assert.equal(
      (await readKernelPids(kernel, pidFile)).servers.length,
      2,
      'the bridge reconnected'
    );
    assert.ok(!bridgeExited, `the bridge should still be running: ${output}`);
    assert.ok(
      !(await live()).has(first.grandchildren[0]),
      `grandchild ${first.grandchildren[0]} of the crashed upstream outlived the reconnect`
    );
    sp.signal('SIGTERM');
    await sp.exited;
  });

  for (let batch = 0; batch < 4; batch++) {
    it(`add --bridge: SIGTERM leaves no upstream process behind, rounds ${batch * 5}-${batch * 5 + 4}`, async () => {
      await Promise.all([0, 1, 2, 3, 4].map((i) => bridgeRound(batch * 5 + i)));
    });
  }
});
