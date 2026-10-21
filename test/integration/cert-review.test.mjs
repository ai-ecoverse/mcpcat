import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const tools = join(root, 'scripts/cert-review');
const work = mkdtempSync(join(tmpdir(), 'mcpcat-cert-gate-'));
after(() => rmSync(work, { recursive: true, force: true }));

const NAME = '@ai-ecoverse/mcpcat';
const VERSION = '9.8.7';

function tarball(name, manifest, code = `export const name = ${JSON.stringify(name)};\n`) {
  const dir = join(work, `${name}-src`);
  mkdirSync(join(dir, 'package/dist'), { recursive: true });
  writeFileSync(join(dir, 'package/package.json'), JSON.stringify(manifest, null, 2));
  writeFileSync(join(dir, 'package/dist/mcpcat.mjs'), code);
  const tgz = join(work, `${name}.tgz`);
  const r = spawnSync('tar', ['-czf', tgz, '-C', dir, 'package']);
  assert.equal(r.status, 0);
  return { tgz, sha256: createHash('sha256').update(readFileSync(tgz)).digest('hex') };
}

function tool(script, args, extra = {}) {
  const env = { ...process.env, NODE_NO_WARNINGS: '1', ...extra };
  delete env.NODE_TEST_CONTEXT;
  delete env.GITHUB_STEP_SUMMARY;
  delete env.GITHUB_OUTPUT;
  const r = spawnSync(process.execPath, [join(tools, script), ...args], { encoding: 'utf8', env });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

const ROWS = JSON.parse(readFileSync(join(tools, 'rows.json'), 'utf8'));

function evidence(name, version, sha256, change = (_stage, _suites) => {}) {
  const dir = join(work, `${name}-evidence`);
  mkdirSync(dir, { recursive: true });
  const kernels = [{ version: '1.2.3' }, { version: '1.0.0' }];
  const names = [...new Set(Object.values(ROWS).flat())];
  const stage = {
    version,
    subject: { commit: '1'.repeat(40) },
    base: { commit: '2'.repeat(40) },
    negative: {
      tests: '1'.repeat(40),
      base: '2'.repeat(40),
      fromBase: ['dist', 'scripts', '.github/workflows'],
    },
    artifact: { sha256 },
    kernels,
    changedTests: [],
    delta: { shipped: ['src/a.ts'], gate: [] },
    rebuildDiff: { identical: true, explained: [], unexplained: [] },
    surface: { [version]: { kernelBundle: { imports: [] } } },
  };
  const ok = (n, kernel) => ({
    name: n,
    ok: true,
    exit: 0,
    pass: 10,
    fail: 0,
    failed: [],
    kernelSeen: kernel ? true : undefined,
  });
  const suites = {
    version,
    rows: ROWS,
    hostRows: names.slice(0, 3),
    kernelRows: names.slice(3),
    negative: [],
    results: [
      ok('subject host suite'),
      ok('rows host'),
      ...kernels.flatMap((k) => [
        ok(`subject cert kernel ${k.version}`, true),
        ok(`rows kernel ${k.version}`, true),
      ]),
    ],
  };
  change(stage, suites);
  writeFileSync(join(dir, 'stage.json'), JSON.stringify(stage));
  writeFileSync(join(dir, 'suites.json'), JSON.stringify(suites));
  return dir;
}

const good = tarball('good', { name: NAME, version: VERSION });
const other = tarball('other', { name: NAME, version: VERSION, description: 'other bytes' });

describe('cert-review record: the line comes from the artifact, not the reviewer', () => {
  function review(name, verdict) {
    const dir = join(work, `${name}-review`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'verdict.json'), JSON.stringify(verdict));
    return dir;
  }

  it('never certifies a planted build', () => {
    const out = join(work, 'rec-planted');
    const r = tool('record.mjs', [
      '--version',
      VERSION,
      '--review',
      review('planted', { verdict: 'certified', known: [] }),
      '--out',
      out,
      '--tarball',
      good.tgz,
      '--sha256',
      good.sha256,
      '--planted',
      'proof/planted',
    ]);
    assert.equal(r.code, 1, r.out);
    const rec = JSON.parse(readFileSync(join(out, 'record.json'), 'utf8'));
    assert.equal(rec.certified, false);
    assert.equal(rec.sha256, null);
    assert.equal(rec.facts.sha256, good.sha256);
    assert.match(rec.line, /^cert-ci: FAIL .*planted proof\/planted/);
    assert.equal(rec.state, 'failure');
  });

  it('fails when the artifact is not what the pack job hashed', () => {
    const out = join(work, 'rec-swap');
    const r = tool('record.mjs', [
      '--version',
      VERSION,
      '--review',
      review('swap', { verdict: 'certified', known: [] }),
      '--out',
      out,
      '--tarball',
      other.tgz,
      '--sha256',
      good.sha256,
      '--planted',
      'proof/swap',
    ]);
    assert.equal(r.code, 1, r.out);
    const line = readFileSync(join(out, 'line.txt'), 'utf8');
    assert.match(
      line,
      new RegExp(`the artifact is sha256 ${other.sha256}, the pack job made ${good.sha256}`)
    );
  });

  it('holds a certified verdict from a review job that did not succeed', () => {
    const out = join(work, 'rec-held');
    const r = tool('record.mjs', [
      '--version',
      VERSION,
      '--review',
      review('held', { verdict: 'certified', known: [] }),
      '--out',
      out,
      '--tarball',
      good.tgz,
      '--sha256',
      good.sha256,
      '--upstream',
      'failure',
      '--planted',
      'proof/held',
    ]);
    assert.equal(r.code, 1, r.out);
    assert.match(readFileSync(join(out, 'line.txt'), 'utf8'), /held: the review job ended failure/);
  });
});

describe('cert-review record --source npm: the bytes already on npm', () => {
  const COMMIT = 'b'.repeat(40);
  const REPO = 'ai-ecoverse/mcpcat';
  const base = { name: NAME, version: VERSION, description: 'on npm' };
  const code = 'export const name = "on npm";\n';
  const onNpm = tarball('npm', base, code);
  const rebuilt = tarball('npm-rebuilt', { ...base, gitHead: COMMIT }, code);
  const hash = (algo, enc) => createHash(algo).update(readFileSync(onNpm.tgz)).digest(enc);
  const integrity = `sha512-${hash('sha512', 'base64')}`;

  function registry(
    name,
    {
      gitHead = COMMIT,
      gitCommit = COMMIT,
      dist = integrity,
      signed = true,
      served = onNpm.tgz,
      path = '.github/workflows/release.yml',
      ref = 'refs/heads/main',
    } = {}
  ) {
    const statement = {
      subject: [
        {
          name: `pkg:npm/%40ai-ecoverse/mcpcat@${VERSION}`,
          digest: { sha512: hash('sha512', 'hex') },
        },
      ],
      predicate: {
        buildDefinition: {
          externalParameters: {
            workflow: {
              repository: `https://github.com/${REPO}`,
              path,
              ref,
            },
          },
          resolvedDependencies: [{ digest: { gitCommit } }],
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
    const facts = {
      npm: {
        name: NAME,
        version: VERSION,
        gitHead,
        dist: {
          integrity: dist,
          attestations: {
            url: `data:application/json;base64,${Buffer.from(JSON.stringify(attestations)).toString('base64')}`,
          },
        },
      },
      gh: {
        [`repos/${REPO}/git/ref/tags/v${VERSION}`]: { object: { type: 'commit', sha: COMMIT } },
        [`repos/${REPO}/compare/main...${COMMIT}`]: { status: 'behind' },
      },
      signed,
      served,
    };
    const bin = join(work, `${name}-bin`);
    mkdirSync(bin, { recursive: true });
    const file = join(bin, 'facts.json');
    writeFileSync(file, JSON.stringify(facts));
    const stub = (body) =>
      `#!/usr/bin/env node\nconst f = JSON.parse(require('node:fs').readFileSync(${JSON.stringify(file)}, 'utf8'));\nconst a = process.argv.slice(2);\n${body}\n`;
    writeFileSync(
      join(bin, 'npm'),
      stub(
        [
          `const spec = '${NAME}@${VERSION}';`,
          "if (a[0] === 'view' && a[1] === spec && a[2] === '--json') process.stdout.write(JSON.stringify(f.npm));",
          "else if (a[0] === 'install' && a.at(-1) === spec) process.exit(0);",
          "else if (a[0] === 'pack' && a[1] === spec) require('node:fs').copyFileSync(f.served, require('node:path').join(a[a.indexOf('--pack-destination') + 1], 'served.tgz'));",
          "else if (a[0] === 'audit' && a[1] === 'signatures' && f.signed) process.stdout.write('1 package has a verified attestation\\n');",
          "else if (a[0] === 'audit' && a[1] === 'signatures') { process.stderr.write('1 package has an invalid attestation\\n'); process.exit(1); }",
          'else process.exit(1);',
        ].join('\n')
      )
    );
    writeFileSync(
      join(bin, 'gh'),
      stub(
        "const r = a[0] === 'api' && f.gh[a[1]]; if (r) { process.stdout.write(JSON.stringify(r)); } else { process.exit(1); }"
      )
    );
    chmodSync(join(bin, 'npm'), 0o755);
    chmodSync(join(bin, 'gh'), 0o755);
    return { PATH: [bin, process.env.PATH].join(delimiter) };
  }

  function record(
    name,
    env,
    { tgz = onNpm.tgz, sha256 = onNpm.sha256, rebuild = rebuilt.tgz } = {}
  ) {
    const dir = join(work, `${name}-review`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'verdict.json'), JSON.stringify({ verdict: 'certified', known: [] }));
    const out = join(work, `rec-${name}`);
    const r = tool(
      'record.mjs',
      [
        '--version',
        VERSION,
        '--review',
        dir,
        '--out',
        out,
        '--tarball',
        tgz,
        '--sha256',
        sha256,
        '--source',
        'npm',
        '--rebuilt',
        rebuild,
        '--repo',
        REPO,
        '--evidence',
        evidence(name, VERSION, sha256),
      ],
      env
    );
    return { ...r, rec: JSON.parse(readFileSync(join(out, 'record.json'), 'utf8')) };
  }

  it('certifies a tarball without gitHead whose registry gitHead and provenance are the tag', () => {
    const r = record('npm-ok', registry('npm-ok'));
    assert.equal(r.code, 0, r.out);
    assert.equal(r.rec.certified, true);
    assert.equal(r.rec.sha256, onNpm.sha256);
    assert.equal(r.rec.commit, COMMIT);
    assert.equal(
      r.rec.line,
      `certified ${NAME}@${VERSION} sha256=${onNpm.sha256} (ci: local; known: none)`
    );
    assert.deepEqual(r.rec.facts.rebuild.unexplained, []);
    assert.match(
      r.rec.facts.rebuild.explained.join(),
      /package\/package\.json: only gitHead differs/
    );
  });

  it('fails when the registry gitHead is not the tag', () => {
    const r = record('npm-head', registry('npm-head', { gitHead: 'c'.repeat(40) }));
    assert.equal(r.code, 1, r.out);
    assert.equal(r.rec.certified, false);
    assert.match(
      r.rec.line,
      new RegExp(
        `^cert-ci: FAIL .*the registry's gitHead is ${'c'.repeat(40)}, tag v${VERSION} is ${COMMIT}`
      )
    );
  });

  it('fails when the provenance commit is not the tag', () => {
    const r = record('npm-prov', registry('npm-prov', { gitCommit: 'd'.repeat(40) }));
    assert.equal(r.code, 1, r.out);
    assert.match(r.rec.line, /the provenance gitCommit is d{40}/);
  });

  it("fails when npm's dist.integrity is not the artifact's sha512", () => {
    const r = record('npm-int', registry('npm-int', { dist: 'sha512-AAAA' }));
    assert.equal(r.code, 1, r.out);
    assert.match(r.rec.line, /npm's dist\.integrity is sha512-AAAA/);
  });

  it('fails when npm audit signatures does not verify the attestation', () => {
    const r = record('npm-sig', registry('npm-sig', { signed: false }));
    assert.equal(r.code, 1, r.out);
    assert.match(r.rec.line, /npm audit signatures failed: 1 package has an invalid attestation/);
  });

  it('fails when the rebuild differs from the npm bytes in a file other than package.json', () => {
    const other = tarball(
      'npm-rebuilt-code',
      { ...base, gitHead: COMMIT },
      'export const name = "x";\n'
    );
    const r = record('npm-code', registry('npm-code'), { rebuild: other.tgz });
    assert.equal(r.code, 1, r.out);
    assert.match(
      r.rec.line,
      /not reproducible from tag v9\.8\.7: package\/dist\/mcpcat\.mjs: different bytes/
    );
  });

  it('fails when package.json differs in a field other than gitHead', () => {
    const other = tarball(
      'npm-rebuilt-manifest',
      { ...base, gitHead: COMMIT, scripts: { build: 'node b.mjs' } },
      code
    );
    const r = record('npm-manifest', registry('npm-manifest'), { rebuild: other.tgz });
    assert.equal(r.code, 1, r.out);
    assert.match(r.rec.line, /package\/package\.json: differs in more than gitHead/);
  });
  function published(env) {
    const r = tool('published.mjs', ['--version', VERSION, '--repo', REPO, '--wait', '0'], env);
    return { ...r, line: r.out.trim().split('\n').at(-1) };
  }

  it('verify: the registry bytes are the SLSA subject, built by release.yml on main from the tag', () => {
    const r = published(registry('pub-ok'));
    assert.equal(r.code, 0, r.out);
    assert.equal(
      r.line,
      `verified ${NAME}@${VERSION} sha256=${onNpm.sha256} on npm: ${integrity}, provenance .github/workflows/release.yml@refs/heads/main commit ${COMMIT} = gitHead = tag v${VERSION}, on main`
    );
  });

  for (const [what, opts, why] of [
    [
      'bytes other than the SLSA subject',
      { served: rebuilt.tgz },
      /dist\.integrity is .*, the tarball is/,
    ],
    [
      'a provenance from another workflow',
      { path: '.github/workflows/ci.yml' },
      /provenance workflow is \.github\/workflows\/ci\.yml/,
    ],
    [
      'a provenance from another ref',
      { ref: 'refs/heads/evil' },
      /provenance ref is refs\/heads\/evil/,
    ],
    [
      'a gitHead other than the provenance commit',
      { gitHead: 'e'.repeat(40) },
      /isn't the package's gitHead/,
    ],
    [
      'a provenance commit other than the tag',
      { gitCommit: 'e'.repeat(40), gitHead: 'e'.repeat(40) },
      new RegExp(`tag v${VERSION} is ${COMMIT}, provenance says ${'e'.repeat(40)}`),
    ],
    ['unverified attestation signatures', { signed: false }, /npm audit signatures failed/],
  ]) {
    it(`verify: fails loudly on ${what}`, () => {
      const r = published(registry(`pub-${what.replace(/\W+/g, '-')}`, opts));
      assert.equal(r.code, 1, r.out);
      assert.match(r.line, /^cert-ci: FAIL published /);
      assert.match(r.line, why);
    });
  }
});

describe('cert-review record --commit: a pull request or merge group under review', () => {
  const HEAD = 'c'.repeat(40);
  const CHANGE = '0.0.0-pr.42';
  const change = tarball('pr', { name: NAME, version: CHANGE, gitHead: HEAD });
  const otherHead = tarball('pr-other-head', {
    name: NAME,
    version: CHANGE,
    gitHead: 'd'.repeat(40),
  });

  function record(
    name,
    tgz,
    sha256,
    extra = [],
    verdict = { verdict: 'certified', known: [] },
    change = undefined
  ) {
    const dir = join(work, `${name}-review`);
    mkdirSync(dir, { recursive: true });
    if (verdict) writeFileSync(join(dir, 'verdict.json'), JSON.stringify(verdict));
    const out = join(work, `rec-${name}`);
    const r = tool('record.mjs', [
      '--version',
      CHANGE,
      '--review',
      dir,
      '--out',
      out,
      '--tarball',
      tgz,
      '--sha256',
      sha256,
      '--commit',
      HEAD,
      '--change',
      'pull request #42',
      '--evidence',
      evidence(name, CHANGE, sha256, change),
      ...extra,
    ]);
    const rec =
      r.code === 2 ? undefined : JSON.parse(readFileSync(join(out, 'record.json'), 'utf8'));
    return { ...r, rec };
  }

  it('certifies the head it was packed from, with no tag and nothing published', () => {
    const r = record('pr-ok', change.tgz, change.sha256);
    assert.equal(r.code, 0, r.out);
    assert.equal(r.rec.commit, HEAD);
    assert.equal(
      r.rec.line,
      `certified ${NAME}@${CHANGE} sha256=${change.sha256} (ci: local; known: none)`
    );
    assert.match(
      readFileSync(join(work, 'rec-pr-ok', 'body.md'), 'utf8'),
      /nothing is published from here/
    );
  });

  it('certifies a gate-only change on its evidence, and says so', () => {
    const r = record('pr-gate-only', change.tgz, change.sha256, [], undefined, (stage) => {
      stage.delta = { shipped: [], gate: ['scripts/cert-review/record.mjs'] };
    });
    assert.equal(r.code, 0, r.out);
    assert.match(r.rec.line, /^certified /);
    assert.match(
      readFileSync(join(work, 'rec-pr-gate-only', 'body.md'), 'utf8'),
      /- delta: 0 shipped, 1 gate files \(gate-only: /
    );
  });

  it('keeps a gate-only change fail-closed: a failed suite still fails it', () => {
    const r = record('pr-gate-fail', change.tgz, change.sha256, [], undefined, (stage, suites) => {
      stage.delta = { shipped: [], gate: ['.github/workflows/cert-review.yml'] };
      const host = suites.results.find((x) => x.name === 'subject host suite');
      Object.assign(host, { exit: 1, failed: ['gate test'] });
    });
    assert.equal(r.code, 1, r.out);
    assert.match(r.rec.line, /^cert-ci: FAIL .*subject host suite failed/);
  });

  it('calls evidence that does not say what the delta changes INCOMPLETE', () => {
    const r = record('pr-no-delta', change.tgz, change.sha256, [], undefined, (stage) => {
      delete stage.delta;
    });
    assert.equal(r.code, 1, r.out);
    assert.match(r.rec.line, /^cert-ci: INCOMPLETE .*which shipped and gate files the delta/);
  });

  it('calls a reviewed change with no shipped or gate file INCOMPLETE', () => {
    const r = record('pr-empty-delta', change.tgz, change.sha256, [], undefined, (stage) => {
      stage.delta = { shipped: [], gate: [] };
    });
    assert.equal(r.code, 1, r.out);
    assert.match(r.rec.line, /^cert-ci: INCOMPLETE .*changes no shipped or gate file/);
  });

  it("fails when the tarball's gitHead is not the head under review", () => {
    const r = record('pr-head', otherHead.tgz, otherHead.sha256);
    assert.equal(r.code, 1, r.out);
    assert.match(
      r.rec.line,
      new RegExp(`gitHead is ${'d'.repeat(40)}, the pull request #42 is ${HEAD}`)
    );
  });

  it('calls a certified verdict from a review job that did not succeed INCOMPLETE, never FAIL', () => {
    const r = record('pr-held', change.tgz, change.sha256, ['--upstream', 'failure']);
    assert.equal(r.code, 1, r.out);
    assert.match(r.rec.line, /^cert-ci: INCOMPLETE .*held: the review job ended failure/);
    assert.equal(r.rec.state, 'error');
    assert.equal(r.rec.certified, false);
  });

  it('calls a skipped review with no verdict INCOMPLETE', () => {
    const r = record('pr-skipped', change.tgz, change.sha256, ['--upstream', 'skipped'], null);
    assert.equal(r.code, 1, r.out);
    assert.match(r.rec.line, /^cert-ci: INCOMPLETE .*held: the review job ended skipped/);
    assert.match(r.rec.line, /no readable verdict\.json/);
    assert.equal(r.rec.state, 'error');
  });

  it('calls a verdict that is neither certified nor fail INCOMPLETE', () => {
    const r = record('pr-maybe', change.tgz, change.sha256, [], { verdict: 'maybe' });
    assert.equal(r.code, 1, r.out);
    assert.match(r.rec.line, /^cert-ci: INCOMPLETE .*verdict\.json says "maybe"/);
  });

  it('calls a missing artifact INCOMPLETE', () => {
    const r = record('pr-noartifact', join(work, 'absent.tgz'), change.sha256);
    assert.equal(r.code, 1, r.out);
    assert.match(r.rec.line, /^cert-ci: INCOMPLETE .*no release artifact to check/);
    assert.equal(r.rec.state, 'error');
  });

  it('keeps a sha mismatch a FAIL even when the review job did not succeed', () => {
    const r = record('pr-held-swap', otherHead.tgz, change.sha256, ['--upstream', 'failure']);
    assert.equal(r.code, 1, r.out);
    assert.match(r.rec.line, /^cert-ci: FAIL .*the artifact is sha256/);
    assert.equal(r.rec.state, 'failure');
  });

  it("keeps the reviewer's fail a FAIL even when the review job did not succeed", () => {
    const r = record('pr-held-fail', change.tgz, change.sha256, ['--upstream', 'failure'], {
      verdict: 'fail',
      reason: 'a planted leak',
    });
    assert.equal(r.code, 1, r.out);
    assert.match(r.rec.line, /^cert-ci: FAIL .*the reviewer: a planted leak/);
    assert.equal(r.rec.state, 'failure');
  });

  const allClear = { verdict: 'certified', known: [] };
  const coded = (name, change, extra = []) =>
    record(name, change.tgz ?? changeTgz.tgz, changeTgz.sha256, extra, allClear, change.fn);
  const changeTgz = change;

  it('a crafted all-clear verdict never clears a suite that failed in code', () => {
    const r = coded('code-row-fail', {
      fn: (_stage, suites) => {
        const row = suites.results.find((x) => x.name === 'rows kernel 1.2.3');
        Object.assign(row, { ok: true, exit: 1, failed: ['redacts ${VAR} in -v'] });
      },
    });
    assert.equal(r.code, 1, r.out);
    assert.equal(r.rec.state, 'failure');
    assert.match(
      r.rec.line,
      /^cert-ci: FAIL .*in code: rows kernel 1\.2\.3 failed \(exit 1: redacts \$\{VAR\} in -v\)/
    );
  });

  it('a crafted all-clear verdict never clears a changed test that fails on the subject', () => {
    const r = coded('code-neg-head', {
      fn: (stage, suites) => {
        stage.changedTests = ['test/integration/x.test.mjs'];
        suites.negative = [
          { file: 'test/integration/x.test.mjs', head: { ok: false }, base: { ok: false } },
        ];
      },
    });
    assert.equal(r.code, 1, r.out);
    assert.match(
      r.rec.line,
      /^cert-ci: FAIL .*the changed test test\/integration\/x\.test\.mjs fails on the subject/
    );
  });

  it('a crafted all-clear verdict never clears an import in the kernel bundle', () => {
    const r = coded('code-imports', {
      fn: (stage) => {
        stage.surface[CHANGE].kernelBundle.imports = ['node:fs'];
      },
    });
    assert.equal(r.code, 1, r.out);
    assert.match(r.rec.line, /^cert-ci: FAIL .*the kernel bundle imports node:fs/);
  });

  it('a crafted all-clear verdict never clears an unexplained rebuild difference', () => {
    const r = coded('code-rebuild', {
      fn: (stage) => {
        stage.rebuildDiff.unexplained = ['package/dist/kernel/mcpcat.mjs: different bytes'];
      },
    });
    assert.equal(r.code, 1, r.out);
    assert.match(
      r.rec.line,
      /^cert-ci: FAIL .*not reproducible: package\/dist\/kernel\/mcpcat\.mjs/
    );
  });

  for (const [what, fn, why] of [
    [
      'a pinned kernel whose suites never ran',
      (_stage, suites) => {
        suites.results = suites.results.filter((x) => !x.name.endsWith('1.0.0'));
      },
      /rows kernel 1\.0\.0 didn't run/,
    ],
    [
      'a kernel suite that never reached its kernel',
      (_stage, suites) => {
        suites.results.find((x) => x.name === 'subject cert kernel 1.2.3').kernelSeen = false;
      },
      /subject cert kernel 1\.2\.3 didn't run on its kernel/,
    ],
    [
      'a suite that ran no tests',
      (_stage, suites) => {
        suites.results.find((x) => x.name === 'rows host').pass = 0;
      },
      /rows host ran no tests/,
    ],
    [
      "security rows other than rows.json's",
      (_stage, suites) => {
        suites.rows = { secrets: ['auth'] };
        suites.kernelRows = [];
      },
      /the security rows that ran aren't rows\.json's.*the security row test /,
    ],
    [
      'a changed test the NEGATIVE never ran',
      (stage) => {
        stage.changedTests = ['test/integration/y.test.mjs'];
      },
      /the NEGATIVE didn't run test\/integration\/y\.test\.mjs/,
    ],
    [
      "a NEGATIVE that ran on the subject's tooling",
      (stage, suites) => {
        stage.changedTests = ['test/integration/cert-x.test.mjs'];
        stage.negative.fromBase = ['dist'];
        suites.negative = [
          { file: 'test/integration/cert-x.test.mjs', head: { ok: true }, base: { ok: false } },
        ];
      },
      /the NEGATIVE didn't take scripts from the base/,
    ],
    [
      'a NEGATIVE on another base than the delta',
      (stage, suites) => {
        stage.changedTests = ['test/integration/cert-x.test.mjs'];
        stage.negative.base = '3'.repeat(40);
        suites.negative = [
          { file: 'test/integration/cert-x.test.mjs', head: { ok: true }, base: { ok: false } },
        ];
      },
      /the NEGATIVE doesn't name the subject's tests and the base's sha it ran on/,
    ],
    [
      'evidence from other bytes',
      (stage) => {
        stage.artifact.sha256 = 'f'.repeat(64);
      },
      /the suites ran on sha256 f{64}, not the artifact's/,
    ],
  ]) {
    it(`a crafted all-clear verdict is INCOMPLETE with ${what}`, () => {
      const r = coded(`code-${what.replace(/\W+/g, '-')}`, { fn });
      assert.equal(r.code, 1, r.out);
      assert.equal(r.rec.state, 'error');
      assert.match(r.rec.line, /^cert-ci: INCOMPLETE /);
      assert.match(r.rec.line, why);
    });
  }

  it('a crafted all-clear verdict is INCOMPLETE without code-made evidence', () => {
    const r = coded('code-none', {
      fn: (stage) => {
        stage.version = undefined;
      },
    });
    assert.equal(r.code, 1, r.out);
    assert.match(r.rec.line, /^cert-ci: INCOMPLETE .*the evidence is for/);
    const none = tool('record.mjs', [
      '--version',
      CHANGE,
      '--review',
      join(work, 'code-none-review'),
      '--out',
      join(work, 'rec-code-none-2'),
      '--tarball',
      change.tgz,
      '--sha256',
      change.sha256,
      '--commit',
      HEAD,
      '--gap',
      'the suites artifact id 1 is from another run',
    ]);
    assert.equal(none.code, 1, none.out);
    const line = readFileSync(join(work, 'rec-code-none-2', 'line.txt'), 'utf8');
    assert.match(
      line,
      /^cert-ci: INCOMPLETE .*the evidence: the suites artifact id 1 is from another run/
    );
    assert.match(line, /in code: no code-made evidence \(stage\.json and suites\.json\)/);
  });

  it('certifies a changed test that does not bite, and names the gap in the line', () => {
    const r = coded('code-no-negative', {
      fn: (stage, suites) => {
        stage.changedTests = ['test/integration/z.test.mjs'];
        suites.negative = [
          { file: 'test/integration/z.test.mjs', head: { ok: true }, base: { ok: true } },
        ];
      },
    });
    assert.equal(r.code, 0, r.out);
    assert.equal(
      r.rec.line,
      `certified ${NAME}@${CHANGE} sha256=${change.sha256} (ci: local; known: none; gaps: no-negative z.test.mjs)`
    );
  });

  it('refuses a change version without the commit it was packed from', () => {
    const r = tool('record.mjs', ['--version', CHANGE, '--review', work, '--out', join(work, 'x')]);
    assert.equal(r.code, 2, r.out);
  });
});

describe('cert-review shipped: which changes are behaviour', () => {
  const repo = join(work, 'shipped-repo');
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
  const commit = (files) => {
    for (const [f, text] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, f)), { recursive: true });
      writeFileSync(join(repo, f), text);
    }
    git('add', '-A');
    git('commit', '-q', '-m', 'x');
    return git('rev-parse', 'HEAD');
  };
  const root0 = commit({ 'src/a.ts': '1', 'README.md': '1', 'docs/spec.html': '1' });
  const branch = (name, files) => {
    git('checkout', '-q', '-b', name, root0);
    return commit(files);
  };
  const run = (head) => tool('shipped.mjs', ['--repo', repo, '--base', root0, '--head', head]);

  for (const [name, files] of [
    ['docs', { 'README.md': '2', 'docs/spec.html': '2', 'AGENTS.md': '2' }],
    ['tests', { 'test/integration/x.test.mjs': '2' }],
    ['workflow', { '.github/workflows/renovate.yml': '2', 'scripts/lint.sh': '2' }],
  ]) {
    it(`skips a ${name}-only change as not behaviour`, () => {
      const r = run(branch(name, files));
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, /^not behaviour: none of the \d+ changed files is shipped/);
    });
  }

  for (const [name, file] of [
    ['src', 'src/a.ts'],
    ['package.json', 'package.json'],
    ['lockfile', 'package-lock.json'],
    ['build script', 'scripts/build.mjs'],
    ['release workflow', '.github/workflows/release.yml'],
    ['binaries workflow', '.github/workflows/binaries.yml'],
    ['release config', '.releaserc.json'],
    ['installer', 'install.sh'],
    ['agent skill', 'src/skill/SKILL.txt'],
  ]) {
    it(`reviews a change to the ${name}`, () => {
      const r = run(branch(`b-${name.replace(/\W/g, '-')}`, { [file]: '3', 'README.md': '3' }));
      assert.equal(r.code, 0, r.out);
      assert.match(
        r.out,
        new RegExp(`^behaviour: 1 shipped file changed: ${file.replace(/\./g, '\\.')}`)
      );
    });
  }

  const escape = (file) => file.replace(/\./g, '\\.');
  for (const [name, file] of [
    ['cert-review workflow', '.github/workflows/cert-review.yml'],
    ['ci workflow', '.github/workflows/ci.yml'],
    ['post-publish verify', 'scripts/cert-review/published.mjs'],
    ['behaviour classifier', 'scripts/cert-review/shipped.mjs'],
    ['record', 'scripts/cert-review/record.mjs'],
    ['security rows', 'scripts/cert-review/rows.json'],
  ]) {
    it(`reviews a change to the gate's ${name}`, () => {
      const r = run(branch(`g-${name.replace(/\W/g, '-')}`, { [file]: '5', 'README.md': '5' }));
      assert.equal(r.code, 0, r.out);
      assert.match(r.out, new RegExp(`^behaviour: 1 gate file changed: ${escape(file)}$`, 'm'));
      assert.match(r.out, new RegExp(`^gate: ${escape(file)}$`, 'm'));
    });
  }

  it('names the release workflow both shipped and gate', () => {
    const r = run(branch('g-release', { '.github/workflows/release.yml': '6' }));
    assert.equal(r.code, 0, r.out);
    const file = '.github/workflows/release.yml';
    assert.match(
      r.out,
      new RegExp(
        `^behaviour: 1 shipped file changed: ${escape(file)}; 1 gate file changed: ${escape(file)}$`,
        'm'
      )
    );
  });

  it('reviews a package.json change to scripts alone, whatever dist does', () => {
    git('checkout', '-q', '-b', 'pkg-base', root0);
    const manifest = {
      name: '@ai-ecoverse/mcpcat',
      version: '0.0.0',
      scripts: { build: 'node scripts/build.mjs' },
    };
    const base = commit({ 'package.json': `${JSON.stringify(manifest, null, 2)}\n` });
    const head = commit({
      'package.json': `${JSON.stringify({ ...manifest, scripts: { ...manifest.scripts, postinstall: 'node x.mjs' } }, null, 2)}\n`,
    });
    const r = tool('shipped.mjs', ['--repo', repo, '--base', base, '--head', head]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^behaviour: 1 shipped file changed: package\.json/);
  });

  it('reads the change from the merge base, not from a base that moved on', () => {
    const head = branch('moved-head', { 'README.md': '4' });
    git('checkout', '-q', '-b', 'moved-main', root0);
    const moved = commit({ 'src/a.ts': '4' });
    const r = tool('shipped.mjs', ['--repo', repo, '--base', moved, '--head', head]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /^not behaviour/);
  });
});

describe('cert-review bind: every artifact is the one its producer output, by id and digest', () => {
  const D = (c) => c.repeat(64);
  const STARTED = '2026-10-17T20:00:00Z';
  const art = (id, name, digest, run = 5, created_at = '2026-10-17T20:05:00Z') => ({
    id,
    name,
    digest: `sha256:${digest}`,
    expired: false,
    created_at,
    workflow_run: { id: run },
  });
  const TARBALL = art(71, 'mcpcat-tarball-1.2.3', D('a'));
  const VERDICT = art(72, 'cert-review-verdict-1.2.3', D('b'));
  const SUITES = art(73, 'cert-review-suites-1.2.3', D('c'));
  const spec = (a, digest = a.digest) => `${a.name}=${a.id}@${digest}`;
  const ARGS = [
    '--artifact',
    spec(TARBALL),
    '--artifact',
    spec(VERDICT),
    '--artifact',
    spec(SUITES),
    '--optional',
    'cert-review-evidence-1.2.3=@',
    '--prefix',
    'mcpcat-tarball-',
    '--prefix',
    'cert-review-',
  ];
  function bind(name, { listed = [TARBALL, VERDICT, SUITES], byId = listed, args = ARGS } = {}) {
    const bin = join(work, `${name}-bin`);
    mkdirSync(bin, { recursive: true });
    const ids = Object.fromEntries([
      ['repos/ai-ecoverse/mcpcat/actions/runs/5', { id: 5, run_started_at: STARTED }],
      ...byId.map((a) => [`repos/ai-ecoverse/mcpcat/actions/artifacts/${a.id}`, a]),
    ]);
    writeFileSync(
      join(bin, 'gh'),
      [
        '#!/usr/bin/env node',
        'const a = process.argv.slice(2);',
        `const ids = ${JSON.stringify(ids)};`,
        `const listed = ${JSON.stringify(listed)};`,
        "if (a[0] === 'api' && a[1] === '--paginate' && a.at(-1) === 'repos/ai-ecoverse/mcpcat/actions/runs/5/artifacts?per_page=100') process.stdout.write(JSON.stringify([{ artifacts: listed }]));",
        "else if (a[0] === 'api' && ids[a[1]]) process.stdout.write(JSON.stringify(ids[a[1]]));",
        'else process.exit(1);',
        '',
      ].join('\n')
    );
    chmodSync(join(bin, 'gh'), 0o755);
    const r = tool('bind.mjs', ['--run', '5', ...args], {
      PATH: [bin, process.env.PATH].join(delimiter),
    });
    return { ...r, line: r.out.trim().split('\n').at(-1) };
  }

  it('binds every artifact whose name, run and digest are its producer outputs', () => {
    const r = bind('bind-ok', {
      listed: [
        TARBALL,
        VERDICT,
        SUITES,
        art(9, 'coverage', D('d')),
        art(10, 'cert-review-verdict-1.2.3', D('e'), 5, '2026-10-17T19:00:00Z'),
      ],
    });
    assert.equal(r.code, 0, r.out);
    assert.match(
      r.out,
      /bind: cert-review-verdict-1\.2\.3 \(10\) is from an earlier attempt, never read/
    );
    assert.match(
      r.out,
      new RegExp(`bind: cert-review-suites-1\\.2\\.3 is artifact 73 sha256:${D('c')} from run 5`)
    );
    assert.equal(
      r.line,
      "bind: ok, 3 artifacts bound by id and digest, and no other from this attempt in this run's namespaces"
    );
  });

  it('is INCOMPLETE when a planted extra artifact sits in the namespace, even one the old name download would have skipped', () => {
    const planted = art(80, 'cert-review-verdict-1.2.3-planted', D('f'));
    const r = bind('bind-extra', { listed: [TARBALL, VERDICT, SUITES, planted] });
    assert.equal(r.code, 1, r.out);
    assert.match(
      r.line,
      /^bind: INCOMPLETE an unexpected artifact cert-review-verdict-1\.2\.3-planted \(80\) in this run$/
    );
  });

  it('is INCOMPLETE when an artifact the producer output no id for exists anyway', () => {
    const evidence = art(81, 'cert-review-evidence-1.2.3', D('9'));
    const r = bind('bind-noid', { listed: [TARBALL, VERDICT, SUITES, evidence] });
    assert.equal(r.code, 1, r.out);
    assert.match(r.line, /unexpected artifact cert-review-evidence-1\.2\.3 \(81\)/);
  });

  for (const [what, opts, why] of [
    [
      'a digest mismatch',
      { byId: [TARBALL, { ...VERDICT, digest: `sha256:${D('0')}` }, SUITES] },
      /cert-review-verdict-1\.2\.3: artifact 72 has digest sha256:0{64}/,
    ],
    [
      'another run',
      { byId: [TARBALL, VERDICT, { ...SUITES, workflow_run: { id: 6 } }] },
      /artifact 73 is from run 6/,
    ],
    [
      'another name',
      { byId: [{ ...TARBALL, name: 'mcpcat-tarball-9.9.9' }, VERDICT, SUITES] },
      /artifact 71 is named mcpcat-tarball-9\.9\.9/,
    ],
    [
      'an expired artifact',
      { byId: [TARBALL, { ...VERDICT, expired: true }, SUITES] },
      /artifact 72 has expired/,
    ],
    [
      'no id from the producer',
      { args: ['--artifact', 'cert-review-verdict-1.2.3=@'] },
      /cert-review-verdict-1\.2\.3: the producer output no artifact id/,
    ],
    [
      'no digest from the producer',
      { args: ['--artifact', 'cert-review-verdict-1.2.3=72@'] },
      /cert-review-verdict-1\.2\.3: the producer output no sha256 digest/,
    ],
    [
      'an artifact that cannot be read',
      { byId: [TARBALL, SUITES] },
      /artifact 72 couldn't be read/,
    ],
  ]) {
    it(`is INCOMPLETE for ${what}`, () => {
      const r = bind(`bind-${what.replace(/\W+/g, '-')}`, opts);
      assert.equal(r.code, 1, r.out);
      assert.match(r.line, /^bind: INCOMPLETE /);
      assert.match(r.line, why);
    });
  }
});

describe('cert-review verdict: a run without a recorded verdict still leaves a cert-review status', () => {
  const yml = readFileSync(join(root, '.github/workflows/cert-review.yml'), 'utf8').split('\n');
  const at = yml.findIndex((l) => l.includes('- name: A run that ends without a recorded verdict'));
  const from = yml.findIndex((l, i) => i > at && l.trim() === 'run: |') + 1;
  const indent = yml[from].length - yml[from].trimStart().length;
  const to = yml.findIndex(
    (l, i) => i >= from && l.trim() && l.length - l.trimStart().length < indent
  );
  const script = yml
    .slice(from, to === -1 ? undefined : to)
    .map((l) => l.slice(indent))
    .join('\n');
  const HEAD = 'e'.repeat(40);

  function fallback(name, env) {
    const bin = join(work, `${name}-bin`);
    mkdirSync(bin, { recursive: true });
    const log = join(bin, 'gh.log');
    writeFileSync(
      join(bin, 'gh'),
      `#!/bin/sh\nprintf '%s\\n' "$@" >> ${JSON.stringify(log)}\necho "status from the stub"\n`
    );
    chmodSync(join(bin, 'gh'), 0o755);
    const r = spawnSync('bash', ['-e', '-c', script], {
      encoding: 'utf8',
      env: {
        PATH: [bin, process.env.PATH].join(delimiter),
        GH_REPO: 'ai-ecoverse/mcpcat',
        RUN_URL: 'https://github.com/ai-ecoverse/mcpcat/actions/runs/1',
        HEAD_SHA: HEAD,
        RECORD: 'skipped',
        ...env,
      },
    });
    let calls = [];
    try {
      calls = readFileSync(log, 'utf8').trim().split('\n');
    } catch {}
    return { code: r.status, out: `${r.stdout}${r.stderr}`, calls };
  }

  it('posts error with the INCOMPLETE line when the plan crashed', () => {
    const r = fallback('fb-plan', {
      OUTCOME: 'incomplete',
      SAID: 'cert-ci: INCOMPLETE the plan job ended failure (re-run the failed jobs)',
    });
    assert.equal(r.code, 0, r.out);
    assert.ok(r.calls.includes(`repos/ai-ecoverse/mcpcat/statuses/${HEAD}`), r.calls.join(' '));
    assert.ok(r.calls.includes('state=error'), r.calls.join(' '));
    assert.ok(r.calls.includes('context=cert-review'), r.calls.join(' '));
    assert.ok(
      r.calls.includes(
        'description=cert-ci: INCOMPLETE the plan job ended failure (re-run the failed jobs)'
      )
    );
    assert.match(
      r.out,
      /cert-review fallback: posted error on e{40}: cert-ci: INCOMPLETE the plan job ended failure/
    );
  });

  it('posts error when the verdict job itself printed no verdict', () => {
    const r = fallback('fb-silent', {});
    assert.equal(r.code, 0, r.out);
    assert.ok(r.calls.includes('state=error'), r.calls.join(' '));
    assert.ok(
      r.calls.some((c) =>
        c.startsWith('description=cert-ci: INCOMPLETE the verdict job printed no verdict')
      )
    );
  });

  it('posts failure for a FAIL that record never posted', () => {
    const r = fallback('fb-fail', { OUTCOME: 'fail', SAID: 'cert-ci: FAIL x' });
    assert.ok(r.calls.includes('state=failure'), r.calls.join(' '));
  });

  for (const [what, env, why] of [
    ['record posted the status', { OUTCOME: 'fail', POSTED: 'true' }, /record posted the status/],
    ['it is certified', { OUTCOME: 'certified' }, /certified, nothing to add/],
    ['it is not behaviour', { OUTCOME: 'not-behaviour' }, /not-behaviour, nothing to add/],
    [
      'it is a dispatch',
      { OUTCOME: 'incomplete', HEAD_SHA: '' },
      /not a pull request or merge group/,
    ],
  ]) {
    it(`posts nothing when ${what}`, () => {
      const r = fallback(`fb-${what.replace(/\W+/g, '-')}`, env);
      assert.equal(r.code, 0, r.out);
      assert.deepEqual(r.calls, []);
      assert.match(r.out, why);
    });
  }
});

describe("cert-review NEGATIVE: the subject's tests on the base's dist, scripts and workflows", () => {
  const tree = (name, files) => {
    const dir = join(work, name);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), text);
    }
    return dir;
  };
  const test = [
    "import assert from 'node:assert/strict';",
    "import { execFileSync } from 'node:child_process';",
    "import { it } from 'node:test';",
    "it('the tool says new', () => assert.equal(execFileSync(process.execPath, ['scripts/cert-review/tool.mjs'], { encoding: 'utf8' }), 'new'));",
    '',
  ].join('\n');
  const subject = tree('neg-subject', {
    'scripts/cert-review/tool.mjs': "process.stdout.write('new');\n",
    'dist/mcpcat.mjs': 'new\n',
    '.github/workflows/cert-review.yml': 'new\n',
    'test/integration/cert-tool.test.mjs': test,
  });
  const base = tree('neg-base', {
    'scripts/cert-review/tool.mjs': "process.stdout.write('old');\n",
    'dist/mcpcat.mjs': 'old\n',
    '.github/workflows/cert-review.yml': 'old\n',
    'test/integration/cert-tool.test.mjs': 'old test\n',
  });
  const modules = tree('neg-modules', { 'x/package.json': '{}' });
  const run = (cwd) => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    return spawnSync(process.execPath, ['--test', 'test/integration/cert-tool.test.mjs'], {
      cwd,
      encoding: 'utf8',
      env,
    }).status;
  };

  it("takes the base's tooling and dist, keeps the subject's tests, and so a cert-tool test bites", async () => {
    const { negativeTree } = await import(join(tools, 'negative.mjs'));
    const out = join(work, 'neg-out');
    assert.deepEqual(negativeTree({ subject, base, out, nodeModules: modules }), [
      'dist',
      'scripts',
      '.github/workflows',
    ]);
    assert.equal(
      readFileSync(join(out, 'scripts/cert-review/tool.mjs'), 'utf8'),
      "process.stdout.write('old');\n"
    );
    assert.equal(readFileSync(join(out, 'dist/mcpcat.mjs'), 'utf8'), 'old\n');
    assert.equal(readFileSync(join(out, '.github/workflows/cert-review.yml'), 'utf8'), 'old\n');
    assert.equal(readFileSync(join(out, 'test/integration/cert-tool.test.mjs'), 'utf8'), test);
    assert.equal(readFileSync(join(out, 'node_modules/x/package.json'), 'utf8'), '{}');
    assert.equal(run(subject), 0);
    assert.notEqual(run(out), 0);
  });
});
