import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from './helpers/kernel.mjs';

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

describe('kernel: serve --annotations', () => {
  let kernel;

  before(async () => {
    kernel = await createNodeKernel({});
    await install(
      kernel,
      'mcpcat',
      { mcpcat: { abi: 'js', module: 'dist/kernel/mcpcat.mjs' } },
      'dist/kernel/mcpcat.mjs',
      readFileSync(join(root, 'dist/kernel/mcpcat.mjs'))
    );
    await install(
      kernel,
      'mcpcat-test-attach',
      { 'kernel-attach': { abi: 'js', module: 'dist/attach.mjs' } },
      'dist/attach.mjs',
      readFileSync(join(root, 'test/integration/fixtures/kernel-fake-eval-attach.mjs'))
    );
  });

  after(() => {
    kernel?.terminate();
  });

  it('writes both page scripts to the VFS, attaches them and serves the saved annotation', async () => {
    const r = await kernel.run(
      [
        'mcpcat',
        '--experimental',
        'annotations',
        'serve',
        '--annotations',
        '--tab',
        'TAB1',
        '--playwright-cli',
        'kernel-attach',
      ],
      {
        stdout: 'pipe',
        stderr: 'pipe',
        stdin: `${rpc('tools/call', { name: 'annotations_list', arguments: {} }, 1)}\n`,
      }
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /document\.oai\.annotation attached to tab TAB1/);
    const reply = JSON.parse(r.stdout.trim().split('\n')[0]);
    const text = reply.result.content[0].text;
    const body = JSON.parse(text.slice(text.indexOf('\n') + 1, text.lastIndexOf('\n')));
    assert.equal(body.annotations.length, 1);
    assert.match(body.annotations[0].comment, /^bytes \d{4,}$/);
    assert.deepEqual(body.documents, [
      { tab: 'TAB1', url: 'https://shop.example.com/', loaderId: 'L1' },
    ]);
  });
});
