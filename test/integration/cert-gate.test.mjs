import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const tools = join(root, 'scripts/cert-review');
const work = mkdtempSync(join(tmpdir(), 'mcpcat-cert-gate-'));
after(() => rmSync(work, { recursive: true, force: true }));

const NAME = '@ai-ecoverse/mcpcat';
const VERSION = '9.8.7';

function tarball(name, manifest) {
  const dir = join(work, `${name}-src`);
  mkdirSync(join(dir, 'package/dist'), { recursive: true });
  writeFileSync(join(dir, 'package/package.json'), JSON.stringify(manifest));
  writeFileSync(
    join(dir, 'package/dist/mcpcat.mjs'),
    `export const name = ${JSON.stringify(name)};\n`
  );
  const tgz = join(work, `${name}.tgz`);
  const r = spawnSync('tar', ['-czf', tgz, '-C', dir, 'package']);
  assert.equal(r.status, 0);
  return { tgz, sha256: createHash('sha256').update(readFileSync(tgz)).digest('hex') };
}

function tool(script, args) {
  const env = { ...process.env, NODE_NO_WARNINGS: '1' };
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
