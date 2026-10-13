import { describe, it, before, after } from 'node:test';
import { readFileSync } from 'node:fs';
import { execFileSync as exec } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createNodeKernel } from '@ai-ecoverse/slicc-kernel/node';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const kernelBundle = join(root, 'dist/kernel/mcpcat.mjs');
const hostBin = join(root, 'dist/host/mcpcat.mjs');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

describe('kernel: mcpcat', () => {
  let kernel;

  before(async () => {
    kernel = await createNodeKernel({});
    const bundleData = readFileSync(kernelBundle);
    await kernel.writeFile(
      '/node_modules/@ai-ecoverse/mcpcat/dist/kernel/mcpcat.mjs',
      bundleData,
    );
    await kernel.writeFile(
      '/node_modules/@ai-ecoverse/mcpcat/package.json',
      JSON.stringify({
        name: '@ai-ecoverse/mcpcat',
        version: pkg.version,
        type: 'module',
        slicc: {
          commands: {
            mcpcat: {
              abi: 'js',
              module: 'dist/kernel/mcpcat.mjs',
            },
          },
        },
      }),
    );
  });

  after(() => {
    kernel?.terminate();
  });

  it('--version prints the package.json version', async () => {
    const { status, stdout } = await kernel.run(['mcpcat', '--version'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assert.equal(status, 0);
    assert.equal(stdout.trim(), pkg.version);
  });

  it('-V prints the version', async () => {
    const { status, stdout } = await kernel.run(['mcpcat', '-V'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assert.equal(status, 0);
    assert.equal(stdout.trim(), pkg.version);
  });

  it('--help prints help text', async () => {
    const { status, stdout } = await kernel.run(['mcpcat', '--help'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assert.equal(status, 0);
    assert.ok(stdout.includes('mcpcat'));
    assert.ok(stdout.includes('Usage:'));
    assert.ok(stdout.includes('not implemented yet'));
  });

  it('unknown command exits 2', async () => {
    const { status, stderr } = await kernel.run(['mcpcat', 'bogus'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assert.equal(status, 2);
    assert.ok(stderr.includes("unknown command 'bogus'"));
  });

  it('--version output matches host', async () => {
    const hostOut = exec('node', [hostBin, '--version'], {
      encoding: 'utf8',
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    }).trim();

    const { stdout } = await kernel.run(['mcpcat', '--version'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    assert.equal(stdout.trim(), hostOut);
  });

  it('--help output matches host', async () => {
    const hostOut = exec('node', [hostBin, '--help'], {
      encoding: 'utf8',
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    }).trim();

    const { stdout } = await kernel.run(['mcpcat', '--help'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    assert.equal(stdout.trim(), hostOut);
  });
});
