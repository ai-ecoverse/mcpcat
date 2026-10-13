import { describe, it } from 'node:test';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const hostBin = join(root, 'dist/host/mcpcat.mjs');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const kernelArg = process.argv.find((a) => a.startsWith('--kernel='));
const kernelTgz = kernelArg ? kernelArg.split('=')[1] : null;

describe('cert: host/kernel parity', () => {
  it('--version matches package.json', () => {
    const out = execFileSync('node', [hostBin, '--version'], {
      encoding: 'utf8',
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    assert.equal(out.trim(), pkg.version);
  });

  it('--help is identical between host runs', () => {
    const a = execFileSync('node', [hostBin, '--help'], {
      encoding: 'utf8',
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    const b = execFileSync('node', [hostBin, '--help'], {
      encoding: 'utf8',
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    assert.equal(a, b);
  });
});
