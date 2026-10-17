import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const tools = join(root, 'scripts/cert-review');
const work = mkdtempSync(join(tmpdir(), 'mcpcat-cert-verify-'));
after(() => rmSync(work, { recursive: true, force: true }));

const NAME = '@ai-ecoverse/mcpcat';
const VERSION = '9.8.7';
const PREV = '9.8.6';
const REPO = 'ai-ecoverse/mcpcat';
const COMMIT = 'b'.repeat(40);
const RUN = 'https://github.com/ai-ecoverse/mcpcat/actions/runs/1';

function tarball(name, manifest) {
  const dir = join(work, `${name}-src`);
  mkdirSync(join(dir, 'package/dist'), { recursive: true });
  writeFileSync(join(dir, 'package/package.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(dir, 'package/dist/mcpcat.mjs'), `export const name = "${name}";\n`);
  const tgz = join(work, `${name}.tgz`);
  assert.equal(spawnSync('tar', ['-czf', tgz, '-C', dir, 'package']).status, 0);
  return tgz;
}

const onNpm = tarball('npm', { name: NAME, version: VERSION });
const elsewhere = tarball('elsewhere', { name: NAME, version: VERSION, description: 'x' });
const digest = (tgz, algo, enc) => createHash(algo).update(readFileSync(tgz)).digest(enc);
const SHA = digest(onNpm, 'sha256', 'hex');

function setup(name, { prs = {}, notes = 'release notes', served = onNpm, release = true } = {}) {
  const statement = {
    subject: [
      {
        name: `pkg:npm/%40ai-ecoverse/mcpcat@${VERSION}`,
        digest: { sha512: digest(onNpm, 'sha512', 'hex') },
      },
    ],
    predicate: {
      buildDefinition: {
        externalParameters: {
          workflow: {
            repository: `https://github.com/${REPO}`,
            path: '.github/workflows/release.yml',
            ref: 'refs/heads/main',
          },
        },
        resolvedDependencies: [{ digest: { gitCommit: COMMIT } }],
      },
    },
  };
  const attestations = {
    attestations: [
      {
        predicateType: 'https://slsa.dev/provenance/v1',
        bundle: {
          dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString('base64') },
        },
      },
    ],
  };
  const api = {
    [`repos/${REPO}/git/ref/tags/v${VERSION}`]: { object: { type: 'commit', sha: COMMIT } },
    [`repos/${REPO}/compare/main...${COMMIT}`]: { status: 'behind' },
    [`repos/${REPO}/tags?per_page=100`]: [
      { name: `v${VERSION}` },
      { name: `v${PREV}` },
      { name: 'v9.8.5' },
      { name: 'v10.0.0' },
    ],
    [`repos/${REPO}/compare/v${PREV}...v${VERSION}`]: {
      commits: [
        { commit: { message: 'fix: a thing' } },
        ...Object.keys(prs).map((n) => ({
          commit: { message: `Merge pull request #${n} from ai-ecoverse/b${n}\n\nx` },
        })),
      ],
    },
  };
  for (const [n, status] of Object.entries(prs)) {
    const head = n.padEnd(40, 'a');
    api[`repos/${REPO}/pulls/${n}`] = { head: { sha: head } };
    api[`repos/${REPO}/commits/${head}/statuses`] = status
      ? [
          { context: 'ci', state: 'failure' },
          { context: 'cert-review', ...status },
        ]
      : [];
  }
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  const notesFile = join(dir, 'notes.md');
  writeFileSync(notesFile, notes);
  const facts = {
    npm: {
      name: NAME,
      version: VERSION,
      gitHead: COMMIT,
      dist: {
        integrity: `sha512-${digest(onNpm, 'sha512', 'base64')}`,
        attestations: {
          url: `data:application/json;base64,${Buffer.from(JSON.stringify(attestations)).toString('base64')}`,
        },
      },
    },
    api,
    release,
    notesFile,
    served,
    edits: join(dir, 'edits.log'),
  };
  const file = join(dir, 'facts.json');
  writeFileSync(file, JSON.stringify(facts));
  const stub = (body) =>
    `#!/usr/bin/env node\nconst fs = require('node:fs');\nconst f = JSON.parse(fs.readFileSync(${JSON.stringify(file)}, 'utf8'));\nconst a = process.argv.slice(2);\n${body}\n`;
  const spec = `${NAME}@${VERSION}`;
  writeFileSync(
    join(dir, 'npm'),
    stub(
      [
        `if (a[0] === 'view' && a[1] === '${spec}' && a[2] === '--json') process.stdout.write(JSON.stringify(f.npm));`,
        `else if (a[0] === 'install' && a.at(-1) === '${spec}') process.exit(0);`,
        `else if (a[0] === 'pack' && a[1] === '${spec}') fs.copyFileSync(f.served, require('node:path').join(a[a.indexOf('--pack-destination') + 1], 'served.tgz'));`,
        "else if (a[0] === 'audit' && a[1] === 'signatures') process.stdout.write('1 package has a verified attestation\\n');",
        'else process.exit(1);',
      ].join('\n')
    )
  );
  writeFileSync(
    join(dir, 'gh'),
    stub(
      [
        `const release = 'repos/${REPO}/releases/tags/v${VERSION}';`,
        "if (a[0] === 'api' && a[1] === release) { if (!f.release) process.exit(1); process.stdout.write(JSON.stringify({ body: fs.readFileSync(f.notesFile, 'utf8') })); }",
        "else if (a[0] === 'api' && a[1] === '--paginate' && f.api[a.at(-1)]) process.stdout.write(JSON.stringify([f.api[a.at(-1)]]));",
        "else if (a[0] === 'api' && f.api[a[1]]) process.stdout.write(JSON.stringify(f.api[a[1]]));",
        `else if (a[0] === 'release' && a[1] === 'edit' && a[2] === 'v${VERSION}') { fs.copyFileSync(a[a.indexOf('--notes-file') + 1], f.notesFile); fs.appendFileSync(f.edits, 'edit\\n'); }`,
        'else process.exit(1);',
      ].join('\n')
    )
  );
  chmodSync(join(dir, 'npm'), 0o755);
  chmodSync(join(dir, 'gh'), 0o755);
  const env = {
    ...process.env,
    NODE_NO_WARNINGS: '1',
    PATH: [dir, process.env.PATH].join(delimiter),
  };
  delete env.NODE_TEST_CONTEXT;
  delete env.GITHUB_STEP_SUMMARY;
  delete env.GITHUB_OUTPUT;
  const tool = (script, args) => {
    const r = spawnSync(process.execPath, [join(tools, script), ...args], {
      encoding: 'utf8',
      env,
    });
    return {
      code: r.status,
      out: `${r.stdout}${r.stderr}`,
      last: r.stdout.trim().split('\n').at(-1),
    };
  };
  const out = join(dir, 'certify.json');
  return {
    notesFile,
    edits: () =>
      existsSync(facts.edits) ? readFileSync(facts.edits, 'utf8').split('\n').length - 1 : 0,
    certify: () => {
      const r = tool('certify.mjs', [
        '--version',
        VERSION,
        '--repo',
        REPO,
        '--run',
        RUN,
        '--wait',
        '0',
        '--out',
        out,
      ]);
      return { ...r, rec: JSON.parse(readFileSync(out, 'utf8')) };
    },
    notes: (line, sha256 = SHA) =>
      tool('notes.mjs', ['--version', VERSION, '--repo', REPO, '--line', line, '--sha256', sha256]),
  };
}

const green = { state: 'success', description: `certified ${NAME}@0.0.0-pr.12 sha256=…` };
const skipped = {
  state: 'success',
  description: 'not behaviour: no shipped file changed, so no review (skipped)',
};

describe('cert-verify: the release line, from npm and every pull request since the previous tag', () => {
  it('certifies when every pull request carries a green cert-review on its head, and writes it once', () => {
    const s = setup('all-green', { prs: { 12: green, 14: skipped } });
    const r = s.certify();
    assert.equal(r.code, 0, r.out);
    assert.equal(r.rec.state, 'success');
    assert.equal(r.rec.word, 'certified');
    assert.equal(r.rec.notes, 'to write');
    assert.match(
      r.rec.line,
      new RegExp(
        `^certified ${NAME}@${VERSION} sha256=${SHA} \\(ci: ${RUN}; npm: sha512-\\S+, provenance \\.github/workflows/release\\.yml@refs/heads/main commit ${COMMIT} = gitHead = tag v${VERSION}; pr-certified since v${PREV}: #12 certified at 12a{10}, #14 not behaviour at 14a{10}\\)$`
      )
    );
    const n = s.notes(r.rec.line);
    assert.equal(n.code, 0, n.out);
    assert.match(n.last, /^notes: wrote into v9\.8\.7's release notes: certified /);
    const body = readFileSync(s.notesFile, 'utf8');
    assert.ok(body.startsWith('release notes\n\n<!-- cert-verify -->\ncertified '), body);
    const again = s.notes(r.rec.line);
    assert.equal(again.code, 0, again.out);
    assert.match(again.last, /^notes: v9\.8\.7 already carries: /);
    assert.equal(s.edits(), 1);
    assert.equal(s.certify().rec.notes, 'unchanged');
  });

  it('only verifies when a pull request has no green cert-review on its head', () => {
    const s = setup('one-missing', {
      prs: { 12: green, 13: undefined, 15: { state: 'error', description: 'cert-ci: INCOMPLETE' } },
    });
    const r = s.certify();
    assert.equal(r.code, 0, r.out);
    assert.equal(r.rec.word, 'verified');
    assert.match(
      r.rec.line,
      /^verified .*pr-certified since v9\.8\.6: not all: #13 has no cert-review on its head 13a{10}, #15 has cert-review error on its head 15a{10}, #12 certified at 12a{10}\)$/
    );
  });

  it('raises a supply-chain alert when the notes already name another sha for this version', () => {
    const other = 'f'.repeat(64);
    const s = setup('conflict', {
      prs: { 12: green },
      notes: `x\n\ncertified ${NAME}@${VERSION} sha256=${other} (ci: old)\n`,
    });
    const r = s.certify();
    assert.equal(r.code, 1, r.out);
    assert.equal(r.rec.state, 'failure');
    assert.match(
      r.rec.line,
      new RegExp(
        `^supply-chain alert: .*already name ${NAME}@${VERSION} sha256=${other}, but npm serves sha256=${SHA}`
      )
    );
    const line = `certified ${NAME}@${VERSION} sha256=${SHA} (ci: ${RUN}; x)`;
    const n = s.notes(line);
    assert.equal(n.code, 1, n.out);
    assert.match(n.last, /^supply-chain alert: .*the notes stay as they are/);
    assert.equal(s.edits(), 0);
  });

  it('raises a supply-chain alert when npm serves bytes other than the SLSA subject', () => {
    const s = setup('bytes', { prs: { 12: green }, served: elsewhere });
    const r = s.certify();
    assert.equal(r.code, 1, r.out);
    assert.equal(r.rec.state, 'failure');
    assert.match(r.rec.line, /^supply-chain alert: .*dist\.integrity is .*, the tarball is/);
  });

  it('is INCOMPLETE, never certified, when the release notes cannot be read', () => {
    const s = setup('no-release', { prs: { 12: green }, release: false });
    const r = s.certify();
    assert.equal(r.code, 1, r.out);
    assert.equal(r.rec.state, 'error');
    assert.match(r.rec.line, /^cert-ci: INCOMPLETE .*couldn't be read/);
  });

  it('writes nothing from a malformed line or a line whose sha is not the one verify output', () => {
    const s = setup('malformed');
    const bad = s.notes('certified something else');
    assert.equal(bad.code, 1, bad.out);
    assert.match(bad.last, /^cert-ci: INCOMPLETE .*no well-formed line/);
    const line = `certified ${NAME}@${VERSION} sha256=${SHA} (ci: ${RUN}; x)`;
    const swapped = s.notes(line, 'e'.repeat(64));
    assert.equal(swapped.code, 1, swapped.out);
    assert.equal(s.edits(), 0);
  });
});

describe('cert-verify.yml: who runs it, and who may write', () => {
  const text = readFileSync(join(root, '.github/workflows/cert-verify.yml'), 'utf8');
  const lines = text.split('\n');
  const start = lines.indexOf('jobs:');
  const jobs = {};
  let current;
  for (const line of lines.slice(start + 1)) {
    const m = /^ {2}([\w-]+):$/.exec(line);
    if (m) {
      current = m[1];
      jobs[current] = [];
    } else if (current) jobs[current].push(line);
  }
  const block = (name) => jobs[name].join('\n');
  const needs = (name) => {
    const m = /^ {4}needs: (.+)$/m.exec(block(name));
    return m
      ? m[1]
          .replace(/[[\]]/g, '')
          .split(',')
          .map((n) => n.trim())
      : [];
  };
  const chainsTo = (name, root) => name === root || needs(name).some((n) => chainsTo(n, root));

  it('only runs from main on dispatch: the tag job guards it, and every other job needs tag', () => {
    assert.deepEqual(Object.keys(jobs).sort(), ['alert', 'notes', 'tag', 'verify']);
    assert.match(
      block('tag'),
      /\(github\.event_name == 'workflow_dispatch' && github\.ref == 'refs\/heads\/main'\)/
    );
    assert.match(block('tag'), /github\.event\.workflow_run\.head_branch == 'main'/);
    for (const name of Object.keys(jobs).filter((n) => n !== 'tag'))
      assert.ok(chainsTo(name, 'tag') && needs(name).includes('tag'), `${name} needs tag`);
  });

  it('gives contents: write to the notes job alone, and reads everywhere else', () => {
    const head = lines.slice(0, start).join('\n');
    assert.match(head, /^permissions:\n {2}contents: read$/m);
    for (const name of Object.keys(jobs)) {
      const writes = /^ {6}contents: write$/m.test(block(name));
      assert.equal(writes, name === 'notes', `${name} contents: write`);
    }
    assert.match(block('notes'), /^ {4}permissions:\n {6}contents: write\n {4}env:/m);
    assert.match(block('alert'), /^ {4}permissions:\n {6}issues: write\n {4}env:/m);
    assert.doesNotMatch(block('verify'), /: write$/m);
    assert.doesNotMatch(block('tag'), /permissions:/);
  });
});
