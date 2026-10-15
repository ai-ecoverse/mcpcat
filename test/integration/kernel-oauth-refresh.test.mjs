import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  attachKernel,
  createNodeKernel,
  fetchReachesKernelLoopback,
  nodeTransport,
} from './helpers/kernel.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const fixturesDir = join(root, 'test/integration/fixtures');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const AGENT_DIR = '/home/agent/.pi/agent';
const CLIENT_ID = 'mcpcat-kernel-test';
const TTL = 4;

async function installPackage(kernel, name, command, module, data) {
  await kernel.writeFile(`/node_modules/${name}/${module}`, data);
  await kernel.writeFile(
    `/node_modules/${name}/package.json`,
    JSON.stringify({
      name,
      version: name === '@ai-ecoverse/mcpcat' ? pkg.version : '1.0.0',
      type: 'module',
      slicc: { commands: { [command]: { abi: 'js', module } } },
    })
  );
}

function newSeed() {
  return { refreshToken: randomBytes(24).toString('hex'), clientId: CLIENT_ID, ttl: TTL };
}

function expiredState(url, seed) {
  return {
    [String(new URL(url))]: {
      serverUrl: url,
      clientInformation: { client_id: CLIENT_ID, redirect_uris: ['http://127.0.0.1/callback'] },
      tokens: {
        access_token: randomBytes(24).toString('hex'),
        token_type: 'Bearer',
        expires_in: TTL,
        refresh_token: seed.refreshToken,
      },
      tokensExpireAt: Date.now() - 1000,
    },
  };
}

function startKernelAs(client, seedPath) {
  const dec = new TextDecoder();
  let stdout = '';
  let stderr = '';
  let resolvePort;
  const port = new Promise((resolve) => {
    resolvePort = resolve;
  });
  const spawned = client.spawn(['kernel-oauth-as', seedPath], {
    stdin: 'pipe',
    onStdout(chunk) {
      stdout += dec.decode(chunk, { stream: true });
      const nl = stdout.indexOf('\n');
      if (nl >= 0) resolvePort(JSON.parse(stdout.slice(0, nl)).port);
    },
    onStderr(chunk) {
      stderr += dec.decode(chunk, { stream: true });
    },
  });
  return { spawned, port, log: () => stderr };
}

async function startHostAs(seedPath) {
  const child = spawn('node', [join(fixturesDir, 'oauth-as-host.mjs'), seedPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  let stderr = '';
  child.stderr.on('data', (c) => {
    stderr += c.toString();
  });
  const port = await new Promise((resolve, reject) => {
    let data = '';
    child.stdout.on('data', (c) => {
      data += c.toString();
      const nl = data.indexOf('\n');
      if (nl >= 0) resolve(JSON.parse(data.slice(0, nl)).port);
    });
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`AS exited ${code}`)));
  });
  return { child, port, log: () => stderr };
}

function refreshes(log) {
  return log.split('\n').filter((l) => l.startsWith('token ')).length;
}

describe("kernel: an expired token refreshes against an authorization server on the kernel's loopback", () => {
  let kernel;
  let client;
  let hostDir;
  const servers = [];

  before(async () => {
    kernel = await createNodeKernel({
      network: { transport: nodeTransport({ hostLoopback: !fetchReachesKernelLoopback }) },
    });
    await installPackage(
      kernel,
      '@ai-ecoverse/mcpcat',
      'mcpcat',
      'dist/kernel/mcpcat.mjs',
      readFileSync(join(root, 'dist/kernel/mcpcat.mjs'))
    );
    await installPackage(
      kernel,
      '@ai-ecoverse/mcpcat-test-oauth-as',
      'kernel-oauth-as',
      'dist/as.mjs',
      readFileSync(join(fixturesDir, 'kernel-oauth-as.mjs'))
    );
    client = await attachKernel(await kernel.connect());
    hostDir = mkdtempSync(join(tmpdir(), 'mcpcat-kernel-as-'));
  });

  after(async () => {
    for (const s of servers) {
      if (s.child) s.child.kill('SIGTERM');
      else {
        const sp = await s.spawned;
        sp.signal('SIGTERM');
        await sp.exited.catch(() => undefined);
      }
    }
    client?.close();
    kernel?.terminate();
    if (hostDir) rmSync(hostDir, { recursive: true, force: true });
  });

  async function refreshesOnce(url, log) {
    const agentDir = `${AGENT_DIR}/${servers.length}`;
    await kernel.writeFile(`${agentDir}/mcp-auth.json`, JSON.stringify(url.state));
    const { status, stdout, stderr } = await kernel.run(
      ['mcpcat', 'call', url.href, 'echo', '-d', '{"message":"after refresh"}'],
      { stdout: 'pipe', stderr: 'pipe', env: { PI_CODING_AGENT_DIR: agentDir } }
    );
    assert.equal(status, 0, `expected exit 0, got ${status}; stderr: ${stderr}; AS: ${log()}`);
    assert.ok(stdout.includes('after refresh'), stdout);
    assert.equal(refreshes(log()), 1, `AS log: ${log()}`);
    assert.ok(!log().includes('rejected'), `AS log: ${log()}`);
  }

  async function kernelAs() {
    const seed = newSeed();
    const seedPath = `/tmp/as-seed-${servers.length}.json`;
    await kernel.writeFile(seedPath, JSON.stringify(seed));
    const as = startKernelAs(client, seedPath);
    servers.push(as);
    return { seed, port: await as.port, log: as.log };
  }

  it('at 127.0.0.1:<port> served inside the kernel', async () => {
    const { seed, port, log } = await kernelAs();
    const href = `http://127.0.0.1:${port}/mcp`;
    await refreshesOnce({ href, state: expiredState(href, seed) }, log);
  });

  it('at the host 127.0.0.1:<port> with hostLoopback on', {
    skip: fetchReachesKernelLoopback && "kernel >= 1.91 maps 127.0.0.1 to the kernel's loopback",
  }, async () => {
    const seed = newSeed();
    const seedPath = join(hostDir, `seed-${servers.length}.json`);
    writeFileSync(seedPath, JSON.stringify(seed));
    const as = await startHostAs(seedPath);
    servers.push(as);
    const href = `http://127.0.0.1:${as.port}/mcp`;
    await refreshesOnce({ href, state: expiredState(href, seed) }, as.log);
  });
});
