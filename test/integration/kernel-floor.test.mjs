import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const floor = pkg.engines['slicc-kernel'].replace(/^>=/, '');
const self = 'kernel-floor.test.mjs';

const kernelFiles = readdirSync(here)
  .filter((f) => f.endsWith('.test.mjs') && f !== self)
  .filter((f) => readFileSync(join(here, f), 'utf8').includes("from './helpers/kernel.mjs'"))
  .sort()
  .map((f) => join('test/integration', f));

describe('the kernel bundle runs on the engines.slicc-kernel floor', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcpcat-kernel-floor-'));
  after(() => rmSync(dir, { recursive: true, force: true }));

  it(`passes every kernel test on slicc-kernel ${floor}`, { timeout: 900_000 }, () => {
    assert.match(pkg.engines['slicc-kernel'], /^>=\d+\.\d+\.\d+$/);
    assert.ok(kernelFiles.length > 10, kernelFiles.join(' '));
    writeFileSync(join(dir, 'package.json'), '{"private":true}\n');
    const install = spawnSync(
      'npm',
      [
        'install',
        '--no-audit',
        '--no-fund',
        '--no-package-lock',
        '--ignore-scripts',
        `@ai-ecoverse/slicc-kernel@${floor}`,
      ],
      { cwd: dir, encoding: 'utf8', timeout: 300_000 }
    );
    assert.equal(install.status, 0, `${install.stdout}${install.stderr}`);
    const kernelDir = join(dir, 'node_modules/@ai-ecoverse/slicc-kernel');
    const installed = JSON.parse(readFileSync(join(kernelDir, 'package.json'), 'utf8')).version;
    assert.equal(installed, floor);
    const env = { ...process.env, NODE_NO_WARNINGS: '1', MCPCAT_KERNEL_DIR: kernelDir };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_OPTIONS;
    const run = spawnSync(
      process.execPath,
      ['--test', '--test-timeout=60000', '--test-reporter=spec', ...kernelFiles],
      { cwd: root, encoding: 'utf8', env, timeout: 840_000 }
    );
    const out = `${run.stdout}${run.stderr}`;
    assert.equal(run.status, 0, out.slice(-8000));
    assert.match(out, new RegExp(`kernel: using ${floor.replaceAll('.', '\\.')} from `));
    assert.match(out, /^ℹ pass [1-9]\d*$/m);
    assert.match(out, /^ℹ fail 0$/m);
  });
});
