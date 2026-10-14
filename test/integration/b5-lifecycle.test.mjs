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
const slowWrapper = join(fixturesDir, 'server-stdio-legacy-slow-wrapper.sh');
const kernelBundle = join(root, 'dist/kernel/mcpcat.mjs');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const kernelPkg = JSON.parse(
  readFileSync(join(root, 'node_modules/@ai-ecoverse/slicc-kernel/package.json'), 'utf8')
);
const kernelVersion = kernelPkg.version.split('.').map(Number);
const hasPgid = kernelVersion[0] > 1 || (kernelVersion[0] === 1 && kernelVersion[1] >= 74);
const hasDeathSignal = kernelVersion[0] > 1 || (kernelVersion[0] === 1 && kernelVersion[1] >= 88);

const testHome = join(tmpdir(), `mcpcat-b5-${Date.now()}`);
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
  assert.ok(servers.length >= 1, `${label}: at least one server pid expected`);
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

function freshPidFile() {
  const p = join(testHome, `pids-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`);
  try {
    unlinkSync(p);
  } catch {}
  return p;
}

function waitExit(child) {
  return new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }));
  });
}

function spawnMcpcatDetached(args, extraEnv = {}) {
  const { cmd, args: cmdArgs } = mcpcatArgs(args);
  const child = spawn(cmd, cmdArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true,
    env: { ...process.env, NODE_NO_WARNINGS: '1', ...testEnv, ...extraEnv },
  });
  child.unref();
  spawnedChildren.push(child);
  return child;
}

function spawnMcpcatSameGroup(args, extraEnv = {}) {
  const { cmd, args: cmdArgs } = mcpcatArgs(args);
  const child = spawn(cmd, cmdArgs, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NODE_NO_WARNINGS: '1', ...testEnv, ...extraEnv },
  });
  spawnedChildren.push(child);
  return child;
}

async function waitForPidFile(pidFile, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (existsSync(pidFile)) return true;
    await sleep(100);
  }
  return false;
}

describe('B5: host wrapper-launched stdio, signal to PID', { timeout: 30_000 }, () => {
  for (const sig of ['SIGTERM', 'SIGHUP']) {
    it(`${sig} to pid: server, grandchild and wrapper dead`, async () => {
      const pidFile = freshPidFile();
      const child = spawnMcpcatSameGroup(['call', `stdio:${slowWrapper}`, 'slow', '-d', '{}'], {
        PID_RECORD_FILE: pidFile,
      });
      child.stderr.on('data', () => {});
      const exitPromise = waitExit(child);
      assert.ok(await waitForPidFile(pidFile), 'pid file should appear');
      child.kill(sig);
      await exitPromise;
      await sleep(500);
      assertAllDead(pidFile, `host pid ${sig}`);
    });
  }
});

describe('B5: host wrapper-launched stdio, signal to GROUP', { timeout: 30_000 }, () => {
  for (const sig of ['SIGTERM', 'SIGHUP']) {
    it(`${sig} to group: server, grandchild and wrapper dead`, async () => {
      const pidFile = freshPidFile();
      const child = spawnMcpcatDetached(['call', `stdio:${slowWrapper}`, 'slow', '-d', '{}'], {
        PID_RECORD_FILE: pidFile,
      });
      child.stderr.on('data', () => {});
      const exitPromise = waitExit(child);
      assert.ok(await waitForPidFile(pidFile), 'pid file should appear');
      process.kill(-child.pid, sig);
      await exitPromise;
      await sleep(500);
      assertAllDead(pidFile, `host group ${sig}`);
    });
  }
});

async function installKernel(kernel) {
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
  for (const [name, file] of [
    ['mcpcat-test-slow-legacy', 'kernel-stdio-legacy-slow-pidtrack.mjs'],
    ['mcpcat-test-sleeper', 'kernel-sleeper.mjs'],
  ]) {
    const data = readFileSync(join(fixturesDir, file));
    await kernel.writeFile(`/node_modules/@ai-ecoverse/${name}/dist/main.mjs`, data);
    await kernel.writeFile(
      `/node_modules/@ai-ecoverse/${name}/package.json`,
      JSON.stringify({
        name: `@ai-ecoverse/${name}`,
        version: '1.0.0',
        type: 'module',
        slicc: { commands: { [name]: { abi: 'js', module: 'dist/main.mjs' } } },
      })
    );
  }
}

describe('B5: kernel stdio, SIGTERM/SIGHUP to group kills server tree', {
  skip: !hasPgid && 'pgid requires slicc-kernel >= 1.74.0',
  timeout: 30_000,
}, () => {
  let kernel;
  let client;

  before(async () => {
    kernel = await createNodeKernel({});
    await installKernel(kernel);
    const port = await kernel.connect();
    client = await attachKernel(port);
  });

  after(() => {
    client?.close();
    kernel?.terminate();
  });

  for (const sig of ['SIGTERM', 'SIGHUP']) {
    it(`${sig} to group: server and grandchild dead`, async () => {
      const pidFile = `/tmp/k-b5-${sig.toLowerCase()}-${Date.now()}.txt`;
      const sp = await client.spawn(
        ['mcpcat', 'call', 'stdio:mcpcat-test-slow-legacy', 'slow', '-d', '{}'],
        {
          stdin: 'pipe',
          env: { PID_RECORD_FILE: pidFile },
          onStdout() {},
          onStderr() {},
        }
      );

      await sleep(2000);

      const psBefore = await client.ps();
      const serversBefore = psBefore.filter((p) =>
        p.argv.some((a) => a.includes('mcpcat-test-slow-legacy'))
      );
      assert.ok(serversBefore.length > 0, 'server should be running before signal');

      sp.signal(sig);
      await sp.exited;
      await sleep(500);

      const psAfter = await client.ps();
      const survivors = psAfter.filter((p) => p.argv.some((a) => a.includes('mcpcat-test')));
      assert.equal(
        survivors.length,
        0,
        `${sig}: all mcpcat-test processes should be dead, got: ${JSON.stringify(survivors.map((p) => p.argv))}`
      );
    });
  }

  it('SIGKILL to group: nothing survives', {
    skip: !hasDeathSignal && 'parentDeathSignal requires slicc-kernel >= 1.88.0',
  }, async () => {
    const sp = await client.spawn(
      ['mcpcat', 'call', 'stdio:mcpcat-test-slow-legacy', 'slow', '-d', '{}'],
      { stdin: 'pipe', env: {}, onStdout() {}, onStderr() {} }
    );
    const isTest = (p) => p.state !== 'Z' && p.argv.some((a) => a.includes('mcpcat-test'));
    const isServer = (p) => isTest(p) && p.argv[0] !== 'mcpcat';
    let end = Date.now() + 10_000;
    while (Date.now() < end && !(await client.ps()).some(isServer)) await sleep(100);
    assert.ok((await client.ps()).some(isServer), 'server should be running before SIGKILL');
    sp.signal('SIGKILL');
    await sp.exited;
    let survivors = [];
    end = Date.now() + 5_000;
    do {
      survivors = (await client.ps()).filter(isTest);
      if (survivors.length > 0) await sleep(100);
    } while (survivors.length > 0 && Date.now() < end);
    for (const s of survivors) {
      try {
        await client.kill(s.pid, 'SIGKILL');
      } catch {}
    }
    assert.deepEqual(
      survivors.map((p) => p.argv),
      [],
      'SIGKILL: every mcpcat-test process should be dead'
    );
  });
});
