#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const kernelArg = process.argv.find((a) => a.startsWith('--kernel='));
const kernelTgz = kernelArg ? kernelArg.split('=')[1] : null;

const env = { ...process.env, NODE_NO_WARNINGS: '1' };
let tmpDir;
let kernelVersion;

if (kernelTgz) {
  tmpDir = join(tmpdir(), `mcpcat-cert-kernel-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  console.log(`cert: installing kernel from ${kernelTgz}...`);
  execSync('npm init -y', { cwd: tmpDir, stdio: 'pipe' });
  execSync(`npm install ${kernelTgz}`, { cwd: tmpDir, stdio: 'inherit', timeout: 60_000 });

  const kernelDir = join(tmpDir, 'node_modules/@ai-ecoverse/slicc-kernel');
  const kernelPkg = JSON.parse(readFileSync(join(kernelDir, 'package.json'), 'utf8'));
  kernelVersion = kernelPkg.version;
  console.log(`cert: kernel ${kernelVersion} installed`);

  env.MCPCAT_CERT_KERNEL_DIR = kernelDir;
}

const testFiles = ['test/integration/cert.test.mjs', 'test/integration/serve-soak.cert.mjs'];

if (env.MCPCAT_CERT_KERNEL_DIR) {
  testFiles.push('test/integration/*kernel*.test.mjs');
}

const cmd = `node --test --test-timeout=120000 ${testFiles.join(' ')}`;
let output = '';
let exitCode = 0;

try {
  output = execSync(cmd, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'pipe'],
    timeout: 300_000,
    env,
  });
} catch (err) {
  output = (err.stdout ?? '') + (err.stderr ?? '');
  exitCode = err.status ?? 1;
}

process.stdout.write(output);

if (kernelVersion) {
  if (!output.includes(`kernel ${kernelVersion}`)) {
    console.error(`cert: FAIL — output does not mention kernel ${kernelVersion}`);
    process.exit(1);
  }
  const passMatch = output.match(/pass (\d+)/);
  const passCount = passMatch ? Number(passMatch[1]) : 0;
  if (passCount === 0) {
    console.error('cert: FAIL — kernel was given but no tests passed');
    process.exit(1);
  }
  console.log(`cert: kernel ${kernelVersion} — ${passCount} tests passed`);
}

if (tmpDir && existsSync(tmpDir)) {
  rmSync(tmpDir, { recursive: true, force: true });
}

process.exit(exitCode);
