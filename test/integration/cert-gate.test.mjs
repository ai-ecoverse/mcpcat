import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const work = mkdtempSync(join(tmpdir(), 'mcpcat-cert-gate-plan-'));
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

const plan = stepScript(
  'cert-review.yml',
  'What is under review, against what, and whether it changes shipped behaviour'
);

const repo = join(work, 'repo');
const git = (...args) => {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};
mkdirSync(repo, { recursive: true });
git('init', '-q', '-b', 'main');
git('config', 'user.email', 'test@example.com');
git('config', 'user.name', 'test');
git('config', 'commit.gpgsign', 'false');
cpSync(join(root, 'scripts/cert-review'), join(repo, 'scripts/cert-review'), {
  recursive: true,
});
mkdirSync(join(repo, '.github/workflows'), { recursive: true });
for (const f of ['ci.yml', 'cert-review.yml', 'cert-verify.yml', 'release.yml'])
  cpSync(join(root, '.github/workflows', f), join(repo, '.github/workflows', f));
cpSync(join(root, 'scripts/kernel-test-files.mjs'), join(repo, 'scripts/kernel-test-files.mjs'));
const KERNEL_TEST = "import { kernel } from './helpers/kernel.mjs';\nkernel();\n";
mkdirSync(join(repo, 'test/integration'), { recursive: true });
writeFileSync(join(repo, 'test/integration/on-kernel.test.mjs'), KERNEL_TEST);
writeFileSync(join(repo, 'README.md'), '1\n');
mkdirSync(join(repo, 'src'), { recursive: true });
writeFileSync(join(repo, 'src/a.ts'), '1\n');
git('add', '-A');
git('commit', '-q', '-m', 'base');
const base = git('rev-parse', 'HEAD');

function branch(name, files) {
  git('checkout', '-q', '-b', name, base);
  for (const [f, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, f)), { recursive: true });
    writeFileSync(join(repo, f), text);
  }
  git('add', '-A');
  git('commit', '-q', '-m', name);
  return git('rev-parse', 'HEAD');
}

function runPlan(label, head) {
  const dir = join(work, label);
  const bin = join(dir, 'bin');
  const temp = join(dir, 'temp');
  mkdirSync(bin, { recursive: true });
  mkdirSync(temp, { recursive: true });
  for (const [name, body] of [
    ['npm', 'echo 1.2.3'],
    ['gh', 'echo false'],
  ]) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const output = join(temp, 'output');
  writeFileSync(output, '');
  const r = spawnSync('bash', ['-e', '-c', plan], {
    cwd: repo,
    encoding: 'utf8',
    env: {
      PATH: [bin, process.env.PATH].join(delimiter),
      HOME: dir,
      RUNNER_TEMP: temp,
      GITHUB_STEP_SUMMARY: join(temp, 'summary.md'),
      GITHUB_OUTPUT: output,
      NODE_NO_WARNINGS: '1',
      EVENT: 'pull_request',
      REPO: 'o/r',
      PR_NUMBER: '7',
      PR_HEAD: head,
      PR_BASE: base,
      PR_HEAD_REPO: 'o/r',
      PR_DRAFT: 'false',
    },
  });
  const out = Object.fromEntries(
    readFileSync(output, 'utf8')
      .split('\n')
      .filter((l) => l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])
  );
  return { code: r.status, log: `${r.stdout}${r.stderr}`, out };
}

describe("cert-review plan: a change to the gate gets the gate's full review", () => {
  for (const [name, file] of [
    ['cert-review.yml', '.github/workflows/cert-review.yml'],
    ['ci.yml', '.github/workflows/ci.yml'],
    ['the post-publish verify', 'scripts/cert-review/published.mjs'],
    ['cert-verify.yml', '.github/workflows/cert-verify.yml'],
    ['the kernel test set', 'scripts/kernel-test-files.mjs'],
  ]) {
    it(`reviews a pull request that changes only ${name}`, () => {
      const head = branch(`only-${name.replace(/\W/g, '-')}`, {
        [file]: `${readFileSync(join(repo, file), 'utf8')}\n`,
      });
      const r = runPlan(`only-${name.replace(/\W/g, '-')}`, head);
      assert.equal(r.code, 0, r.log);
      assert.equal(r.out.go, 'true', r.log);
      assert.equal(r.out.reason, 'review');
      assert.equal(r.out.version, '0.0.0-pr.7');
    });
  }

  it("reviews a gate change that teaches the subject's classifier to call it not behaviour", () => {
    const head = branch('blind-classifier', {
      'scripts/cert-review/shipped.mjs':
        "console.log('not behaviour: none of the 0 changed files is shipped');\n",
      '.github/workflows/ci.yml': 'name: ci\n',
    });
    const r = runPlan('blind-classifier', head);
    assert.equal(r.code, 0, r.log);
    assert.match(r.log, /^not behaviour: /m);
    assert.match(r.log, /^base gate: behaviour: /m);
    assert.equal(r.out.go, 'true', r.log);
  });

  it("fails closed when the subject's classifier prints no verdict", () => {
    const head = branch('mute-classifier', {
      'scripts/cert-review/shipped.mjs': '\n',
    });
    const r = runPlan('mute-classifier', head);
    assert.notEqual(r.code, 0, r.log);
    assert.match(r.log, /INCOMPLETE: shipped\.mjs printed no behaviour verdict/);
    assert.notEqual(r.out.go, 'true');
  });

  for (const file of [
    'test/integration/cert-row-secrets.test.mjs',
    'test/integration/webmcp.test.mjs',
    'test/integration/cert-gate.test.mjs',
    'test/integration/helpers/isolate.mjs',
  ]) {
    it(`reviews a pull request that changes only the evidence test ${file}`, () => {
      const label = `evidence-${file.replace(/\W/g, '-')}`;
      const r = runPlan(label, branch(label, { [file]: 'it.skip\n' }));
      assert.equal(r.code, 0, r.log);
      assert.match(r.log, /^behaviour: 1 gate file changed: /m);
      assert.equal(r.out.go, 'true', r.log);
    });
  }

  it('reviews a pull request that weakens a test the pinned kernels run', () => {
    const file = 'test/integration/on-kernel.test.mjs';
    const r = runPlan('weak-kernel', branch('weak-kernel', { [file]: 'it.skip\n' }));
    assert.equal(r.code, 0, r.log);
    assert.match(
      r.log,
      /^behaviour: 1 gate file changed: test\/integration\/on-kernel\.test\.mjs$/m
    );
    assert.equal(r.out.go, 'true', r.log);
  });

  it('reviews a pull request that adds a test the pinned kernels run', () => {
    const file = 'test/integration/new-kernel.test.mjs';
    const r = runPlan('new-kernel', branch('new-kernel', { [file]: KERNEL_TEST }));
    assert.equal(r.code, 0, r.log);
    assert.equal(r.out.go, 'true', r.log);
  });

  it('feeds a changed soak into the NEGATIVE like any changed test', async () => {
    const { CHANGED_TEST } = await import(join(root, 'scripts/cert-review/classify.mjs'));
    assert.ok(CHANGED_TEST.test('test/integration/serve-soak.cert.mjs'));
    assert.ok(CHANGED_TEST.test('test/integration/proxy.test.mjs'));
    assert.ok(!CHANGED_TEST.test('test/integration/helpers/kernel.mjs'));
    const stage = readFileSync(join(root, 'scripts/cert-review/stage.mjs'), 'utf8');
    assert.match(stage, /\.filter\(\(f\) => CHANGED_TEST\.test\(f\)\)/);
  });

  it('still skips a change to neither shipped nor gate files', () => {
    const head = branch('docs-only', {
      'README.md': '2\n',
      '.github/workflows/renovate.yml': 'x\n',
      'test/integration/x.test.mjs': 'x\n',
    });
    const r = runPlan('docs-only', head);
    assert.equal(r.code, 0, r.log);
    assert.equal(r.out.go, 'false', r.log);
    assert.equal(r.out.reason, 'not-behaviour');
  });
});
