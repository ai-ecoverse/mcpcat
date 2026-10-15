import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from './helpers/kernel.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const fixturesDir = join(root, 'test/integration/fixtures');
const AGENT_DIR = '/etc/mcpcat-test';
const SLACK_MS = 2000;

async function install(kernel) {
  await kernel.writeFile(
    '/node_modules/@ai-ecoverse/mcpcat/dist/kernel/mcpcat.mjs',
    readFileSync(join(root, 'dist/kernel/mcpcat.mjs'))
  );
  await kernel.writeFile(
    '/node_modules/@ai-ecoverse/mcpcat/dist/quickjs.wasm',
    readFileSync(join(root, 'dist/quickjs.wasm'))
  );
  await kernel.writeFile(
    '/node_modules/@ai-ecoverse/mcpcat/package.json',
    JSON.stringify({
      name: '@ai-ecoverse/mcpcat',
      version: '0.0.0',
      type: 'module',
      slicc: { commands: { mcpcat: { abi: 'js', module: 'dist/kernel/mcpcat.mjs' } } },
    })
  );
  await kernel.writeFile(
    '/node_modules/@ai-ecoverse/mcpcat-test-alpha/dist/server.mjs',
    readFileSync(join(fixturesDir, 'kernel-codemode-alpha.mjs'))
  );
  await kernel.writeFile(
    '/node_modules/@ai-ecoverse/mcpcat-test-alpha/package.json',
    JSON.stringify({
      name: '@ai-ecoverse/mcpcat-test-alpha',
      version: '1.0.0',
      type: 'module',
      slicc: { commands: { 'alpha-srv': { abi: 'js', module: 'dist/server.mjs' } } },
    })
  );
  await kernel.writeFile(
    `${AGENT_DIR}/mcp.json`,
    JSON.stringify({ mcpServers: { alpha: { command: 'alpha-srv' } } })
  );
}

describe('kernel: code deadline bounds a CPU-bound script by wall time', () => {
  let kernel;

  before(async () => {
    kernel = await createNodeKernel({});
    await install(kernel);
  });

  after(() => kernel?.terminate());

  async function timed(args) {
    const started = Date.now();
    const result = await kernel.run(['mcpcat', 'code', '-s', 'alpha', ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { PI_CODING_AGENT_DIR: AGENT_DIR },
    });
    return { ...result, elapsed: Date.now() - started };
  }

  async function overhead() {
    const { status, stderr, elapsed } = await timed(['-m', '1', '-e', 'return 1']);
    assert.equal(status, 0, `stderr: ${stderr}`);
    return elapsed;
  }

  it('-m 1 stops while(true){} within 2 s of the deadline', async () => {
    const base = await overhead();
    const { status, stderr, elapsed } = await timed(['-m', '1', '-e', 'while(true){}']);
    assert.equal(status, 124, `stderr: ${stderr}`);
    assert.match(stderr, /^mcpcat: script failed: Execution timed out after 1000 ms$/m);
    assert.ok(
      elapsed - base < 1000 + SLACK_MS,
      `took ${elapsed} ms against ${base} ms for a trivial script`
    );
  });

  it('-m 1 stops a loop of promise jobs within 2 s of the deadline', async () => {
    const base = await overhead();
    const { status, stderr, elapsed } = await timed(['-m', '1', '-e', 'for(;;) await null']);
    assert.equal(status, 124, `stderr: ${stderr}`);
    assert.match(stderr, /Execution timed out after 1000 ms/);
    assert.ok(
      elapsed - base < 1000 + SLACK_MS,
      `took ${elapsed} ms against ${base} ms for a trivial script`
    );
  });

  it('a script timeout_ms shorter than -m stops it by wall time', async () => {
    const base = await overhead();
    const script = '// @options: {"timeout_ms": 1000}\nwhile(true){}';
    const { status, stderr, elapsed } = await timed(['-m', '300', '-e', script]);
    assert.equal(status, 124, `stderr: ${stderr}`);
    assert.match(stderr, /Execution timed out after 1000 ms/);
    assert.ok(
      elapsed - base < 1000 + SLACK_MS,
      `took ${elapsed} ms against ${base} ms for a trivial script`
    );
  });

  it('timeout_ms cannot extend -m', async () => {
    const base = await overhead();
    const script = '// @options: {"timeout_ms": 300000}\nwhile(true){}';
    const { status, stderr, elapsed } = await timed(['-m', '1', '-e', script]);
    assert.equal(status, 124, `stderr: ${stderr}`);
    assert.ok(
      elapsed - base < 1000 + SLACK_MS,
      `took ${elapsed} ms against ${base} ms for a trivial script`
    );
  });
});
