import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mcpcatArgs } from './helpers/bin.mjs';
import { attachKernel, createNodeKernel } from './helpers/kernel.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const fixturesDir = join(root, 'test/integration/fixtures');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

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

function startKernelServe(client, argv) {
  const dec = new TextDecoder();
  let stdout = '';
  let stderr = '';
  let resolveLine;
  const firstLine = new Promise((resolve) => {
    resolveLine = resolve;
  });
  const check = () => {
    const nl = stdout.indexOf('\n');
    if (nl >= 0 && stderr.includes('listening on')) resolveLine(stdout.slice(0, nl));
  };
  const sp = client.spawn(argv, {
    stdin: 'pipe',
    onStdout(chunk) {
      stdout += dec.decode(chunk, { stream: true });
      check();
    },
    onStderr(chunk) {
      stderr += dec.decode(chunk, { stream: true });
      check();
    },
  });
  return {
    spawned: sp,
    line: firstLine,
    stderr: () => stderr,
  };
}

async function stopKernelServe(handle) {
  const sp = await handle.spawned;
  sp.signal('SIGTERM');
  await sp.exited;
}

describe('kernel: serve prints the <port>.kernel.localhost URL', () => {
  let kernel;
  let client;
  let serve;
  let proxy;
  let address;
  let proxyAddress;

  before(async () => {
    kernel = await createNodeKernel({});
    await installPackage(
      kernel,
      '@ai-ecoverse/mcpcat',
      'mcpcat',
      'dist/kernel/mcpcat.mjs',
      readFileSync(join(root, 'dist/kernel/mcpcat.mjs'))
    );
    await installPackage(
      kernel,
      '@ai-ecoverse/mcpcat-test-stdio',
      'mcpcat-test-stdio',
      'dist/server.mjs',
      readFileSync(join(fixturesDir, 'kernel-stdio-server.mjs'))
    );
    client = await attachKernel(await kernel.connect());
    serve = startKernelServe(client, [
      'mcpcat',
      'serve',
      '--http',
      '0',
      '--no-auth',
      '--json',
      '--tool',
      'greet:echo hello {name}',
    ]);
    address = JSON.parse(await serve.line);
    proxy = startKernelServe(client, [
      'mcpcat',
      'serve',
      '--proxy',
      'stdio:mcpcat-test-stdio',
      '--http',
      '0',
      '--no-auth',
      '--json',
    ]);
    proxyAddress = JSON.parse(await proxy.line);
  });

  after(async () => {
    if (serve) await stopKernelServe(serve);
    if (proxy) await stopKernelServe(proxy);
    client?.close();
    kernel?.terminate();
  });

  it('serve --http --json emits url as <port>.kernel.localhost and loopbackUrl as 127.0.0.1', () => {
    const port = Number(/^http:\/\/(\d+)\.kernel\.localhost\/mcp$/.exec(address.url)?.[1]);
    assert.ok(port > 0, `url: ${address.url}`);
    assert.equal(address.loopbackUrl, `http://127.0.0.1:${port}/mcp`);
    assert.ok(
      serve.stderr().includes(`listening on http://${port}.kernel.localhost/mcp`),
      serve.stderr()
    );
    assert.ok(!serve.stderr().includes('127.0.0.1'), serve.stderr());
  });

  it('serve --proxy --json emits url as <port>.kernel.localhost and loopbackUrl as 127.0.0.1', () => {
    const port = Number(/^http:\/\/(\d+)\.kernel\.localhost\/mcp$/.exec(proxyAddress.url)?.[1]);
    assert.ok(port > 0, `url: ${proxyAddress.url}`);
    assert.equal(proxyAddress.loopbackUrl, `http://127.0.0.1:${port}/mcp`);
    assert.ok(
      proxy.stderr().includes(`listening on http://${port}.kernel.localhost/mcp`),
      proxy.stderr()
    );
  });

  for (const form of ['url', 'loopbackUrl']) {
    it(`mcpcat in the kernel reaches serve through its ${form}`, async () => {
      const { status, stdout, stderr } = await kernel.run(['mcpcat', 'tools', address[form]], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      assert.equal(status, 0, `stderr: ${stderr}`);
      assert.ok(stdout.includes('greet'), stdout);
    });

    it(`mcpcat in the kernel calls through serve --proxy at its ${form}`, async () => {
      const { status, stdout, stderr } = await kernel.run(
        ['mcpcat', 'call', proxyAddress[form], 'echo', '-d', '{"message":"via proxy"}'],
        { stdout: 'pipe', stderr: 'pipe' }
      );
      assert.equal(status, 0, `stderr: ${stderr}`);
      assert.ok(stdout.includes('via proxy'), stdout);
    });
  }

  it('localhost:<port> also reaches a kernel listener', async () => {
    const port = new URL(address.loopbackUrl).port;
    const { status, stdout, stderr } = await kernel.run(
      ['mcpcat', 'tools', `http://localhost:${port}/mcp`],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    assert.equal(status, 0, `stderr: ${stderr}`);
    assert.ok(stdout.includes('greet'), stdout);
  });
});

describe('host: serve keeps the 127.0.0.1 URL', () => {
  it('serve --http --json emits a 127.0.0.1 url and no loopbackUrl', async () => {
    const { cmd, args } = mcpcatArgs([
      'serve',
      '--http',
      '0',
      '--no-auth',
      '--json',
      '--tool',
      'greet:echo hello {name}',
    ]);
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    try {
      const line = await new Promise((resolve, reject) => {
        let data = '';
        child.stdout.on('data', (chunk) => {
          data += chunk.toString();
          const nl = data.indexOf('\n');
          if (nl >= 0) resolve(data.slice(0, nl));
        });
        child.on('error', reject);
        child.on('exit', (code) => reject(new Error(`serve exited ${code}`)));
      });
      const address = JSON.parse(line);
      assert.match(address.url, /^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      assert.equal(address.loopbackUrl, undefined);
    } finally {
      child.kill('SIGTERM');
    }
  });
});
