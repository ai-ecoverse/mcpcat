import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

describe('cert: kernel parity via --kernel tgz', { skip: !kernelTgz }, () => {
  let tmpDir;

  it('installs kernel tgz and runs kernel tests', { timeout: 120_000 }, () => {
    tmpDir = join(tmpdir(), `mcpcat-cert-kernel-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    execSync(`npm init -y`, { cwd: tmpDir, stdio: 'pipe' });
    execSync(`npm install ${kernelTgz}`, {
      cwd: tmpDir,
      stdio: 'inherit',
      timeout: 60_000,
    });

    const installedPkg = JSON.parse(
      readFileSync(join(tmpDir, 'node_modules/@ai-ecoverse/slicc-kernel/package.json'), 'utf8')
    );
    assert.ok(installedPkg.version, 'kernel package installed');

    execSync(
      `NODE_PATH=${tmpDir}/node_modules node --test --test-timeout=30000 test/integration/*kernel*.test.mjs`,
      {
        cwd: root,
        stdio: 'inherit',
        timeout: 90_000,
        env: {
          ...process.env,
          NODE_NO_WARNINGS: '1',
          NODE_PATH: `${tmpDir}/node_modules`,
        },
      }
    );
  });

  it('cleans up temp dir', () => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
