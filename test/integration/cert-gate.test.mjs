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

function recordFile(name, record) {
  const file = join(work, `${name}.record.json`);
  writeFileSync(file, JSON.stringify(record));
  return file;
}

const good = tarball('good', { name: NAME, version: VERSION });
const other = tarball('other', { name: NAME, version: VERSION, description: 'other bytes' });
const certifiedRecord = (sha256) => ({
  name: NAME,
  version: VERSION,
  planted: null,
  certified: true,
  sha256,
  line: `certified ${NAME}@${VERSION} sha256=${sha256} (ci: local; known: none)`,
});

describe('cert-review gate: publish only certified bytes', () => {
  it('allows the tarball whose sha256 the verdict certified', () => {
    const r = tool('gate.mjs', [
      '--tarball',
      good.tgz,
      '--record',
      recordFile('ok', certifiedRecord(good.sha256)),
      '--sha256',
      good.sha256,
    ]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, new RegExp(`publish ${NAME}@${VERSION} sha256=${good.sha256}`));
  });

  it('refuses a FAIL verdict and prints its line', () => {
    const line = `cert-ci: FAIL ${NAME}@${VERSION}: the reviewer: leaks a header (ci: local)`;
    const r = tool('gate.mjs', [
      '--tarball',
      good.tgz,
      '--record',
      recordFile('fail', { name: NAME, version: VERSION, certified: false, sha256: null, line }),
      '--sha256',
      good.sha256,
    ]);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /refuse to publish .*the verdict is not certified/);
    assert.ok(r.out.includes(line), r.out);
  });

  it('refuses bytes other than the certified ones', () => {
    const r = tool('gate.mjs', [
      '--tarball',
      other.tgz,
      '--record',
      recordFile('swap', certifiedRecord(good.sha256)),
      '--sha256',
      other.sha256,
    ]);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /refuse to publish .*verdict's sha256/);
  });

  it("refuses when the pack job's sha256 is not the tarball's", () => {
    const r = tool('gate.mjs', [
      '--tarball',
      good.tgz,
      '--record',
      recordFile('pack', certifiedRecord(good.sha256)),
      '--sha256',
      other.sha256,
    ]);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /refuse to publish .*pack job's sha256/);
  });

  it('refuses a certified line for another version', () => {
    const rec = certifiedRecord(good.sha256);
    rec.line = rec.line.replace(VERSION, '9.8.6');
    const r = tool('gate.mjs', [
      '--tarball',
      good.tgz,
      '--record',
      recordFile('ver', rec),
      '--sha256',
      good.sha256,
    ]);
    assert.equal(r.code, 2, r.out);
  });

  it('refuses a planted build even when certified', () => {
    const r = tool('gate.mjs', [
      '--tarball',
      good.tgz,
      '--record',
      recordFile('planted', { ...certifiedRecord(good.sha256), planted: 'proof/planted' }),
      '--sha256',
      good.sha256,
    ]);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /planted/);
  });
});

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
    { gitHead = COMMIT, gitCommit = COMMIT, dist = integrity, signed = true } = {}
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
              path: '.github/workflows/release.yml',
              ref: 'refs/heads/main',
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

  it('refuses to publish a record that replays npm bytes', () => {
    const r = tool('gate.mjs', [
      '--tarball',
      onNpm.tgz,
      '--record',
      recordFile('npm-gate', { ...certifiedRecord(onNpm.sha256), source: 'npm' }),
      '--sha256',
      onNpm.sha256,
    ]);
    assert.equal(r.code, 2, r.out);
    assert.match(r.out, /refuse to publish .*already on npm/);
  });
});
