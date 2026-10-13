import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const hostBin = join(root, 'dist/host/mcpcat.mjs');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function runHost(args) {
  try {
    const result = execFileSync('node', [hostBin, ...args], {
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    return { stdout: result, stderr: '', status: 0 };
  } catch (err) {
    return {
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
      status: err.status ?? 1,
    };
  }
}

describe('host: mcpcat', () => {
  it('--version prints the package.json version', () => {
    const { stdout, status } = runHost(['--version']);
    assert.equal(status, 0);
    assert.equal(stdout.trim(), pkg.version);
  });

  it('-V prints the version', () => {
    const { stdout, status } = runHost(['-V']);
    assert.equal(status, 0);
    assert.equal(stdout.trim(), pkg.version);
  });

  it('--help prints help text', () => {
    const { stdout, status } = runHost(['--help']);
    assert.equal(status, 0);
    assert.ok(stdout.includes('mcpcat'));
    assert.ok(stdout.includes('Usage:'));
    assert.ok(stdout.includes('not implemented yet'));
  });

  it('-h prints help text', () => {
    const { stdout, status } = runHost(['-h']);
    assert.equal(status, 0);
    assert.ok(stdout.includes('Usage:'));
  });

  it('help verb prints help text', () => {
    const { stdout, status } = runHost(['help']);
    assert.equal(status, 0);
    assert.ok(stdout.includes('Usage:'));
  });

  it('no args prints help', () => {
    const { stdout, status } = runHost([]);
    assert.equal(status, 0);
    assert.ok(stdout.includes('Usage:'));
  });

  it('unknown command exits 2', () => {
    const { stderr, status } = runHost(['bogus']);
    assert.equal(status, 2);
    assert.ok(stderr.includes('unknown target'));
  });

  it('known but unimplemented verb exits 1', () => {
    const { stderr, status } = runHost(['resources']);
    assert.equal(status, 1);
    assert.ok(stderr.includes('not implemented yet'));
  });
});
