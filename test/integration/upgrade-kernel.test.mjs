import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createNodeKernel } from './helpers/kernel.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

describe('kernel: upgrade is host only', () => {
  let kernel;

  before(async () => {
    kernel = await createNodeKernel({});
    const dir = '/node_modules/@ai-ecoverse/mcpcat';
    await kernel.writeFile(
      `${dir}/dist/kernel/mcpcat.mjs`,
      readFileSync(join(root, 'dist/kernel/mcpcat.mjs'))
    );
    await kernel.writeFile(
      `${dir}/package.json`,
      JSON.stringify({
        name: '@ai-ecoverse/mcpcat',
        version: pkg.version,
        type: 'module',
        slicc: { commands: { mcpcat: { abi: 'js', module: 'dist/kernel/mcpcat.mjs' } } },
      })
    );
  });

  after(() => kernel?.terminate());

  const run = (args) =>
    kernel.run(['mcpcat', ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { MCPCAT_UPDATE_API_BASE: 'http://127.0.0.1:9' },
    });

  for (const command of ['upgrade', 'update']) {
    it(`${command} says it is not available and exits non-zero`, async () => {
      for (const args of [[command], [command, '--check'], [command, '--force']]) {
        const r = await run(args);
        assert.equal(r.status, 1, String(r.stderr));
        assert.equal(String(r.stdout), '');
        assert.equal(
          String(r.stderr),
          `mcpcat ${command}: not available in the kernel build; the kernel updates it\n`
        );
      }
    });

    it(`${command} --help still prints its usage`, async () => {
      const r = await run([command, '--help']);
      assert.equal(r.status, 0, String(r.stderr));
      assert.match(
        String(r.stdout),
        new RegExp(`^mcpcat ${command} \\[--check\\] \\[--force\\]\\n`)
      );
    });
  }
});
