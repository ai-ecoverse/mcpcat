import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from './helpers/kernel.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const fixture = join(root, 'test/integration/fixtures/kernel-control-chars.mjs');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const AGENT_DIR = '/etc/mcpcat-sanitize';
const EVIL = 'boom \x1b]0;pwned\x07 \x1b[2J \x9b31m end';
const CONTROL_RE = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;

async function installPackage(kernel, dir, name, commands, files) {
  for (const [path, data] of Object.entries(files)) {
    await kernel.writeFile(`/node_modules/@ai-ecoverse/${dir}/${path}`, data);
  }
  await kernel.writeFile(
    `/node_modules/@ai-ecoverse/${dir}/package.json`,
    JSON.stringify({ name, version: pkg.version, type: 'module', slicc: { commands } })
  );
}

function scriptCalling(suffix) {
  return `const n = ALL_TOOLS.find((t) => t.name.endsWith('__${suffix}')).name; await tools[n]({});`;
}

describe('kernel: server-supplied control characters in printed messages', () => {
  let kernel;

  before(async () => {
    kernel = await createNodeKernel({});
    await installPackage(
      kernel,
      'mcpcat',
      '@ai-ecoverse/mcpcat',
      { mcpcat: { abi: 'js', module: 'dist/kernel/mcpcat.mjs' } },
      {
        'dist/kernel/mcpcat.mjs': readFileSync(join(root, 'dist/kernel/mcpcat.mjs')),
        'dist/quickjs.wasm': readFileSync(join(root, 'dist/quickjs.wasm')),
      }
    );
    await installPackage(
      kernel,
      'mcpcat-test-evil',
      '@ai-ecoverse/mcpcat-test-evil',
      {
        'evil-srv': { abi: 'js', module: 'dist/evil.mjs' },
        'evil-pwcli': { abi: 'js', module: 'dist/evil.mjs' },
      },
      { 'dist/evil.mjs': readFileSync(fixture) }
    );
    await kernel.writeFile(
      `${AGENT_DIR}/mcp.json`,
      JSON.stringify({ mcpServers: { evil: { command: 'evil-srv' } } })
    );
  });

  after(() => kernel?.terminate());

  function run(args) {
    return kernel.run(['mcpcat', ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { PI_CODING_AGENT_DIR: AGENT_DIR },
    });
  }

  it('a tool error is printed without control characters', async () => {
    const r = await run(['call', 'evil', 'toolerr']);
    assert.equal(r.status, 1, r.stderr);
    assert.ok(r.stderr.includes('boom'), r.stderr);
    assert.ok(!CONTROL_RE.test(r.stderr), JSON.stringify(r.stderr));
  });

  it('a JSON-RPC error message is printed without control characters', async () => {
    const r = await run(['call', 'evil', 'rpcerr']);
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes('pwned'), r.stderr);
    assert.ok(!CONTROL_RE.test(r.stderr), JSON.stringify(r.stderr));
  });

  it('--json keeps the JSON-RPC error message byte-exact', async () => {
    const r = await run(['call', '--json', 'evil', 'rpcerr']);
    assert.notEqual(r.status, 0);
    assert.ok(JSON.parse(r.stderr).error.message.includes(EVIL), r.stderr);
  });

  it('add reports a failed probe without control characters', async () => {
    const r = await run([
      'add',
      '--config',
      `${AGENT_DIR}/add-probe.json`,
      'probe',
      '--',
      'evil-srv',
      '--fail-init',
    ]);
    assert.equal(r.status, 3, r.stderr);
    assert.ok(r.stderr.includes('mcpcat add: probe failed:'), r.stderr);
    assert.ok(r.stderr.includes('pwned'), r.stderr);
    assert.ok(!CONTROL_RE.test(r.stderr), JSON.stringify(r.stderr));
  });

  it('a code script whose tool call fails is reported without control characters', async () => {
    const r = await run(['code', '-s', 'evil', '-e', scriptCalling('rpcerr')]);
    assert.equal(r.status, 1, r.stderr);
    assert.ok(r.stderr.includes('mcpcat: script failed: boom'), r.stderr);
    assert.ok(!CONTROL_RE.test(r.stderr), JSON.stringify(r.stderr));
  });

  it('code --json keeps the script failure byte-exact', async () => {
    const r = await run(['code', '--json', '-s', 'evil', '-e', scriptCalling('rpcerr')]);
    assert.equal(r.status, 1, r.stderr);
    assert.ok(JSON.parse(r.stdout).error.message.includes(EVIL), r.stdout);
  });

  it('serve --webmcp reports a playwright-cli failure without control characters', async () => {
    const r = await run(['serve', '--webmcp', '--playwright-cli', 'evil-pwcli']);
    assert.equal(r.status, 3, r.stderr);
    assert.ok(r.stderr.includes('mcpcat serve --webmcp: boom'), r.stderr);
    assert.ok(!CONTROL_RE.test(r.stderr), JSON.stringify(r.stderr));
  });
});
