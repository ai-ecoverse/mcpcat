import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel, fetchTransport } from './helpers/kernel.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const TARGET = 'https://mcp.example.test/mcp';

async function installMcpcat(kernel) {
  await kernel.writeFile(
    '/node_modules/@ai-ecoverse/mcpcat/dist/kernel/mcpcat.mjs',
    readFileSync(join(root, 'dist/kernel/mcpcat.mjs'))
  );
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

describe('kernel: a transport that answers 502 for a server without CORS', () => {
  let kernel;
  let attempts = 0;

  before(async () => {
    const badGateway = async () => {
      attempts += 1;
      return new Response(`fetch ${TARGET} failed (not allowed by CORS)`, {
        status: 502,
        statusText: 'Bad Gateway',
        headers: { 'content-type': 'text/plain' },
      });
    };
    kernel = await createNodeKernel({
      network: { transport: fetchTransport({ fetch: badGateway }) },
    });
    await installMcpcat(kernel);
  });

  after(() => {
    kernel?.terminate();
  });

  it('exits 3 and points at a linked slicc CLI, not the retired slicc-node or slicc-swift', async () => {
    const { status, stderr } = await kernel.run(['mcpcat', 'info', TARGET], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assert.ok(attempts > 0, 'the transport was never asked');
    assert.equal(status, 3, `stderr: ${stderr}`);
    assert.ok(stderr.includes('for servers without CORS'), `stderr: ${stderr}`);
    assert.ok(stderr.includes('npx sliccy@next'), `stderr: ${stderr}`);
    assert.ok(stderr.includes('browser extension'), `stderr: ${stderr}`);
    assert.ok(!stderr.includes('slicc-node'), `stderr: ${stderr}`);
    assert.ok(!stderr.includes('slicc-swift'), `stderr: ${stderr}`);
  });

  it('--json carries the same hint in the connection error', async () => {
    const { status, stderr } = await kernel.run(['mcpcat', 'info', '--json', TARGET], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assert.equal(status, 3, `stderr: ${stderr}`);
    const { error } = JSON.parse(stderr);
    assert.ok(error.message.includes('npx sliccy@next'), stderr);
    assert.ok(!error.message.includes('slicc-node'), stderr);
  });
});

describe('kernel: a page transport whose fetch fails the way a CORS block does', () => {
  let kernel;
  const asked = [];

  before(async () => {
    const blocked = async (url) => {
      asked.push(String(url));
      throw new TypeError('Failed to fetch');
    };
    kernel = await createNodeKernel({
      network: { transport: fetchTransport({ fetch: blocked }) },
    });
    await installMcpcat(kernel);
  });

  after(() => {
    kernel?.terminate();
  });

  it('exits 3 and points at a linked slicc CLI for a remote https server', async () => {
    const { status, stderr } = await kernel.run(['mcpcat', 'info', TARGET], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assert.ok(asked.includes(TARGET), `asked: ${asked.join(' ')}`);
    assert.equal(status, 3, `stderr: ${stderr}`);
    assert.ok(stderr.includes('for servers without CORS'), `stderr: ${stderr}`);
    assert.ok(stderr.includes('npx sliccy@next'), `stderr: ${stderr}`);
    assert.ok(stderr.includes('browser extension'), `stderr: ${stderr}`);
    assert.ok(stderr.includes('fetch failed'), `stderr: ${stderr}`);
  });

  it('--json carries the same hint in the connection error', async () => {
    const { status, stderr } = await kernel.run(['mcpcat', 'info', '--json', TARGET], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assert.equal(status, 3, `stderr: ${stderr}`);
    const { error } = JSON.parse(stderr);
    assert.equal(error.kind, 'connection', stderr);
    assert.ok(error.message.includes('for servers without CORS'), stderr);
    assert.ok(error.message.includes('npx sliccy@next'), stderr);
  });

  for (const url of [
    'http://host.slicc.internal:45991/mcp',
    'https://127.0.0.1:45991/mcp',
    'https://localhost:45991/mcp',
  ]) {
    it(`keeps the plain message for the loopback server ${url}`, async () => {
      const { status, stderr } = await kernel.run(['mcpcat', 'info', url], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      assert.equal(status, 3, `stderr: ${stderr}`);
      assert.equal(stderr, 'mcpcat: connection failed: fetch failed\n');
    });
  }
});
