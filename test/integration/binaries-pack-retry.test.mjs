import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
const step = ci.match(
  /\n {6}- name: Fetch the published npm tarball\n {8}run: \|\n([\s\S]*?)\n(?= {6}- name: )/
)?.[1];
const script = step
  ?.split('\n')
  .map((line) => line.slice(10))
  .join('\n');

const base = mkdtempSync(join(tmpdir(), 'mcpcat-pack-retry-'));
after(() => rmSync(base, { recursive: true, force: true }));

const npmStub = `#!/bin/sh
case "$1" in
  view) echo "$VERSION"; exit 0 ;;
  pack)
    n=$(($(cat "$STATE/packs" 2>/dev/null || echo 0) + 1))
    echo "$n" > "$STATE/packs"
    if [ "$n" -le "$FAILS" ]; then echo "npm error code ETARGET" >&2; exit 1; fi
    echo tarball > "$4/ai-ecoverse-mcpcat-$VERSION.tgz"
    exit 0 ;;
esac
exit 2
`;

const sleepStub = `#!/bin/sh
echo "$1" >> "$STATE/sleeps"
`;

function run(fails) {
  const dir = mkdtempSync(join(base, 'run-'));
  const bin = join(dir, 'bin');
  const work = join(dir, 'work');
  mkdirSync(bin);
  mkdirSync(work);
  writeFileSync(join(bin, 'npm'), npmStub);
  writeFileSync(join(bin, 'sleep'), sleepStub);
  chmodSync(join(bin, 'npm'), 0o755);
  chmodSync(join(bin, 'sleep'), 0o755);
  const result = spawnSync('bash', ['-e', '-c', script], {
    cwd: work,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: [bin, process.env.PATH].join(delimiter),
      VERSION: '0.24.0',
      FAILS: String(fails),
      STATE: dir,
    },
  });
  const read = (name) =>
    existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8').trim() : '';
  return {
    ...result,
    work,
    packs: Number(read('packs')),
    sleeps: read('sleeps').split('\n').filter(Boolean).length,
  };
}

test('the binaries job extracts a Fetch the published npm tarball script', () => {
  assert.ok(script);
  assert.match(script, /npm pack "@ai-ecoverse\/mcpcat@\$VERSION" --pack-destination assets/);
});

test('npm pack is retried until the published version is fetchable, then the tarball is renamed and checksummed', () => {
  const result = run(3);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.packs, 4);
  assert.equal(result.sleeps, 3);
  const assets = join(result.work, 'assets');
  assert.equal(readFileSync(join(assets, 'mcpcat-0.24.0.tgz'), 'utf8'), 'tarball\n');
  assert.equal(existsSync(join(assets, 'ai-ecoverse-mcpcat-0.24.0.tgz')), false);
  assert.match(
    readFileSync(join(assets, 'SHA256SUMS'), 'utf8'),
    /^[0-9a-f]{64} {2}mcpcat-0\.24\.0\.tgz\n$/
  );
});

test('npm pack that never succeeds fails the step clearly after 30 attempts', () => {
  const result = run(1000);
  assert.equal(result.status, 1);
  assert.equal(result.packs, 30);
  assert.match(
    result.stdout,
    /npm pack: @ai-ecoverse\/mcpcat@0\.24\.0 not fetchable after 30 attempts/
  );
  assert.equal(existsSync(join(result.work, 'assets/SHA256SUMS')), false);
});
