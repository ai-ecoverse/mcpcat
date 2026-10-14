import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { attachKernel, createNodeKernel, nodeTransport } from './helpers/kernel.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const kernelBundle = join(root, 'dist/kernel/mcpcat.mjs');
const fixturesDir = join(root, 'test/integration/fixtures');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const kernelPkgPath = process.env.MCPCAT_CERT_KERNEL_DIR
  ? join(process.env.MCPCAT_CERT_KERNEL_DIR, 'package.json')
  : join(root, 'node_modules/@ai-ecoverse/slicc-kernel/package.json');
const kernelPkg = JSON.parse(readFileSync(kernelPkgPath, 'utf8'));
const kernelVersion = kernelPkg.version.split('.').map(Number);
const hasSealed = kernelVersion[0] > 1 || (kernelVersion[0] === 1 && kernelVersion[1] >= 85);

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
          mcpcat: { abi: 'js', module: 'dist/kernel/mcpcat.mjs' },
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
          'mcpcat-test-stdio': { abi: 'js', module: 'dist/server.mjs' },
        },
      },
    })
  );
}

describe('kernel: add --bridge with real /dev/sealed (vault backing)', {
  skip: !hasSealed && 'requires slicc-kernel >= 1.85.0',
}, () => {
  let kernel;
  let client;
  const sealRequests = [];

  before(async () => {
    kernel = await createNodeKernel({
      sealed: async (req) => {
        sealRequests.push(structuredClone(req));
        if (req.op === 'seal') {
          return { placeholder: '${' + req.name + '}' };
        }
        return { error: 'unknown op', errno: 'EINVAL' };
      },
    });
    await installMcpcat(kernel);
    await installStdioFixture(kernel);
    await kernel.writeFile('/mcp.json', '{}');
    const port = await kernel.connect();
    client = await attachKernel(port);
  });

  after(() => {
    client?.close();
    kernel?.terminate();
  });

  it('seals a bridge token and writes the correct mcp.json entry', async () => {
    sealRequests.length = 0;

    const sp = await client.spawn(
      ['mcpcat', 'add', 'myserver', '--bridge', '--config', '/mcp.json', '--', 'mcpcat-test-stdio'],
      {
        stdin: 'pipe',
        onStdout() {},
        onStderr() {},
      }
    );

    await sleep(3000);

    assert.ok(sealRequests.length >= 1, 'sealed hook should have been called');
    const req = sealRequests[0];
    assert.equal(req.v, 1);
    assert.equal(req.op, 'seal');
    assert.equal(req.kind, 'mcp');
    assert.equal(req.name, 'MCP_MYSERVER_TOKEN');
    assert.equal(typeof req.value, 'string');
    assert.ok(req.value.length > 0, 'token value must not be empty');
    assert.equal(req.server, 'myserver');
    assert.ok(
      /^http:\/\/\d+\.kernel\.localhost\/mcp$/.test(req.url),
      `url should match kernel localhost pattern, got: ${req.url}`
    );
    assert.ok(req.caller, 'request should include a caller stamp');
    assert.equal(typeof req.caller.pid, 'number');
    assert.equal(typeof req.caller.uid, 'number');

    const raw = new TextDecoder().decode(await kernel.readFile('/mcp.json'));
    const config = JSON.parse(raw);
    const entry = config.mcpServers?.myserver;
    assert.ok(entry, 'mcp.json should contain myserver entry');
    assert.ok(entry.url.includes('.kernel.localhost/mcp'), 'url should use kernel localhost');
    assert.equal(
      entry.headers?.Authorization,
      'Bearer ${MCP_MYSERVER_TOKEN}',
      'Authorization header should use the sealed placeholder'
    );

    sp.signal('SIGTERM');
    await sp.exited;
  });

  it('bridge accepts the sealed token and rejects others', async () => {
    sealRequests.length = 0;

    const sp = await client.spawn(
      ['mcpcat', 'add', 'authtest', '--bridge', '--config', '/mcp.json', '--', 'mcpcat-test-stdio'],
      {
        stdin: 'pipe',
        onStdout() {},
        onStderr() {},
      }
    );

    await sleep(3000);

    assert.ok(sealRequests.length >= 1, 'sealed hook should have been called');
    const sealedToken = sealRequests[0].value;
    const urlMatch = sealRequests[0].url.match(/^http:\/\/(\d+)\.kernel\.localhost\/mcp$/);
    assert.ok(urlMatch, 'should have a kernel localhost URL');
    const bridgePort = Number(urlMatch[1]);

    const bridgeUrl = `http://${bridgePort}.kernel.localhost/mcp`;

    const goodResp = await kernel.run(
      ['mcpcat', 'info', '-H', `Authorization: Bearer ${sealedToken}`, bridgeUrl],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    assert.equal(goodResp.status, 0, `good token should succeed; stderr: ${goodResp.stderr}`);
    assert.ok(goodResp.stdout.includes('test-kernel-stdio'));

    const badResp = await kernel.run(
      ['mcpcat', 'info', '-H', 'Authorization: Bearer wrong-token-value', bridgeUrl],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    assert.notEqual(badResp.status, 0, 'bad token should be rejected');

    sp.signal('SIGTERM');
    await sp.exited;
  });
});

describe('kernel: add --bridge without vault (no sealed hook)', {
  skip: !hasSealed && 'requires slicc-kernel >= 1.85.0',
}, () => {
  let kernel;
  let client;

  before(async () => {
    kernel = await createNodeKernel({});
    await installMcpcat(kernel);
    await installStdioFixture(kernel);
    await kernel.writeFile('/mcp.json', '{}');
    const port = await kernel.connect();
    client = await attachKernel(port);
  });

  after(() => {
    client?.close();
    kernel?.terminate();
  });

  it('exits 4 with vault-not-available message and writes no token', async () => {
    const { status, stderr, stdout } = await kernel.run(
      [
        'mcpcat',
        'add',
        'novaulsrv',
        '--bridge',
        '--config',
        '/mcp.json',
        '--',
        'mcpcat-test-stdio',
      ],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    assert.equal(status, 4, `expected exit 4, got ${status}; stderr: ${stderr}`);
    assert.ok(
      stderr.includes('vault') || stderr.includes('not available'),
      `stderr should mention vault; got: ${stderr}`
    );

    assert.ok(!stdout.includes('MCP_NOVAULSRV_TOKEN'), 'stdout must not leak a token');
    assert.ok(!stderr.includes('MCP_NOVAULSRV_TOKEN'), 'stderr must not leak a token');

    const raw = new TextDecoder().decode(await kernel.readFile('/mcp.json'));
    const config = JSON.parse(raw);
    assert.ok(
      !config.mcpServers?.novaulsrv,
      'mcp.json should not contain the server when vault is unavailable'
    );
  });

  it('--no-auth bypasses the vault and starts the bridge', async () => {
    let stderrBuf = '';
    let stdoutBuf = '';
    const sp = await client.spawn(
      [
        'mcpcat',
        'add',
        'noauthsrv',
        '--bridge',
        '--no-auth',
        '--config',
        '/mcp.json',
        '--',
        'mcpcat-test-stdio',
      ],
      {
        stdin: 'pipe',
        onStdout(chunk) {
          stdoutBuf += new TextDecoder().decode(chunk);
        },
        onStderr(chunk) {
          stderrBuf += new TextDecoder().decode(chunk);
        },
      }
    );

    await sleep(3000);

    const raw = new TextDecoder().decode(await kernel.readFile('/mcp.json'));
    const config = JSON.parse(raw);
    assert.ok(config.mcpServers?.noauthsrv, 'mcp.json should contain noauthsrv');
    assert.ok(
      !config.mcpServers.noauthsrv.headers?.Authorization,
      '--no-auth entry should have no Authorization header'
    );

    sp.signal('SIGTERM');
    const exitStatus = await sp.exited;
    assert.ok(
      exitStatus === 0 || exitStatus === 143,
      `bridge should exit cleanly or via SIGTERM; got ${exitStatus}`
    );
  });
});

describe('kernel: add --bridge errno mapping via sealed hook', {
  skip: !hasSealed && 'requires slicc-kernel >= 1.85.0',
}, () => {
  it('EEXIST from vault maps to exit 2', async () => {
    const kernel = await createNodeKernel({
      sealed: async (req) => {
        return { error: 'already exists', errno: 'EEXIST' };
      },
    });
    try {
      await installMcpcat(kernel);
      await installStdioFixture(kernel);
      await kernel.writeFile('/mcp.json', '{}');

      const { status, stderr } = await kernel.run(
        [
          'mcpcat',
          'add',
          'existsrv',
          '--bridge',
          '--config',
          '/mcp.json',
          '--',
          'mcpcat-test-stdio',
        ],
        { stdout: 'pipe', stderr: 'pipe' }
      );
      assert.equal(status, 2, `EEXIST should map to exit 2; stderr: ${stderr}`);
    } finally {
      kernel.terminate();
    }
  });

  it('EACCES from vault maps to exit 4', async () => {
    const kernel = await createNodeKernel({
      sealed: async (req) => {
        return { error: 'vault locked', errno: 'EACCES' };
      },
    });
    try {
      await installMcpcat(kernel);
      await installStdioFixture(kernel);
      await kernel.writeFile('/mcp.json', '{}');

      const { status, stderr } = await kernel.run(
        [
          'mcpcat',
          'add',
          'lockedsrv',
          '--bridge',
          '--config',
          '/mcp.json',
          '--',
          'mcpcat-test-stdio',
        ],
        { stdout: 'pipe', stderr: 'pipe' }
      );
      assert.equal(status, 4, `EACCES should map to exit 4; stderr: ${stderr}`);
    } finally {
      kernel.terminate();
    }
  });

  it('ETIMEDOUT from vault maps to exit 4', async () => {
    const kernel = await createNodeKernel({
      sealed: async (req) => {
        return { error: { code: 'ETIMEDOUT', message: 'the vault did not answer within 10 s' } };
      },
    });
    try {
      await installMcpcat(kernel);
      await installStdioFixture(kernel);
      await kernel.writeFile('/mcp.json', '{}');

      const { status, stderr } = await kernel.run(
        [
          'mcpcat',
          'add',
          'timeoutsrv',
          '--bridge',
          '--config',
          '/mcp.json',
          '--',
          'mcpcat-test-stdio',
        ],
        { stdout: 'pipe', stderr: 'pipe' }
      );
      assert.equal(status, 4, `ETIMEDOUT should map to exit 4; stderr: ${stderr}`);
    } finally {
      kernel.terminate();
    }
  });

  it('ENOTCONN from vault (structured error) maps to exit 4', async () => {
    const kernel = await createNodeKernel({
      sealed: async (req) => {
        return { error: { code: 'ENOTCONN', message: 'no vault is connected' } };
      },
    });
    try {
      await installMcpcat(kernel);
      await installStdioFixture(kernel);
      await kernel.writeFile('/mcp.json', '{}');

      const { status, stderr } = await kernel.run(
        [
          'mcpcat',
          'add',
          'disconnsrv',
          '--bridge',
          '--config',
          '/mcp.json',
          '--',
          'mcpcat-test-stdio',
        ],
        { stdout: 'pipe', stderr: 'pipe' }
      );
      assert.equal(status, 4, `ENOTCONN should map to exit 4; stderr: ${stderr}`);
    } finally {
      kernel.terminate();
    }
  });
});

describe('kernel: add --bridge on old kernel (< 1.85.0)', {
  skip: hasSealed && 'this test is for kernels < 1.85.0',
}, () => {
  let kernel;

  before(async () => {
    kernel = await createNodeKernel({});
    await installMcpcat(kernel);
    await installStdioFixture(kernel);
    await kernel.writeFile('/mcp.json', '{}');
  });

  after(() => {
    kernel?.terminate();
  });

  it('exits 4 without --no-auth when /dev/sealed does not exist', async () => {
    const { status, stderr } = await kernel.run(
      ['mcpcat', 'add', 'oldsrv', '--bridge', '--config', '/mcp.json', '--', 'mcpcat-test-stdio'],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    assert.equal(status, 4, `expected exit 4 on old kernel; stderr: ${stderr}`);
  });
});

import { spawn } from 'node:child_process';

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

describe('kernel: transport 403 (loopback refused) exits 3, not 4', {
  skip: !hasSealed && 'requires slicc-kernel >= 1.85.0',
}, () => {
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

  it('exits 3 with transport reason, not exit 4 auth', async () => {
    const url = `http://127.0.0.1:${server.port}`;
    const { status, stderr } = await kernel.run(['mcpcat', 'info', url], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assert.equal(status, 3, `expected exit 3, got ${status}; stderr: ${stderr}`);
    assert.ok(
      stderr.includes('hostLoopback') || stderr.includes('loopback') || stderr.includes('refused'),
      `stderr should mention hostLoopback; got: ${stderr}`
    );
    assert.ok(!stderr.includes('mcpcat login'), 'should not suggest login for transport refusal');
  });
});

describe('kernel: transport 403 with hostLoopback enabled connects fine', {
  skip: !hasSealed && 'requires slicc-kernel >= 1.85.0',
}, () => {
  let kernel;
  let server;

  before(async () => {
    server = await startFixtureServer('server-2026-http.mjs');
    kernel = await createNodeKernel({
      network: { transport: nodeTransport({ hostLoopback: true }) },
    });
    await installMcpcat(kernel);
  });

  after(() => {
    server?.child.kill('SIGTERM');
    kernel?.terminate();
  });

  it('connects to loopback with hostLoopback enabled', async () => {
    const url = `http://127.0.0.1:${server.port}`;
    const { status, stdout, stderr } = await kernel.run(['mcpcat', 'info', url], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assert.equal(status, 0, `expected exit 0, got ${status}; stderr: ${stderr}`);
    assert.ok(stdout.includes('test-2026'));
  });
});
