import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mcpcatArgs } from './helpers/bin.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const testHome = join(tmpdir(), `mcpcat-host-test-${Date.now()}`);
mkdirSync(join(testHome, '.pi', 'agent'), { recursive: true });
const testEnv = { HOME: testHome, PI_CODING_AGENT_DIR: join(testHome, '.pi', 'agent') };
after(() => rmSync(testHome, { recursive: true, force: true }));

function runHost(args) {
  const { cmd, args: cmdArgs } = mcpcatArgs(args);
  try {
    const result = execFileSync(cmd, cmdArgs, {
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, NODE_NO_WARNINGS: '1', ...testEnv },
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
    const { stderr, status } = runHost(['complete']);
    assert.equal(status, 1);
    assert.ok(stderr.includes('not implemented yet'));
  });
});
