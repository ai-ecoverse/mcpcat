import assert from 'node:assert/strict';
import { execFileSync as exec, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { attachKernel } from '@ai-ecoverse/slicc-kernel';
import { createNodeKernel, nodeTransport } from '@ai-ecoverse/slicc-kernel/node';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const kernelBundle = join(root, 'dist/kernel/mcpcat.mjs');
const hostBin = join(root, 'dist/host/mcpcat.mjs');
const fixturesDir = join(root, 'test/integration/fixtures');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

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

async function installStdioFixture(kernel) {
  const fixtureData = readFileSync(join(fixturesDir, 'kernel-stdio-server.mjs'));
  await kernel.writeFile(
    '/node_modules/@ai-ecoverse/mcpcat-test-stdio/dist/server.mjs',
    fixtureData
  );
  await kernel.writeFile(
    '/node_modules/@ai-ecoverse/mcpcat-test-stdio/package.json',
    JSON.stringify({
      name: '@ai-ecoverse/mcpcat-test-stdio',
      version: '1.0.0',
      type: 'module',
      slicc: {
        commands: {
          'mcpcat-test-stdio': {
            abi: 'js',
            module: 'dist/server.mjs',
          },
        },
      },
    })
  );
}

async function installGrandchildFixtures(kernel) {
  const gcData = readFileSync(join(fixturesDir, 'kernel-stdio-grandchild.mjs'));
  await kernel.writeFile('/node_modules/@ai-ecoverse/mcpcat-test-gc/dist/server.mjs', gcData);
  await kernel.writeFile(
    '/node_modules/@ai-ecoverse/mcpcat-test-gc/package.json',
    JSON.stringify({
      name: '@ai-ecoverse/mcpcat-test-gc',
      version: '1.0.0',
      type: 'module',
      slicc: {
        commands: {
          'mcpcat-test-gc': {
            abi: 'js',
            module: 'dist/server.mjs',
          },
        },
      },
    })
  );

  const sleeperData = readFileSync(join(fixturesDir, 'kernel-sleeper.mjs'));
  await kernel.writeFile(
    '/node_modules/@ai-ecoverse/mcpcat-test-sleeper/dist/main.mjs',
    sleeperData
  );
  await kernel.writeFile(
    '/node_modules/@ai-ecoverse/mcpcat-test-sleeper/package.json',
    JSON.stringify({
      name: '@ai-ecoverse/mcpcat-test-sleeper',
      version: '1.0.0',
      type: 'module',
      slicc: {
        commands: {
          'mcpcat-test-sleeper': {
            abi: 'js',
            module: 'dist/main.mjs',
          },
        },
      },
    })
  );
}

describe('kernel: mcpcat', () => {
  let kernel;

  before(async () => {
    kernel = await createNodeKernel({});
    await installMcpcat(kernel);
  });

  after(() => {
    kernel?.terminate();
  });

  it('--version prints the package.json version', async () => {
    const { status, stdout } = await kernel.run(['mcpcat', '--version'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assert.equal(status, 0);
    assert.equal(stdout.trim(), pkg.version);
  });

  it('-V prints the version', async () => {
    const { status, stdout } = await kernel.run(['mcpcat', '-V'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assert.equal(status, 0);
    assert.equal(stdout.trim(), pkg.version);
  });

  it('--help prints help text', async () => {
    const { status, stdout } = await kernel.run(['mcpcat', '--help'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assert.equal(status, 0);
    assert.ok(stdout.includes('mcpcat'));
    assert.ok(stdout.includes('Usage:'));
  });

  it('unknown command exits 2', async () => {
    const { status, stderr } = await kernel.run(['mcpcat', 'bogus'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assert.equal(status, 2);
    assert.ok(stderr.includes('unknown target'));
  });

  it('--version output matches host', async () => {
    const hostOut = exec('node', [hostBin, '--version'], {
      encoding: 'utf8',
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    }).trim();

    const { stdout } = await kernel.run(['mcpcat', '--version'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    assert.equal(stdout.trim(), hostOut);
  });

  it('--help output matches host', async () => {
    const hostOut = exec('node', [hostBin, '--help'], {
      encoding: 'utf8',
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    }).trim();

    const { stdout } = await kernel.run(['mcpcat', '--help'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    assert.equal(stdout.trim(), hostOut);
  });
});

describe('kernel: HTTP client via transport', () => {
  let kernel;
  let server;

  before(async () => {
    server = await startFixtureServer('server-2026-http.mjs');
    kernel = await createNodeKernel({
      network: { transport: nodeTransport() },
    });
    await installMcpcat(kernel);
  });

  after(() => {
    server?.child.kill('SIGTERM');
    kernel?.terminate();
  });

  it('info shows server details', async () => {
    const url = `http://127.0.0.1:${server.port}`;
    const { status, stdout, stderr } = await kernel.run(['mcpcat', 'info', url], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assert.equal(status, 0, `stderr: ${stderr}`);
    assert.ok(stdout.includes('test-2026'));
    assert.ok(stdout.includes('2026-07-28'));
  });

  it('tools lists tools', async () => {
    const url = `http://127.0.0.1:${server.port}`;
    const { status, stdout, stderr } = await kernel.run(['mcpcat', 'tools', url], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assert.equal(status, 0, `stderr: ${stderr}`);
    assert.ok(stdout.includes('echo'));
    assert.ok(stdout.includes('add'));
  });

  it('call invokes a tool', async () => {
    const url = `http://127.0.0.1:${server.port}`;
    const { status, stdout, stderr } = await kernel.run(
      ['mcpcat', 'call', url, 'echo', '-d', '{"message":"kernel hello"}'],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    assert.equal(status, 0, `stderr: ${stderr}`);
    assert.ok(stdout.includes('kernel hello'));
  });

  it('call with add tool', async () => {
    const url = `http://127.0.0.1:${server.port}`;
    const { status, stdout, stderr } = await kernel.run(
      ['mcpcat', 'call', url, 'add', '-d', '{"a":10,"b":20}'],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    assert.equal(status, 0, `stderr: ${stderr}`);
    assert.ok(stdout.includes('30'));
  });

  it('describe shows tool schema', async () => {
    const url = `http://127.0.0.1:${server.port}`;
    const { status, stdout, stderr } = await kernel.run(['mcpcat', 'describe', url, 'echo'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assert.equal(status, 0, `stderr: ${stderr}`);
    assert.ok(stdout.includes('echo'));
    assert.ok(stdout.includes('message'));
  });
});

describe('kernel: legacy HTTP via transport', () => {
  let kernel;
  let server;

  before(async () => {
    server = await startFixtureServer('server-legacy-http.mjs');
    kernel = await createNodeKernel({
      network: { transport: nodeTransport() },
    });
    await installMcpcat(kernel);
  });

  after(() => {
    server?.child.kill('SIGTERM');
    kernel?.terminate();
  });

  it('info shows server details via fallback', async () => {
    const url = `http://127.0.0.1:${server.port}`;
    const { status, stdout, stderr } = await kernel.run(['mcpcat', 'info', url], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assert.equal(status, 0, `stderr: ${stderr}`);
    assert.ok(stdout.includes('test-legacy'));
    assert.ok(stdout.includes('2025-11-25'));
  });

  it('tools lists tools', async () => {
    const url = `http://127.0.0.1:${server.port}`;
    const { status, stdout, stderr } = await kernel.run(['mcpcat', 'tools', url], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assert.equal(status, 0, `stderr: ${stderr}`);
    assert.ok(stdout.includes('echo'));
    assert.ok(stdout.includes('add'));
  });

  it('call invokes a tool', async () => {
    const url = `http://127.0.0.1:${server.port}`;
    const { status, stdout, stderr } = await kernel.run(
      ['mcpcat', 'call', url, 'echo', '-d', '{"message":"legacy kernel hello"}'],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    assert.equal(status, 0, `stderr: ${stderr}`);
    assert.ok(stdout.includes('legacy kernel hello'));
  });
});

describe('kernel: legacy HTTP SSE via transport', () => {
  let kernel;
  let server;

  before(async () => {
    server = await startFixtureServer('server-legacy-http.mjs', ['--sse']);
    kernel = await createNodeKernel({
      network: { transport: nodeTransport() },
    });
    await installMcpcat(kernel);
  });

  after(() => {
    server?.child.kill('SIGTERM');
    kernel?.terminate();
  });

  it('info works over SSE', async () => {
    const url = `http://127.0.0.1:${server.port}`;
    const { status, stdout, stderr } = await kernel.run(['mcpcat', 'info', url], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assert.equal(status, 0, `stderr: ${stderr}`);
    assert.ok(stdout.includes('test-legacy'));
  });

  it('call works over SSE', async () => {
    const url = `http://127.0.0.1:${server.port}`;
    const { status, stdout, stderr } = await kernel.run(
      ['mcpcat', 'call', url, 'echo', '-d', '{"message":"sse kernel hello"}'],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    assert.equal(status, 0, `stderr: ${stderr}`);
    assert.ok(stdout.includes('sse kernel hello'));
  });
});

describe('kernel: stdio client', () => {
  let kernel;

  before(async () => {
    kernel = await createNodeKernel({});
    await installMcpcat(kernel);
    await installStdioFixture(kernel);
  });

  after(() => {
    kernel?.terminate();
  });

  it('info via stdio: prefix', async () => {
    const { status, stdout, stderr } = await kernel.run(
      ['mcpcat', 'info', 'stdio:mcpcat-test-stdio'],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    assert.equal(status, 0, `stderr: ${stderr}`);
    assert.ok(stdout.includes('test-kernel-stdio'));
  });

  it('tools via trailing --', async () => {
    const { status, stdout, stderr } = await kernel.run(
      ['mcpcat', 'tools', '--', 'mcpcat-test-stdio'],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    assert.equal(status, 0, `stderr: ${stderr}`);
    assert.ok(stdout.includes('echo'));
    assert.ok(stdout.includes('add'));
  });

  it('call via stdio: prefix', async () => {
    const { status, stdout, stderr } = await kernel.run(
      [
        'mcpcat',
        'call',
        'stdio:mcpcat-test-stdio',
        'echo',
        '-d',
        '{"message":"kernel stdio test"}',
      ],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    assert.equal(status, 0, `stderr: ${stderr}`);
    assert.ok(stdout.includes('kernel stdio test'));
  });

  it('call add via stdio', async () => {
    const { status, stdout, stderr } = await kernel.run(
      ['mcpcat', 'call', 'stdio:mcpcat-test-stdio', 'add', '-d', '{"a":5,"b":7}'],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    assert.equal(status, 0, `stderr: ${stderr}`);
    assert.ok(stdout.includes('12'));
  });
});

describe('kernel: stdio process group cleanup', () => {
  let kernel;
  let client;

  before(async () => {
    kernel = await createNodeKernel({});
    await installMcpcat(kernel);
    await installGrandchildFixtures(kernel);
    const port = await kernel.connect();
    client = await attachKernel(port);
  });

  after(() => {
    client?.close();
    kernel?.terminate();
  });

  it('server is gone after mcpcat exits', async () => {
    const pidsResult = await kernel.run(
      ['mcpcat', 'call', 'stdio:mcpcat-test-gc', 'pids', '-d', '{}'],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    assert.equal(pidsResult.status, 0, `stderr: ${pidsResult.stderr}`);
    const pids = JSON.parse(pidsResult.stdout.trim());
    const serverPid = pids.server;
    const grandchildPid = pids.grandchild;
    assert.ok(serverPid > 0, 'server pid should be positive');
    assert.ok(grandchildPid > 0, 'grandchild pid should be positive');

    await sleep(500);

    const ps = await client.ps();
    const alivePids = new Set(ps.map((p) => p.pid));
    assert.ok(!alivePids.has(serverPid), `server pid ${serverPid} should be dead`);
  });
});
describe('kernel: discover', () => {
  let kernel;
  let server;

  before(async () => {
    server = await startFixtureServer('server-2026-http.mjs');
    kernel = await createNodeKernel({
      network: { transport: nodeTransport() },
    });
    await installMcpcat(kernel);
  });

  after(() => {
    server?.child.kill('SIGTERM');
    kernel?.terminate();
  });

  it('discovers MCP server via kernel fetch', async () => {
    const url = `http://127.0.0.1:${server.port}`;
    const { status, stdout, stderr } = await kernel.run(['mcpcat', 'discover', url], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assert.equal(status, 0, `stderr: ${stderr}`);
    assert.ok(stdout.includes('mcp'), 'should find MCP standard');
  });

  it('handles redirect in kernel (redirect: follow fallback)', async () => {
    const { status } = await kernel.run(['mcpcat', 'discover', 'http://127.0.0.1:1'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assert.equal(status, 0, 'should exit 0 even with unreachable URL');
  });
});

describe('kernel: login/logout exits 4 in seven', () => {
  let kernel;

  before(async () => {
    kernel = await createNodeKernel({});
    await installMcpcat(kernel);
  });

  after(() => {
    kernel?.terminate();
  });

  it('login exits 4 with pointer to agent sign-in', async () => {
    const { status, stderr } = await kernel.run(['mcpcat', 'login', 'example.com'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assert.equal(status, 4);
    assert.ok(stderr.includes('not available in seven'));
  });

  it('logout exits 4 in seven', async () => {
    const { status, stderr } = await kernel.run(['mcpcat', 'logout', 'example.com'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assert.equal(status, 4);
    assert.ok(stderr.includes('not available in seven'));
  });
});
