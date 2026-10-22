import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const work = mkdtempSync(join(tmpdir(), 'mcpcat-cert-install-'));
after(() => rmSync(work, { recursive: true, force: true }));

function stubNpm(mode) {
  const dir = mkdtempSync(join(work, 'bin-'));
  const log = join(dir, 'npm.log');
  const script = `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === 'init') {
  fs.writeFileSync('package.json', '{}');
  process.exit(0);
}
if (${JSON.stringify(mode)} === 'hang') setInterval(() => {}, 1000);
else setTimeout(() => process.exit(1), 1500);
`;
  const npm = join(dir, 'npm');
  writeFileSync(npm, script);
  chmodSync(npm, 0o755);
  return { dir, log };
}

function runCert(mode) {
  const stub = stubNpm(mode);
  const tgz = join(work, 'kernels', 'slicc-kernel-0.0.0.tgz');
  mkdirSync(dirname(tgz), { recursive: true });
  writeFileSync(tgz, '');
  const env = {
    ...process.env,
    PATH: [stub.dir, process.env.PATH].join(delimiter),
    MCPCAT_CERT_INSTALL_TIMEOUT_MS: '3000',
  };
  delete env.MCPCAT_CERT_KERNEL_DIR;
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync(process.execPath, ['scripts/cert.mjs', `--kernel=${tgz}`], {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 90_000,
  });
  const calls = readFileSync(stub.log, 'utf8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  return { ...r, out: `${r.stdout}${r.stderr}`, calls };
}

describe('cert kernel install', () => {
  it('reports a hanging npm install distinctly and does not pass', () => {
    const r = runCert('hang');
    assert.equal(r.error, undefined);
    assert.notEqual(r.status, 0);
    assert.match(r.out, /^cert: kernel install failed/m);
    assert.doesNotMatch(r.out, /tests passed/);
    const install = r.calls.find((a) => a[0] === 'install');
    for (const flag of ['--offline', '--no-audit', '--no-fund']) assert.ok(install.includes(flag));
  });

  it('reports a slow failing npm install distinctly and does not pass', () => {
    const r = runCert('fail');
    assert.notEqual(r.status, 0);
    assert.match(r.out, /^cert: kernel install failed/m);
    assert.doesNotMatch(r.out, /tests passed/);
  });
});
