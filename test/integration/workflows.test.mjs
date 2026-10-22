import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const ci = read('.github/workflows/ci.yml');
const pkg = JSON.parse(read('package.json'));
const input = (name) => ci.match(new RegExp(`\\n {6}${name}: (.+)\\n`))?.[1];
const jobs = `\n${ci.split('\njobs:\n')[1]}`;
const job = (name) =>
  jobs
    .match(new RegExp(`\\n {2}${name}:\\n([\\s\\S]*?)(?=\\n {2}[a-z-]+:\\n|$)`))?.[1]
    .replace(/^/, '\n');

test('ci.yml is the only workflow and calls slicc-shared-web pipeline.yml at the devDependency version', () => {
  assert.deepEqual(readdirSync(join(root, '.github/workflows')), ['ci.yml']);
  assert.deepEqual(readdirSync(join(root, '.github')), ['workflows']);
  const version = pkg.devDependencies['@ai-ecoverse/slicc-shared-web'];
  assert.match(version, /^2\.\d+\.\d+$/);
  assert.match(
    ci,
    new RegExp(
      `\\njobs:\\n {2}ci:\\n {4}uses: ai-ecoverse/slicc-shared-web/\\.github/workflows/pipeline\\.yml@v${version.replaceAll('.', '\\.')}\\n {4}secrets: inherit\\n {4}with:\\n`
    )
  );
  assert.deepEqual(jobs.match(/^ {2}[a-z-]+:$/gm), ['  ci:', '  released:', '  binaries:']);
});

test('CI runs on pull requests, merge groups and pushes to main, with the pipeline permissions, and cancels only a superseded pull request run', () => {
  assert.match(
    ci,
    /\non:\n {2}pull_request:\n {2}merge_group:\n {2}push:\n {4}branches: \[main\]\n/
  );
  assert.match(
    ci,
    /\npermissions:\n {2}contents: write\n {2}actions: read\n {2}attestations: write\n {2}issues: write\n {2}pull-requests: write\n {2}statuses: write\n {2}id-token: write\n/
  );
  assert.match(
    ci,
    /\nconcurrency:\n {2}group: ci-\$\{\{ github\.ref \}\}\n {2}cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}\n/
  );
  assert.doesNotMatch(ci, /workflow_dispatch|workflow_call|schedule:|workflow_run/);
});

test('the pipeline picks its runners, and no runner variable, certification or manual release is left', () => {
  for (const name of ['runs-on', 'after-release', 'review-renovate', 'release-environment']) {
    assert.equal(input(name), undefined, name);
  }
  assert.doesNotMatch(ci, /vars\.|CERT_|cert-review|macos/);
  assert.doesNotMatch(job('ci'), /runs-on/);
  assert.match(input('review-prompt'), /^\|$/);
  assert.equal(existsSync(join(root, 'scripts/cert.mjs')), false);
  assert.equal(existsSync(join(root, 'scripts/cert-review')), false);
  for (const name of Object.keys(pkg.devDependencies)) assert.doesNotMatch(name, /cert/);
  assert.equal(pkg.scripts.cert, undefined);
});

test('the shards split exactly the files npm test runs, on Node 26', () => {
  assert.equal(input('test'), undefined);
  assert.equal(input('test-glob'), 'test/integration/*.test.mjs');
  assert.ok(pkg.scripts.test.endsWith(` '${input('test-glob')}'`), pkg.scripts.test);
  assert.doesNotMatch(pkg.scripts.test, /NODE_OPTIONS|test:unit/);
  assert.equal(input('node-version'), "'26'");
  assert.equal(pkg.scripts.prepare, 'npm run build && slicc-install-hooks');
  assert.ok(existsSync(join(root, '.githooks/pre-commit')));
});

test('semantic-release publishes to npm from the trusted ci.yml, with provenance', () => {
  assert.equal(pkg.fledgling.workflow, 'ci.yml');
  assert.equal(pkg.fledgling.repo, 'ai-ecoverse/mcpcat');
  assert.equal(pkg.publishConfig.provenance, true);
  const release = JSON.parse(read('.releaserc.json'));
  assert.ok(release.plugins.includes('@semantic-release/npm'));
  assert.doesNotMatch(JSON.stringify(release), /npmPublish/);
});

test('the installer assets follow only a release: a new v* tag at the pushed commit on main', () => {
  const released = job('released');
  assert.match(released, /\n {4}needs: ci\n/);
  assert.match(
    released,
    /\n {4}if: github\.event_name == 'push' && github\.ref == 'refs\/heads\/main'\n/
  );
  assert.match(released, /git tag --points-at HEAD --list 'v\*'/);
  const binaries = job('binaries');
  assert.match(
    binaries,
    /\n {4}needs: released\n {4}if: needs\.released\.outputs\.version != ''\n/
  );
  assert.match(binaries, /\n {4}runs-on: ubuntu-latest\n/);
  assert.match(binaries, /npm pack "@ai-ecoverse\/mcpcat@\$VERSION"/);
  for (const step of [
    'Installer test, alpine with nodejs',
    'Installer test, alpine without node (musl rejection)',
    'Installer test, ubuntu with node',
    'Installer test, ubuntu without node',
  ]) {
    assert.ok(binaries.includes(`- name: ${step}\n`), step);
  }
  assert.ok(
    binaries.indexOf('Installer test, ubuntu with node') < binaries.indexOf('Hide system node')
  );
  assert.match(binaries, /gh release (upload|create) "\$TAG" assets\/\*/);
  assert.equal((binaries.match(/All installer tests passed\./g) ?? []).length, 3);
});

test('the workflow has no comments but renovate annotations', () => {
  for (const line of ci.split('\n')) {
    if (/^\s*#/.test(line)) assert.match(line, /^\s*# renovate:/);
  }
});

test('Renovate moves slicc-shared-web and its pipeline ref in one PR', () => {
  const config = JSON.parse(read('renovate.json'));
  assert.deepEqual(config.extends, ['github>ai-ecoverse/slicc-shared-web']);
  const shared = config.packageRules.find((rule) => rule.groupSlug === 'slicc-shared-web');
  assert.deepEqual(shared?.matchPackageNames, [
    '@ai-ecoverse/slicc-shared-web',
    'ai-ecoverse/slicc-shared-web',
  ]);
});
