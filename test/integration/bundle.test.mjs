import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const kernelBundle = readFileSync(join(root, 'dist/kernel/mcpcat.mjs'), 'utf8');

describe('kernel bundle', () => {
  it('has no import statements', () => {
    const importRe = /^import\s/gm;
    const matches = kernelBundle.match(importRe);
    assert.equal(matches, null, `found import statements in kernel bundle: ${matches}`);
  });

  it('has no dynamic imports', () => {
    const dynamicRe = /import\s*\(/g;
    const matches = kernelBundle.match(dynamicRe);
    assert.equal(matches, null, `found dynamic imports in kernel bundle: ${matches}`);
  });

  it('bundles one quickjs-wasi, so the code deadline hooks the QuickJS that runs scripts', () => {
    const copies = kernelBundle.match(
      /^\/\/ node_modules\/(?:\S+\/)?quickjs-wasi\/dist\/index\.js$/gm
    );
    assert.equal(copies?.length, 1, `found quickjs-wasi copies: ${copies}`);
  });
});
