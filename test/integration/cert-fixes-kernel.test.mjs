import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { attachKernel, createNodeKernel } from './helpers/kernel.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const kernelBundle = join(root, 'dist/kernel/mcpcat.mjs');
const wasmFile = join(root, 'dist/quickjs.wasm');
const fixturesDir = join(root, 'test/integration/fixtures');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const AGENT_DIR = '/etc/mcpcat-test';

async function installMcpcat(kernel) {
  const bundleData = readFileSync(kernelBundle);
  const wasmData = readFileSync(wasmFile);
  await kernel.writeFile('/node_modules/@ai-ecoverse/mcpcat/dist/kernel/mcpcat.mjs', bundleData);
  await kernel.writeFile('/node_modules/@ai-ecoverse/mcpcat/dist/quickjs.wasm', wasmData);
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

async function installFixture(kernel, name, pkgName, file) {
  const data = readFileSync(join(fixturesDir, file));
  await kernel.writeFile(`/node_modules/@ai-ecoverse/${pkgName}/dist/server.mjs`, data);
  await kernel.writeFile(
    `/node_modules/@ai-ecoverse/${pkgName}/package.json`,
    JSON.stringify({
      name: `@ai-ecoverse/${pkgName}`,
      version: '1.0.0',
      type: 'module',
      slicc: {
        commands: { [name]: { abi: 'js', module: 'dist/server.mjs' } },
      },
    })
  );
}

async function writeMcpJson(kernel, config) {
  await kernel.writeFile(`${AGENT_DIR}/mcp.json`, JSON.stringify(config, null, 2));
}

function runOpts() {
  return { stdout: 'pipe', stderr: 'pipe', env: { PI_CODING_AGENT_DIR: AGENT_DIR } };
}

describe('kernel: group SIGINT exits 130, not 141 (cert item 5)', () => {
  let kernel;
  let client;

  before(async () => {
    kernel = await createNodeKernel({
      network: { transport: (await import('@ai-ecoverse/slicc-kernel/node')).nodeTransport() },
    });
    await installMcpcat(kernel);
    await installFixture(kernel, 'mcpcat-test-slow', 'mcpcat-test-slow', 'kernel-stdio-slow.mjs');
    await writeMcpJson(kernel, {
      mcpServers: { slow: { command: 'mcpcat-test-slow' } },
    });
    const port = await kernel.connect();
    client = await attachKernel(port);
  });

  after(() => {
    client?.close();
    kernel?.terminate();
  });

  it('SIGINT on kernel mcpcat yields exit 130', async () => {
    const proc = await client.spawn(
      ['mcpcat', 'call', 'stdio:mcpcat-test-slow', 'slow', '-d', '{"ms":30000}'],
      { stdout: 'pipe', stderr: 'pipe', env: { PI_CODING_AGENT_DIR: AGENT_DIR } }
    );

    await new Promise((r) => setTimeout(r, 1500));

    try {
      await client.kill(-proc.pid, 'SIGINT');
    } catch {
      await client.kill(proc.pid, 'SIGINT');
    }

    const code = await proc.exited;
    assert.equal(code, 130, `expected exit 130, got ${code}`);
  });
});

describe('kernel: codemode memory limit (cert item 1)', () => {
  let kernel;

  before(async () => {
    kernel = await createNodeKernel({});
    await installMcpcat(kernel);
    await installFixture(kernel, 'alpha-srv', 'mcpcat-test-alpha', 'kernel-codemode-alpha.mjs');
    await writeMcpJson(kernel, {
      mcpServers: { alpha: { command: 'alpha-srv' } },
    });
  });

  after(() => kernel?.terminate());

  it('runaway allocation fails cleanly', async () => {
    const script =
      'const a=[]; for(let i=0;i<100000;i++){a.push(new Array(100000).fill(i));} return a.length;';
    const { status, stdout, stderr } = await kernel.run(
      ['mcpcat', 'code', '--json', '-s', 'alpha', '-e', script],
      runOpts()
    );
    assert.ok(
      status === 1 || status === 124,
      `expected 1 or 124, got ${status}; stderr: ${stderr}`
    );
    const combined = stdout + stderr;
    assert.ok(
      combined.includes('memory') || combined.includes('out of memory'),
      `should mention memory: ${combined.slice(0, 300)}`
    );
  });
});

describe('kernel: script cannot extend deadline (cert item 2)', () => {
  let kernel;

  before(async () => {
    kernel = await createNodeKernel({});
    await installMcpcat(kernel);
    await installFixture(kernel, 'alpha-srv', 'mcpcat-test-alpha', 'kernel-codemode-alpha.mjs');
    await writeMcpJson(kernel, {
      mcpServers: { alpha: { command: 'alpha-srv' } },
    });
  });

  after(() => kernel?.terminate());

  it('script timeout_ms cannot exceed -m', async () => {
    const script = '// @options: {"timeout_ms": 300000}\nwhile(true){}';
    const { status, stderr } = await kernel.run(
      ['mcpcat', 'code', '-s', 'alpha', '-m', '1', '-e', script],
      runOpts()
    );
    assert.equal(status, 124, `expected 124, got ${status}; stderr: ${stderr}`);
  });
});
