import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const work = mkdtempSync(join(tmpdir(), 'mcpcat-cert-verdicts-'));
after(() => rmSync(work, { recursive: true, force: true }));

function stepScript(workflow, name) {
  const yml = readFileSync(join(root, '.github/workflows', workflow), 'utf8').split('\n');
  const at = yml.findIndex((l) => l.trim() === `- name: ${name}`);
  assert.notEqual(at, -1, `${workflow} has a step named ${name}`);
  const run = yml.findIndex((l, i) => i > at && /^\s+run: \|$/.test(l));
  const from = run + 1;
  const indent = yml[from].length - yml[from].trimStart().length;
  const to = yml.findIndex(
    (l, i) => i >= from && l.trim() && l.length - l.trimStart().length < indent
  );
  return yml
    .slice(from, to === -1 ? undefined : to)
    .map((l) => l.slice(indent))
    .join('\n');
}

function shim(dir, name, body) {
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, name), 0o755);
}

function runStep(label, script, env, shims = {}) {
  const dir = join(work, label);
  const bin = join(dir, 'bin');
  const temp = join(dir, 'temp');
  mkdirSync(bin, { recursive: true });
  mkdirSync(temp, { recursive: true });
  for (const [name, body] of Object.entries(shims)) shim(bin, name, body);
  const r = spawnSync('bash', ['-e', '-c', script], {
    cwd: root,
    encoding: 'utf8',
    env: {
      PATH: [bin, process.env.PATH].join(delimiter),
      HOME: dir,
      RUNNER_TEMP: temp,
      GITHUB_STEP_SUMMARY: join(temp, 'summary.md'),
      NODE_NO_WARNINGS: '1',
      ...env,
    },
  });
  return { code: r.status, out: `${r.stdout}${r.stderr}`, bin };
}

describe('silence never passes: all-green', () => {
  const script = stepScript('ci.yml', 'The verdict the merge queue requires');
  const green = {
    RUNNER_RESULT: 'success',
    CI_RESULT: 'success',
    CERT_RESULT: 'success',
    REVIEW_RESULT: 'success',
  };

  for (const verdict of ['certified', 'not-behaviour', 'none']) {
    it(`passes with every job green and the cert-review verdict ${verdict}`, () => {
      const r = runStep(`ag-${verdict}`, script, { ...green, VERDICT: verdict });
      assert.equal(r.code, 0, r.out);
      assert.match(
        r.out,
        new RegExp(
          `^all-green: PASS runner=success ci=success cert=success cert-review=success \\(${verdict}\\)$`,
          'm'
        )
      );
    });
  }

  for (const [what, env, why] of [
    ['cert-review printed no verdict', { ...green }, /\(no verdict\)/],
    ['a job that never ran', { ...green, CERT_RESULT: '', VERDICT: 'certified' }, /cert=none/],
    ['a failed job', { ...green, CI_RESULT: 'failure', VERDICT: 'certified' }, /ci=failure/],
    [
      'a missing coordinator approval',
      { ...green, VERDICT: 'needs-coordinator-review' },
      /\(needs-coordinator-review\)/,
    ],
    ['an INCOMPLETE verdict', { ...green, VERDICT: 'incomplete' }, /\(incomplete\)/],
  ]) {
    it(`fails, with its verdict line, on ${what}`, () => {
      const r = runStep(`ag-${what.replace(/\W+/g, '-')}`, script, env);
      assert.equal(r.code, 1, r.out);
      assert.match(r.out, /^all-green: FAIL /m);
      assert.match(r.out, why);
    });
  }
});

describe('silence never passes: the cert job', () => {
  const script = stepScript('ci.yml', 'Run cert with the kernel slicc-bios ships');
  const kernel = spawnSync('bash', ['-c', `${script.split('\n')[0]}\nprintf '%s' "$kernel"`], {
    cwd: root,
    encoding: 'utf8',
  }).stdout;
  assert.match(kernel, /^\d+\.\d+\.\d+$/);
  const npm = (out, code = 0) => ({ npm: `printf '%s\\n' ${JSON.stringify(out)}\nexit ${code}` });

  it("passes when cert prints its kernel's passing line", () => {
    const r = runStep(
      'cert-ok',
      script,
      {},
      npm(`cert: kernel ${kernel} — 12 kernel tests passed`)
    );
    assert.equal(r.code, 0, r.out);
    assert.match(
      r.out,
      new RegExp(`^cert: PASS — cert: kernel ${kernel} — 12 kernel tests passed$`, 'm')
    );
  });

  for (const [what, out] of [
    ['prints nothing', ''],
    ['passes no kernel test', `cert: kernel ${kernel} — 0 kernel tests passed`],
    ['ran another kernel', 'cert: kernel 0.0.1 — 12 kernel tests passed'],
  ]) {
    it(`fails when cert exits 0 but ${what}`, () => {
      const r = runStep(`cert-${what.replace(/\W+/g, '-')}`, script, {}, npm(out));
      assert.equal(r.code, 1, r.out);
      assert.match(
        r.out,
        new RegExp(`^cert: FAIL — cert printed no passing verdict for \\S+ ${kernel}$`, 'm')
      );
    });
  }
});

describe('silence never passes: release verify and the installer tests', () => {
  const verify = stepScript(
    'release.yml',
    "The registry's bytes, the SLSA subject, provenance on main and gitHead = tag"
  );
  const gh = { gh: `echo "gh $*" >> "$RUNNER_TEMP/gh.log"` };

  it('passes on the verified line', () => {
    const line = `verified @ai-ecoverse/mcpcat@9.8.7 sha256=${'a'.repeat(64)} on npm: x`;
    const r = runStep(
      'verify-ok',
      verify,
      { TAG: 'v9.8.7', RUN_URL: 'https://example.invalid/run' },
      { ...gh, node: `printf '%s\\n' ${JSON.stringify(line)}` }
    );
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^verified @ai-ecoverse\/mcpcat@9\.8\.7 sha256=a{64} /m);
  });

  it('files the supply-chain alert when published.mjs exits 0 and prints nothing', () => {
    const r = runStep(
      'verify-silent',
      verify,
      { TAG: 'v9.8.7', RUN_URL: 'https://example.invalid/run' },
      { ...gh, node: 'exit 0' }
    );
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /published\.mjs printed no verdict/);
    const log = readFileSync(join(work, 'verify-silent', 'temp', 'gh.log'), 'utf8');
    assert.match(log, /^gh issue create --title supply-chain alert: @ai-ecoverse\/mcpcat@9\.8\.7/m);
  });

  const install = stepScript('binaries.yml', 'Installer test, ubuntu with node');

  it('passes the installer step on its verdict line', () => {
    const r = runStep(
      'install-ok',
      install,
      { TAG: 'v9.8.7' },
      {
        sh: "echo 'All installer tests passed.'",
      }
    );
    assert.equal(r.code, 0, r.out);
  });

  it('fails the installer step when test-install.sh exits 0 and prints nothing', () => {
    const r = runStep('install-silent', install, { TAG: 'v9.8.7' }, { sh: 'exit 0' });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /^installer: FAIL — test-install\.sh printed no verdict$/m);
  });

  it('requires a behaviour verdict from shipped.mjs before the plan reads it', () => {
    const plan = stepScript(
      'cert-review.yml',
      'What is under review, against what, and whether it changes shipped behaviour'
    );
    const at = plan.indexOf('node scripts/cert-review/shipped.mjs');
    const check = plan.indexOf("grep -qE '^(behaviour|not behaviour): '");
    const read = plan.indexOf('head -1 "$RUNNER_TEMP/shipped.txt" | grep -q \'^behaviour:\'');
    assert.ok(
      at > 0 && check > at && read > check,
      'the check sits between shipped.mjs and its reader'
    );
  });
});

describe('a draft is not reviewed, and its cert-review is red', () => {
  const verdict = stepScript('cert-review.yml', 'The outcome all-green reads');
  const fallback = stepScript(
    'cert-review.yml',
    'A run that ends without a recorded verdict still leaves a cert-review status, so the required check never waits forever'
  );

  it('the verdict job fails a draft with its line', () => {
    const r = runStep('draft-verdict', verdict, {
      GUARD: 'success',
      PLAN: 'success',
      GO: 'false',
      REASON: 'draft',
      GITHUB_OUTPUT: join(work, 'draft-verdict.out'),
    });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /^cert-review: draft: not reviewed, mark it ready for review$/m);
  });

  it('the fallback posts failure, never pending or success, on the draft head', () => {
    const r = runStep(
      'draft-fallback',
      fallback,
      { HEAD_SHA: 'a'.repeat(40), OUTCOME: 'draft', REASON: 'draft', GH_REPO: 'o/r', RUN_URL: 'u' },
      { gh: 'printf "%s\\n" "$*" >> "$(dirname "$0")/gh.log"' }
    );
    assert.equal(r.code, 0, r.out);
    const log = readFileSync(join(r.bin, 'gh.log'), 'utf8');
    assert.match(log, /-f state=failure -f context=cert-review/);
    assert.match(log, /description=draft: not reviewed, mark it ready for review/);
  });

  it('the plan skips a draft pull request before any review, and ci reruns on ready and on converted_to_draft', () => {
    const plan = stepScript(
      'cert-review.yml',
      'What is under review, against what, and whether it changes shipped behaviour'
    );
    const draft = plan.indexOf('if [ "$mode" = pr ] && [ "$draft" != false ]; then');
    assert.ok(
      plan.indexOf(`draft=$(gh api "repos/$REPO/pulls/$pr" --jq '.draft' || echo unknown)`) > 0,
      'a ready payload is checked against the pull request as it is now'
    );
    assert.ok(
      draft > 0 && draft < plan.indexOf('emit "go=true"'),
      'the draft skip comes before go=true'
    );
    const ci = readFileSync(join(root, '.github/workflows/ci.yml'), 'utf8');
    assert.match(
      ci,
      /types: \[opened, synchronize, reopened, ready_for_review, converted_to_draft, labeled, unlabeled\]/
    );
    assert.match(
      ci,
      /^ {2}group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.event\.pull_request\.number \|\| github\.ref \}\}\n {2}cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}$/m,
      'one concurrency group per pull request: converted_to_draft cancels every run, label runs included'
    );
    const workflow = readFileSync(join(root, '.github/workflows/cert-review.yml'), 'utf8');
    assert.match(workflow, /PR_DRAFT: \$\{\{ github\.event\.pull_request\.draft \}\}/);
  });
});
