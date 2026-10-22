import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const script = join(root, 'test/integration/test-install.sh');

const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
const skip =
  process.getuid?.() === 0 || !has('python3') || !has('curl') || !has('tar')
    ? 'needs a non-root user with python3, curl and tar'
    : false;

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const snapshot = (dir) =>
  Object.fromEntries(readdirSync(dir).map((name) => [name, sha(join(dir, name))]));

test('test-install.sh passes against a read-only asset dir and leaves it untouched', {
  skip,
}, () => {
  const base = mkdtempSync(join(tmpdir(), 'mcpcat-test-install-'));
  const assets = join(base, 'assets');
  after(() => {
    chmodSync(assets, 0o755);
    rmSync(base, { recursive: true, force: true });
  });

  const stage = join(base, 'stage');
  mkdirSync(join(stage, 'package/dist/host'), { recursive: true });
  writeFileSync(join(stage, 'package/dist/host/mcpcat.mjs'), "console.log('9.9.9');\n");
  mkdirSync(assets);
  const tgz = join(assets, 'mcpcat-9.9.9.tgz');
  assert.equal(spawnSync('tar', ['czf', tgz, '-C', stage, 'package']).status, 0);
  writeFileSync(join(assets, 'SHA256SUMS'), `${sha(tgz)}  mcpcat-9.9.9.tgz\n`);
  chmodSync(tgz, 0o444);
  chmodSync(join(assets, 'SHA256SUMS'), 0o444);
  chmodSync(assets, 0o555);
  const before = snapshot(assets);

  const r = spawnSync('sh', [script, assets, '9.9.9'], {
    encoding: 'utf8',
    env: { ...process.env, EXPECT_MANAGED_NODE: '0' },
  });
  assert.equal(r.status, 0, `${r.stdout}\n${r.stderr}`);
  assert.match(r.stdout, /^All installer tests passed\.$/m);
  assert.deepEqual(snapshot(assets), before);
});
