import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mcpcatArgs } from './helpers/bin.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const kernelArg = process.argv.find((a) => a.startsWith('--kernel='));
const kernelTgz = kernelArg ? kernelArg.split('=')[1] : null;

function runBin(args) {
  const { cmd, args: cmdArgs } = mcpcatArgs(args);
  return execFileSync(cmd, cmdArgs, {
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
}

describe('cert: host/kernel parity', () => {
  it('--version matches package.json', () => {
    const out = runBin(['--version']);
    assert.equal(out.trim(), pkg.version);
  });

  it('--help is identical between host runs', () => {
    const a = runBin(['--help']);
    const b = runBin(['--help']);
    assert.equal(a, b);
  });
});
