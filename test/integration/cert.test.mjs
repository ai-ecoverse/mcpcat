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

const kernelTgz = process.env.MCPCAT_CERT_KERNEL || null;

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
  let kernelDir;
  let kernelVersion;

  it('installs kernel tgz and runs kernel tests', { timeout: 120_000 }, () => {
    tmpDir = join(tmpdir(), `mcpcat-cert-kernel-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });

    execSync('npm init -y', { cwd: tmpDir, stdio: 'pipe' });
    execSync(`npm install ${kernelTgz}`, {
      cwd: tmpDir,
      stdio: 'inherit',
      timeout: 60_000,
    });

    kernelDir = join(tmpDir, 'node_modules/@ai-ecoverse/slicc-kernel');
    const installedPkg = JSON.parse(readFileSync(join(kernelDir, 'package.json'), 'utf8'));
    kernelVersion = installedPkg.version;
    console.log(`cert: installed kernel ${kernelVersion} from ${kernelTgz}`);
    assert.ok(kernelVersion, 'kernel package has a version');

    const output = execSync('node --test --test-timeout=30000 test/integration/*kernel*.test.mjs', {
      cwd: root,
      encoding: 'utf8',
      timeout: 90_000,
      env: {
        ...process.env,
        NODE_NO_WARNINGS: '1',
        MCPCAT_CERT_KERNEL_DIR: kernelDir,
      },
    });
    console.log(`cert: kernel tests completed for ${kernelVersion}`);
    assert.ok(output.includes(`kernel ${kernelVersion}`), `output should mention kernel version`);
  });

  it('cleans up temp dir', () => {
    if (tmpDir && existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
