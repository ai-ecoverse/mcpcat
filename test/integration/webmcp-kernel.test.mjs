import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startFakeCdp } from './helpers/fake-cdp.mjs';
import { createNodeKernel, hostUrl, nodeTransport } from './helpers/kernel.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

async function install(kernel, dir, commands, file, data) {
  await kernel.writeFile(`/node_modules/@ai-ecoverse/${dir}/${file}`, data);
  await kernel.writeFile(
    `/node_modules/@ai-ecoverse/${dir}/package.json`,
    JSON.stringify({
      name: `@ai-ecoverse/${dir}`,
      version: pkg.version,
      type: 'module',
      slicc: { commands },
    })
  );
}

const rpc = (method, params, id) => JSON.stringify({ jsonrpc: '2.0', id, method, params });

describe('kernel: serve --webmcp sees a JavaScript dialog through ctx.websocket', () => {
  let kernel;
  let cdp;

  before(async () => {
    cdp = await startFakeCdp();
    kernel = await createNodeKernel({
      network: { transport: nodeTransport({ hostLoopback: true }) },
    });
    await install(
      kernel,
      'mcpcat',
      { mcpcat: { abi: 'js', module: 'dist/kernel/mcpcat.mjs' } },
      'dist/kernel/mcpcat.mjs',
      readFileSync(join(root, 'dist/kernel/mcpcat.mjs'))
    );
    await install(
      kernel,
      'mcpcat-test-pwcli',
      { 'kernel-pwcli': { abi: 'js', module: 'dist/pwcli.mjs' } },
      'dist/pwcli.mjs',
      readFileSync(join(root, 'test/integration/fixtures/kernel-fake-playwright-cli.mjs'))
    );
  });

  after(async () => {
    kernel?.terminate();
    await cdp?.close();
  });

  it('a call that opens a dialog fails fast with the dialog named', async () => {
    const base = hostUrl(new URL(cdp.url).port);
    const ws = `${base.replace(/^http/, 'ws')}/devtools/browser/fake`;
    const started = Date.now();
    const r = await kernel.run(
      ['mcpcat', 'serve', '--webmcp', '--cdp', ws, '--playwright-cli', 'kernel-pwcli'],
      {
        stdout: 'pipe',
        stderr: 'pipe',
        env: { FAKE_PWCLI_DIALOG_URL: `${base}/dialog` },
        stdin: `${rpc('tools/call', { name: 'get_price', arguments: { productId: 'a' } }, 1)}\n`,
      }
    );
    assert.equal(r.status, 0, r.stderr);
    const reply = JSON.parse(r.stdout.trim().split('\n')[0]);
    assert.match(reply.error.message, /^tab TAB1 is blocked by a JavaScript confirm dialog/);
    assert.ok(Date.now() - started < 20_000);
    assert.ok(
      cdp.seen.some((m) => m.method === 'Target.attachToTarget' && m.params.targetId === 'TAB1')
    );
  });
});
