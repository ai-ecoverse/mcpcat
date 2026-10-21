import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { attachKernel, createNodeKernel, hostUrl, nodeTransport } from './helpers/kernel.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const hostBin = join(root, 'dist/host/mcpcat.mjs');
const kernelBundle = join(root, 'dist/kernel/mcpcat.mjs');
const fixturesDir = join(root, 'test/integration/fixtures');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const quietStdio = `stdio:node ${join(fixturesDir, 'server-stdio-2026-quiet.mjs')}`;
const PENDING = /> tools\/list/;
const PROMPT_MS = 3_000;

function startStallServer() {
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      const msg = JSON.parse(raw);
      res.writeHead(200, { 'content-type': 'application/json' });
      if (msg.method === 'server/discover') {
        const result = { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } };
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
        return;
      }
      res.write('{');
    });
  });
  server.listen(0, '127.0.0.1');
  return once(server, 'listening').then(() => server);
}

function stopStallServer(server) {
  server?.closeAllConnections();
  server?.close();
}

function runHost(args, interruptOn) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, [hostBin, ...args], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    let stderr = '';
    let signalledAt;
    child.stdout.on('data', () => {});
    child.stderr.on('data', (c) => {
      stderr += c;
      if (interruptOn && !signalledAt && interruptOn.test(stderr)) {
        signalledAt = Date.now();
        child.kill('SIGINT');
      }
    });
    const killer = setTimeout(() => child.kill('SIGKILL'), 25_000);
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      clearTimeout(killer);
      const end = Date.now();
      resolve({ code, signal, stderr, elapsed: end - started, sinceSignal: end - signalledAt });
    });
  });
}

describe('host bundle: abort during a pending request (#325)', () => {
  it('SIGINT during a pending stdio read exits 130 promptly', async () => {
    const res = await runHost(['-v', '-m', '20', 'tools', quietStdio], PENDING);
    assert.equal(res.signal, null, `killed after ${res.elapsed}ms: ${res.stderr}`);
    assert.equal(res.code, 130, res.stderr);
    assert.match(res.stderr, /interrupted/);
    assert.ok(res.sinceSignal < PROMPT_MS, `exited ${res.sinceSignal}ms after SIGINT`);
  });

  it('a silent stdio server hits the request timeout', async () => {
    const res = await runHost(['-m', '1', 'tools', quietStdio]);
    assert.equal(res.code, 124, res.stderr);
    assert.ok(res.elapsed < 10_000, `took ${res.elapsed}ms`);
  });

  describe('stateless HTTP', () => {
    let stall;

    before(async () => {
      stall = await startStallServer();
    });

    after(() => stopStallServer(stall));

    it('SIGINT while the response body is pending exits 130 promptly', async () => {
      const url = `http://127.0.0.1:${stall.address().port}`;
      const res = await runHost(['-v', '-m', '20', 'tools', url], PENDING);
      assert.equal(res.signal, null, `killed after ${res.elapsed}ms: ${res.stderr}`);
      assert.equal(res.code, 130, res.stderr);
      assert.ok(res.sinceSignal < PROMPT_MS, `exited ${res.sinceSignal}ms after SIGINT`);
    });
  });
});

async function installPackage(kernel, name, file, data) {
  await kernel.writeFile(`/node_modules/@ai-ecoverse/${name}/${file}`, data);
  await kernel.writeFile(
    `/node_modules/@ai-ecoverse/${name}/package.json`,
    JSON.stringify({
      name: `@ai-ecoverse/${name}`,
      version: name === 'mcpcat' ? pkg.version : '1.0.0',
      type: 'module',
      slicc: { commands: { [name]: { abi: 'js', module: file } } },
    })
  );
}

describe('kernel bundle: abort during a pending request (#325)', () => {
  let kernel;
  let client;
  let stall;

  before(async () => {
    stall = await startStallServer();
    kernel = await createNodeKernel({
      network: { transport: nodeTransport({ hostLoopback: true }) },
    });
    await installPackage(kernel, 'mcpcat', 'dist/kernel/mcpcat.mjs', readFileSync(kernelBundle));
    await installPackage(
      kernel,
      'mcpcat-test-quiet',
      'dist/server.mjs',
      readFileSync(join(fixturesDir, 'kernel-stdio-2026-quiet.mjs'))
    );
    const port = await kernel.connect();
    client = await attachKernel(port);
  });

  after(() => {
    client?.close();
    kernel?.terminate();
    stopStallServer(stall);
  });

  async function runKernel(argv, interruptOn) {
    const started = Date.now();
    const decoder = new TextDecoder();
    let stderr = '';
    let onMatch;
    const matched = new Promise((resolve) => {
      onMatch = resolve;
    });
    const proc = await client.spawn(argv, {
      stdin: 'pipe',
      onStdout() {},
      onStderr(chunk) {
        stderr += decoder.decode(chunk, { stream: true });
        if (interruptOn?.test(stderr)) onMatch();
      },
    });
    const killer = setTimeout(() => client.kill(proc.pid, 'SIGKILL').catch(() => {}), 25_000);
    let signalledAt;
    if (interruptOn) {
      await Promise.race([matched, proc.exited]);
      signalledAt = Date.now();
      await client.kill(proc.pid, 'SIGINT').catch(() => {});
    }
    const code = await proc.exited;
    clearTimeout(killer);
    const end = Date.now();
    return { code, stderr, elapsed: end - started, sinceSignal: end - signalledAt };
  }

  it('SIGINT during a pending stdio read exits 130 promptly', async () => {
    const res = await runKernel(
      ['mcpcat', '-v', '-m', '20', 'tools', 'stdio:mcpcat-test-quiet'],
      PENDING
    );
    assert.equal(res.code, 130, res.stderr);
    assert.match(res.stderr, /interrupted/);
    assert.ok(res.sinceSignal < PROMPT_MS, `exited ${res.sinceSignal}ms after SIGINT`);
  });

  it('a silent stdio server hits the request timeout', async () => {
    const res = await runKernel(['mcpcat', '-m', '1', 'tools', 'stdio:mcpcat-test-quiet']);
    assert.equal(res.code, 124, res.stderr);
    assert.ok(res.elapsed < 10_000, `took ${res.elapsed}ms`);
  });

  it('SIGINT while the HTTP response body is pending exits 130 promptly', async () => {
    const res = await runKernel(
      ['mcpcat', '-v', '-m', '20', 'tools', hostUrl(stall.address().port)],
      PENDING
    );
    assert.equal(res.code, 130, res.stderr);
    assert.ok(res.sinceSignal < PROMPT_MS, `exited ${res.sinceSignal}ms after SIGINT`);
  });
});
