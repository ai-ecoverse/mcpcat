import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { attachKernel, createNodeKernel, hostUrl, nodeTransport } from './helpers/kernel.mjs';
import { waitUntil } from './helpers/wait.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const hostBin = join(root, 'dist/host/mcpcat.mjs');
const fixturesDir = join(root, 'test/integration/fixtures');
const kernelBundle = join(root, 'dist/kernel/mcpcat.mjs');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

async function startFixtureServer(script) {
  const child = spawn('node', [join(fixturesDir, script)], {
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

function spawnHost(args) {
  return spawn('node', [hostBin, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
}

function waitForExit(child) {
  return new Promise((resolve) => {
    child.on('exit', (code) => resolve(code));
  });
}

function waitForStderr(child, pattern, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`stderr never matched ${pattern}`)), timeoutMs);
    child.stderr.on('data', (chunk) => {
      buf += chunk.toString();
      if (pattern.test(buf)) {
        clearTimeout(timer);
        resolve(buf);
      }
    });
    child.on('exit', () => {
      clearTimeout(timer);
      reject(new Error(`process exited before stderr matched ${pattern}. stderr: ${buf}`));
    });
  });
}

function serverStarted(base) {
  return waitUntil(
    async () => (await (await fetch(`${base}/__started`)).json()).length > 0,
    'the server to receive the tools/call request'
  );
}

async function installMcpcat(kernel) {
  const bundleData = readFileSync(kernelBundle);
  await kernel.writeFile('/node_modules/@ai-ecoverse/mcpcat/dist/kernel/mcpcat.mjs', bundleData);
  await kernel.writeFile(
    '/node_modules/@ai-ecoverse/mcpcat/package.json',
    JSON.stringify({
      name: '@ai-ecoverse/mcpcat',
      version: pkg.version,
      type: 'module',
      slicc: {
        commands: {
          mcpcat: {
            abi: 'js',
            module: 'dist/kernel/mcpcat.mjs',
          },
        },
      },
    })
  );
}

async function installKernelFixtures(kernel) {
  const slowData = readFileSync(join(fixturesDir, 'kernel-stdio-slow.mjs'));
  await kernel.writeFile('/node_modules/@ai-ecoverse/mcpcat-test-slow/dist/server.mjs', slowData);
  await kernel.writeFile(
    '/node_modules/@ai-ecoverse/mcpcat-test-slow/package.json',
    JSON.stringify({
      name: '@ai-ecoverse/mcpcat-test-slow',
      version: '1.0.0',
      type: 'module',
      slicc: {
        commands: {
          'mcpcat-test-slow': {
            abi: 'js',
            module: 'dist/server.mjs',
          },
        },
      },
    })
  );

  const runnerData = readFileSync(join(fixturesDir, 'kernel-sigint-runner.mjs'));
  await kernel.writeFile('/node_modules/@ai-ecoverse/sigint-runner/dist/main.mjs', runnerData);
  await kernel.writeFile(
    '/node_modules/@ai-ecoverse/sigint-runner/package.json',
    JSON.stringify({
      name: '@ai-ecoverse/sigint-runner',
      version: '1.0.0',
      type: 'module',
      slicc: {
        commands: {
          'sigint-runner': {
            abi: 'js',
            module: 'dist/main.mjs',
          },
        },
      },
    })
  );
}

describe('host: SIGINT cancels stdio call and exits 130', () => {
  it('SIGINT during progress-wait exits 130', async () => {
    const script = join(fixturesDir, 'server-stdio-progress.mjs');
    const child = spawnHost([
      '-v',
      'call',
      `stdio:node ${script}`,
      'progress-wait',
      '-d',
      '{"count":2}',
    ]);

    await waitForStderr(child, /progress:/);

    child.kill('SIGINT');

    const code = await waitForExit(child);
    assert.equal(code, 130, 'exit code should be 130');
  });
});

describe('host: SIGINT cancels 2026 HTTP call and exits 130', () => {
  let server;
  let url;

  before(async () => {
    server = await startFixtureServer('server-2026-http-cancel.mjs');
    url = `http://127.0.0.1:${server.port}`;
  });

  after(() => {
    server?.child.kill('SIGTERM');
  });

  it('SIGINT during slow HTTP call exits 130 and server sees abort', async () => {
    const child = spawnHost(['-v', 'call', url, 'slow-cancel', '-d', '{}']);

    child.stderr.on('data', () => {});
    await serverStarted(url);

    child.kill('SIGINT');

    const code = await waitForExit(child);
    assert.equal(code, 130, 'exit code should be 130');

    const abortedList = await waitUntil(async () => {
      const list = await (await fetch(`${url}/__aborted`)).json();
      return list.length > 0 && list;
    }, 'the server to see the aborted request');
    assert.equal(abortedList[0].tool, 'slow-cancel');
  });
});

describe('kernel: SIGINT cancels 2026 HTTP call and exits 130', () => {
  let kernel;
  let client;
  let server;
  let url;

  before(async () => {
    server = await startFixtureServer('server-2026-http-cancel.mjs');
    url = hostUrl(server.port);
    kernel = await createNodeKernel({
      network: { transport: nodeTransport({ hostLoopback: true }) },
    });
    await installMcpcat(kernel);
    const port = await kernel.connect();
    client = await attachKernel(port);
  });

  after(() => {
    client?.close();
    kernel?.terminate();
    server?.child.kill('SIGTERM');
  });

  it('SIGINT via kill exits 130', async () => {
    let stderr = '';
    const proc = await client.spawn(['mcpcat', '-v', 'call', url, 'slow-cancel', '-d', '{}'], {
      stdin: 'pipe',
      onStdout() {},
      onStderr(chunk) {
        stderr += new TextDecoder().decode(chunk);
      },
    });

    await serverStarted(`http://127.0.0.1:${server.port}`);

    await client.kill(proc.pid, 'SIGINT');

    const code = await proc.exited;
    assert.equal(code, 130, `exit code should be 130; stderr: ${stderr}`);
    const aborted = await waitUntil(async () => {
      const list = await (await fetch(`http://127.0.0.1:${server.port}/__aborted`)).json();
      return list.length > 0 && list;
    }, 'the server to see the aborted request');
    assert.equal(aborted[0].tool, 'slow-cancel');
  });
});

describe('kernel: SIGINT cancels stdio call', () => {
  let kernel;

  before(async () => {
    kernel = await createNodeKernel({});
    await installMcpcat(kernel);
    await installKernelFixtures(kernel);
  });

  after(() => {
    kernel?.terminate();
  });

  it('SIGINT on stdio call prints interrupted and terminates', async () => {
    const res = await kernel.run(
      ['sigint-runner', '-v', 'call', 'stdio:mcpcat-test-slow', 'slow', '-d', '{"ms":30000}'],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    assert.ok(
      res.stderr.includes('interrupted'),
      `stderr should mention interrupted, got: ${res.stderr}`
    );
    assert.equal(res.status, 130, `stderr: ${res.stderr}`);
  });
});
