import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
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

const version = '0.24.0';
const url = `https://registry.npmjs.org/@ai-ecoverse/mcpcat/-/mcpcat-${version}.tgz`;
const tarball = Buffer.from([0x1f, 0x8b, 0x08, 0x00, ...Buffer.from('mcpcat tarball\n')]);
const sri = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
const sha256 = createHash('sha256').update(tarball).digest('hex');

const tick = `tick() { echo $(($(cat "$STATE/clock") + $1)) > "$STATE/clock"; }`;

const npmStub = `#!/bin/sh
${tick}
case "$1" in
  view)
    tick "$VIEW_SECONDS"
    n=$(($(cat "$STATE/views" 2>/dev/null || echo 0) + 1))
    echo "$n" > "$STATE/views"
    echo "$*" >> "$STATE/view-args"
    if [ "$n" -le "$VIEW_FAILS" ]; then
      echo '{"error":{"code":"E404","summary":"No match found for version '"$VERSION"'"}}'
      echo "npm error code E404" >&2
      exit 1
    fi
    printf '{"dist.tarball":"%s","dist.integrity":"%s"}\\n' "$TARBALL_URL" "$INTEGRITY"
    exit 0 ;;
  pack)
    echo "npm error code ETARGET" >&2
    exit 1 ;;
esac
exit 2
`;

const curlStub = `#!/bin/sh
${tick}
tick "$CURL_SECONDS"
n=$(($(cat "$STATE/curls" 2>/dev/null || echo 0) + 1))
echo "$n" > "$STATE/curls"
out=
prev=
for arg in "$@"; do
  [ "$prev" = "-o" ] && out="$arg"
  case "$arg" in https://*) echo "$arg" >> "$STATE/urls" ;; esac
  prev="$arg"
done
if [ "$n" -le "$CURL_FAILS" ]; then
  echo "curl: (22) The requested URL returned error: 404" >&2
  exit 22
fi
cat "$STATE/tarball" > "$out"
`;

const sleepStub = `#!/bin/sh
${tick}
tick "$1"
echo "$1" >> "$STATE/sleeps"
`;

const dateStub = `#!/bin/sh
[ "$*" = "+%s" ] || exit 2
cat "$STATE/clock"
`;

const start = 1800000000;

function run({
  viewFails = 0,
  curlFails = 0,
  viewSeconds = 0,
  curlSeconds = 0,
  integrity = sri(tarball),
} = {}) {
  const dir = mkdtempSync(join(base, 'run-'));
  const bin = join(dir, 'bin');
  const work = join(dir, 'work');
  mkdirSync(bin);
  mkdirSync(work);
  writeFileSync(join(dir, 'tarball'), tarball);
  writeFileSync(join(dir, 'clock'), `${start}\n`);
  for (const [name, body] of [
    ['npm', npmStub],
    ['curl', curlStub],
    ['sleep', sleepStub],
    ['date', dateStub],
  ]) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }
  const result = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', '-c', script], {
    cwd: work,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: [bin, process.env.PATH].join(delimiter),
      VERSION: version,
      VIEW_FAILS: String(viewFails),
      CURL_FAILS: String(curlFails),
      VIEW_SECONDS: String(viewSeconds),
      CURL_SECONDS: String(curlSeconds),
      TARBALL_URL: url,
      INTEGRITY: integrity,
      STATE: dir,
    },
  });
  const read = (name) =>
    existsSync(join(dir, name)) ? readFileSync(join(dir, name), 'utf8').trim() : '';
  const lines = (name) => read(name).split('\n').filter(Boolean);
  const assets = join(work, 'assets');
  return {
    ...result,
    assets,
    files: existsSync(assets) ? readdirSync(assets).sort() : [],
    views: Number(read('views')),
    viewArgs: lines('view-args'),
    curls: Number(read('curls')),
    urls: lines('urls'),
    sleeps: lines('sleeps'),
    elapsed: Number(read('clock')) - start,
  };
}

function assertPublished(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.files, ['SHA256SUMS', `mcpcat-${version}.tgz`]);
  assert.deepEqual(readFileSync(join(result.assets, `mcpcat-${version}.tgz`)), tarball);
  assert.equal(
    readFileSync(join(result.assets, 'SHA256SUMS'), 'utf8'),
    `${sha256}  mcpcat-${version}.tgz\n`
  );
  assert.ok(result.sleeps.every((seconds) => seconds === '10'));
}

test('the binaries job extracts a Fetch the published npm tarball script', () => {
  assert.ok(script);
  assert.match(
    script,
    /npm view "@ai-ecoverse\/mcpcat@\$VERSION" dist\.tarball dist\.integrity --json/
  );
  assert.match(script, /curl -fsSL /);
  assert.doesNotMatch(script, /npm pack/);
});

test('npm view is retried until the full packument has the version, then its tarball is fetched and checksummed', () => {
  const result = run({ viewFails: 3 });
  assertPublished(result);
  assert.equal(result.views, 4);
  assert.deepEqual(
    result.viewArgs,
    Array(4).fill(`view @ai-ecoverse/mcpcat@${version} dist.tarball dist.integrity --json`)
  );
  assert.equal(result.curls, 1);
  assert.deepEqual(result.urls, [url]);
  assert.equal(result.sleeps.length, 3);
});

test('a tarball URL that 404s is retried without asking npm again, then fetched and checksummed', () => {
  const result = run({ curlFails: 3 });
  assertPublished(result);
  assert.equal(result.views, 1);
  assert.equal(result.curls, 4);
  assert.deepEqual(result.urls, Array(4).fill(url));
  assert.equal(result.sleeps.length, 3);
});

test('npm view and the download share one budget of about 15 minutes', () => {
  const result = run({ viewFails: 40, curlFails: 49 });
  assertPublished(result);
  assert.equal(result.views, 41);
  assert.equal(result.curls, 50);
  assert.equal(result.sleeps.length, 89);
  assert.equal(result.elapsed, 890);
});

test('a download that does not match dist.integrity fails at once without SHA256SUMS', () => {
  const result = run({ integrity: sri(Buffer.from('another tarball\n')) });
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    new RegExp(`integrity mismatch: npm says ${url.replaceAll('.', '\\.')} is sha512-`)
  );
  assert.equal(result.views, 1);
  assert.equal(result.curls, 1);
  assert.equal(result.sleeps.length, 0);
  assert.deepEqual(result.files, []);
});

test('a version npm never shows fails the step clearly once 15 minutes are up', () => {
  const result = run({ viewFails: 1000 });
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /npm view: @ai-ecoverse\/mcpcat@0\.24\.0 has no dist\.tarball and dist\.integrity after 90 attempts in 890 s/
  );
  assert.equal(result.views, 90);
  assert.equal(result.curls, 0);
  assert.equal(result.elapsed, 890);
  assert.deepEqual(result.files, []);
});

test('a tarball that keeps 404ing until the shared budget runs out fails the step clearly', () => {
  const result = run({ viewFails: 40, curlFails: 50 });
  assert.equal(result.status, 1);
  assert.match(
    result.stdout,
    /curl: https:\/\/registry\.npmjs\.org\/@ai-ecoverse\/mcpcat\/-\/mcpcat-0\.24\.0\.tgz not downloadable after 90 attempts in 890 s/
  );
  assert.equal(result.views, 41);
  assert.equal(result.curls, 50);
  assert.deepEqual(result.files, []);
});

test('downloads that run into curl --max-time stop at the 15-minute deadline, not after 90 tries', () => {
  const result = run({ curlFails: 1000, curlSeconds: 60 });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /not downloadable after 13 attempts in 900 s/);
  assert.equal(result.views, 1);
  assert.equal(result.curls, 13);
  assert.equal(result.elapsed, 900);
  assert.deepEqual(result.files, []);
});

test('a slow npm view stops at the 15-minute deadline, not after 90 tries', () => {
  const result = run({ viewFails: 1000, viewSeconds: 50 });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /dist\.integrity after 15 attempts in 890 s/);
  assert.equal(result.views, 15);
  assert.equal(result.curls, 0);
  assert.equal(result.elapsed, 890);
  assert.deepEqual(result.files, []);
});
