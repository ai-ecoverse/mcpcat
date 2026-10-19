import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, matchesGlob } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (file) => readFileSync(join(root, file), 'utf8');
const review = read('.github/workflows/cert-review.yml');
const ci = read('.github/workflows/ci.yml');

const guardJob = review.slice(review.indexOf('\n  guard:\n'), review.indexOf('\n  plan:\n'));
const globs = guardJob
  .slice(guardJob.indexOf('paths: |'), guardJob.indexOf('approval-label:'))
  .split('\n')
  .slice(1)
  .map((line) => line.trim())
  .filter(Boolean);
const guarded = (file) => globs.some((glob) => matchesGlob(file, glob));

describe('cert self-guard wiring', () => {
  it('pins the shared guard to a full commit sha', () => {
    assert.match(
      guardJob,
      /uses: ai-ecoverse\/slicc-shared-web\/\.github\/actions\/cert-self-guard@[0-9a-f]{40}\n/
    );
  });

  it('pins the guard release that matches dot paths, slicc-shared-web v1.24.2', () => {
    assert.match(
      guardJob,
      /\n {8}uses: ai-ecoverse\/slicc-shared-web\/\.github\/actions\/cert-self-guard@f342d7cf558c817ce517bbbbc4cc46df6eac2f97\n/
    );
    assert.doesNotMatch(review, /cert-self-guard@(?!f342d7cf558c817ce517bbbbc4cc46df6eac2f97\n)/);
    assert.match(guardJob, /approval-label: cert-review-approved\n/);
  });

  for (const file of [
    '.github/workflows/cert-review.yml',
    '.github/workflows/ci.yml',
    'scripts/cert-review/record.mjs',
    'scripts/cert-review/rows.json',
    'scripts/cert.mjs',
    'scripts/kernel-test-files.mjs',
    'test/integration/cert-row-serve.test.mjs',
    'test/integration/cert-row-new.test.mjs',
    'test/integration/cert-gate.test.mjs',
    'test/integration/cert-review.test.mjs',
    'test/integration/cert-runner.test.mjs',
    'test/integration/cert-self-guard.test.mjs',
    '.github/actions/cert-self-guard/action.yml',
  ]) {
    it(`guards ${file}`, () => assert.ok(guarded(file), `${file} is not guarded`));
  }

  for (const file of [
    'package.json',
    'package-lock.json',
    'README.md',
    'AGENTS.md',
    'docs/spec.html',
    'src/cli.ts',
    '.github/workflows/release.yml',
    'test/integration/serve.test.mjs',
  ]) {
    it(`leaves ${file} to the normal gates`, () => assert.ok(!guarded(file), `${file} is guarded`));
  }

  it('gives the guard what it needs to run and to drop a stale approval', () => {
    assert.match(
      guardJob,
      /if: github\.event_name == 'pull_request' \|\| github\.event_name == 'merge_group'\n/
    );
    assert.match(guardJob, /checks: read\n/);
    assert.match(guardJob, /pull-requests: write\n/);
    assert.match(guardJob, /fetch-depth: 0\n/);
    assert.match(guardJob, /persist-credentials: false\n/);
    assert.match(ci, /checks: read\n/);
  });

  it('runs on every pull request event the guard reads, and on the merge queue', () => {
    assert.match(
      ci,
      /pull_request:\n {4}types: \[opened, synchronize, reopened, ready_for_review, converted_to_draft, labeled, unlabeled\]\n {2}merge_group:\n {4}types: \[checks_requested\]\n/
    );
  });

  it('feeds the guard into the verdict all-green reads', () => {
    assert.match(review, /needs: \[guard, plan, record\]\n/);
    assert.match(review, /say needs-coordinator-review "cert-review: needs coordinator review/);
    assert.match(ci, /needs: \[runner, ci, cert, cert-review\]\n/);
  });

  it('keeps a label change from repeating the review of the same head, and lets it cancel nothing that a draft could outlive', () => {
    assert.doesNotMatch(ci, /&& 'label' \|\| 'head'/);
    assert.match(
      ci,
      /\n {2}group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}\n/
    );
    assert.match(review, /skip reused "verdict reused/);
  });
});
