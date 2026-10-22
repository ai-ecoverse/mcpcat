#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { kernelTestFiles } from './kernel-test-files.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const countReporter = pathToFileURL(join(root, 'scripts/cert-count-reporter.mjs')).href;

const kernelArg = process.argv.find((a) => a.startsWith('--kernel='));
const kernelTgz = kernelArg ? kernelArg.slice('--kernel='.length) : null;
const patternArgs = process.argv.filter((a) => a.startsWith('--test-name-pattern='));

const env = { ...process.env, NODE_NO_WARNINGS: '1' };
delete env.NODE_TEST_CONTEXT;
let tmpDir;

if (kernelTgz) {
  tmpDir = join(tmpdir(), `mcpcat-cert-kernel-${Date.now()}`);
  mkdirSync(tmpDir, { recursive: true });

  console.log(`cert: installing kernel from ${kernelTgz}...`);
  const local = existsSync(kernelTgz);
  const flags = ['--no-audit', '--no-fund', '--no-package-lock', ...(local ? ['--offline'] : [])];
  const timeout = Number(env.MCPCAT_CERT_INSTALL_TIMEOUT_MS) || 600_000;
  try {
    writeFileSync(join(tmpDir, 'package.json'), '{"private":true}\n');
    execFileSync('npm', ['install', ...flags, local ? resolve(kernelTgz) : kernelTgz], {
      cwd: tmpDir,
      stdio: 'inherit',
      timeout,
    });
  } catch (err) {
    console.error(`cert: kernel install failed: ${err.message}`);
    rmSync(tmpDir, { recursive: true, force: true });
    process.exit(1);
  }

  env.MCPCAT_CERT_KERNEL_DIR = join(tmpDir, 'node_modules/@ai-ecoverse/slicc-kernel');
}

const kernelDir = env.MCPCAT_CERT_KERNEL_DIR;

function readKernelVersion(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version;
  } catch {
    return undefined;
  }
}

function runTests(files) {
  const res = spawnSync(
    process.execPath,
    [
      '--test',
      '--test-reporter=spec',
      '--test-reporter-destination=stdout',
      `--test-reporter=${countReporter}`,
      '--test-reporter-destination=stdout',
      '--test-timeout=120000',
      ...patternArgs,
      ...files,
    ],
    {
      cwd: root,
      encoding: 'utf8',
      stdio: ['inherit', 'pipe', 'pipe'],
      timeout: 300_000,
      env,
    }
  );
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`;
  process.stdout.write(output);
  if (res.error) console.error(`cert: FAIL — ${files.join(' ')}: ${res.error.message}`);
  const passMatch = output.match(/^cert: (\d+) tests passed$/m);
  const passCount = passMatch ? Number(passMatch[1]) : 0;
  return { output, passCount, exitCode: res.status ?? 1 };
}

function finish(code) {
  if (tmpDir && existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  process.exit(code);
}

const base = runTests(['test/integration/cert.test.mjs', 'test/integration/serve-soak.cert.mjs']);

if (!kernelDir) finish(base.exitCode);

const kernelVersion = readKernelVersion(kernelDir);
if (kernelVersion) console.log(`cert: kernel ${kernelVersion} at ${kernelDir}`);

const kernelFiles = kernelTestFiles();
console.log(`cert: kernel test files: ${kernelFiles.join(' ')}`);
const kernel = runTests(kernelFiles);

if (kernel.passCount === 0) {
  console.error(`cert: FAIL — kernel dir ${kernelDir} was given but no kernel tests passed`);
  finish(1);
}
if (!kernelVersion || !kernel.output.includes(`kernel ${kernelVersion}`)) {
  console.error(
    `cert: FAIL — kernel tests did not report using kernel ${kernelVersion ?? '(unknown)'}`
  );
  finish(1);
}
console.log(`cert: kernel ${kernelVersion} — ${kernel.passCount} kernel tests passed`);
finish(base.exitCode || kernel.exitCode);
