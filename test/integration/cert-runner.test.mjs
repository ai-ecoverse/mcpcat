import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const certScript = join(root, 'scripts/cert.mjs');
const bundledKernelDir = join(root, 'node_modules/@ai-ecoverse/slicc-kernel');

function runCert(kernelDir, args) {
  const env = { ...process.env, NODE_NO_WARNINGS: '1', MCPCAT_CERT_KERNEL_DIR: kernelDir };
  delete env.NODE_TEST_CONTEXT;
  const res = spawnSync(process.execPath, [certScript, ...args], {
    cwd: root,
    encoding: 'utf8',
    env,
  });
  return { code: res.status, out: `${res.stdout}${res.stderr}`, stderr: res.stderr };
}

describe('cert runner: kernel given but no kernel tests passed', () => {
  const emptyDir = mkdtempSync(join(tmpdir(), 'mcpcat-cert-unusable-'));

  after(() => rmSync(emptyDir, { recursive: true, force: true }));

  it('fails with a clear message for an unusable kernel dir', () => {
    const { code, out, stderr } = runCert(emptyDir, ['--test-name-pattern=host/kernel parity']);
    assert.notEqual(code, 0, out);
    assert.match(stderr, /cert: FAIL — kernel dir .* was given but no kernel tests passed/, out);
  });

  it('fails with a clear message when the filter matches no kernel tests', () => {
    const { code, out, stderr } = runCert(bundledKernelDir, [
      '--test-name-pattern=^matches no cert test$',
    ]);
    assert.notEqual(code, 0, out);
    assert.match(stderr, /cert: FAIL — kernel dir .* was given but no kernel tests passed/, out);
  });

  it('passes and reports the kernel version when kernel tests run', () => {
    const { code, out } = runCert(bundledKernelDir, [
      '--test-name-pattern=^unknown command exits 2$',
    ]);
    assert.equal(code, 0, out);
    assert.match(out, /cert: kernel \d+\.\d+\.\d+ — [1-9]\d* kernel tests passed/);
  });
});
