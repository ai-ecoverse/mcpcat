#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { checkManifest, one, run, tagOnMain } from './checks.mjs';
import { NAME, SEMVER, sha, sri } from './tarball.mjs';

const { values } = parseArgs({
  options: {
    version: { type: 'string' },
    review: { type: 'string' },
    out: { type: 'string' },
    tarball: { type: 'string' },
    sha256: { type: 'string', default: '' },
    upstream: { type: 'string', default: '' },
    run: { type: 'string', default: '' },
    planted: { type: 'string', default: '' },
    repo: { type: 'string', default: 'ai-ecoverse/mcpcat' },
  },
});

const { version, repo, planted } = values;
const problems = [];
const facts = {};
const fail = (what) => {
  problems.push(what);
  return undefined;
};

function onRegistry() {
  try {
    const integrity = run('npm', ['view', `${NAME}@${version}`, 'dist.integrity']).trim();
    if (!integrity) return 'absent';
    return integrity === facts.integrity ? 'these bytes' : `other bytes (${integrity})`;
  } catch {
    return 'absent';
  }
}

function artifact() {
  const tgz = resolve(values.tarball ?? '');
  if (!values.tarball || !existsSync(tgz)) return fail('no release artifact to check');
  facts.sha256 = sha('sha256', tgz);
  facts.integrity = sri(tgz);
  const expected = values.sha256.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) fail(`the pack job's sha256 is "${one(expected)}"`);
  else if (expected !== facts.sha256)
    fail(`the artifact is sha256 ${facts.sha256}, the pack job made ${expected}`);
  checkManifest(tgz, version, fail, facts);
  if (planted) return undefined;
  const commit = tagOnMain(repo, version, fail, facts);
  if (facts.gitHead !== commit)
    fail(`the tarball's gitHead is ${facts.gitHead}, tag v${version} is ${commit}`);
  facts.commit = commit;
  facts.npm = onRegistry();
  return true;
}

function readVerdict() {
  try {
    const v = JSON.parse(readFileSync(join(values.review, 'verdict.json'), 'utf8'));
    if (v?.verdict !== 'certified' && v?.verdict !== 'fail') {
      problems.push(`verdict.json says "${one(v?.verdict)}", neither certified nor fail`);
      return undefined;
    }
    const known = v.known === undefined ? [] : v.known;
    if (!Array.isArray(known)) {
      problems.push('verdict.json "known" is not a list');
      return { verdict: v.verdict, known: [], reason: one(v.reason) };
    }
    return {
      verdict: v.verdict,
      known: known.map((k) => one(k).slice(0, 120)).filter(Boolean),
      reason: one(v.reason).slice(0, 300),
    };
  } catch (error) {
    problems.push(`no readable verdict.json (${one(error.message)})`);
    return undefined;
  }
}

if (!SEMVER.test(version ?? '') || !values.review || !values.out) {
  console.error('record: --version x.y.z, --review and --out are required');
  process.exit(2);
}
if (planted) problems.push(`a planted build of ${planted}, not a release: never certified`);
if (values.upstream && values.upstream !== 'success')
  problems.push(`held: the review job ended ${values.upstream}`);
try {
  artifact();
} catch (error) {
  problems.push(`artifact check failed: ${one(error.stderr || error.message).slice(0, 300)}`);
}
const review = readVerdict();
const subject = `${NAME}@${version}${planted ? ` (planted ${planted})` : ''}`;
const ci = values.run ? `ci: ${values.run}` : 'ci: local';
let line;
if (!problems.length && review?.verdict === 'certified') {
  line = `certified ${NAME}@${version} sha256=${facts.sha256} (${ci}; known: ${review.known.length ? review.known.join(', ') : 'none'})`;
} else {
  const why = [
    ...(review?.verdict === 'fail' ? [`the reviewer: ${review.reason || 'no reason given'}`] : []),
    ...(review?.verdict === 'certified' ? ['the reviewer certified it'] : []),
    ...problems,
  ];
  line = `cert-ci: FAIL ${subject}: ${why.join('; ')} (${ci})`;
}

const certified = line.startsWith('certified ');
const comment = existsSync(join(values.review, 'comment.md'))
  ? readFileSync(join(values.review, 'comment.md'), 'utf8').trim()
  : '**Cert review:** the reviewer wrote no comment.';
const checks = [
  `- artifact: sha256 ${facts.sha256 ?? '?'} (the pack job's: ${values.sha256 || '?'}), ${facts.integrity ?? '?'}, re-hashed here`,
  planted
    ? '- tag and main: not checked, this is a planted build'
    : `- gitHead ${facts.gitHead ?? '?'}, tag v${version} ${facts.tagCommit ?? '?'}, main...tag ${facts.onMain ?? '?'}`,
  `- npm before publish: ${facts.npm ?? 'not checked'}; only these bytes are published, with provenance, and verified on npm after`,
].join('\n');
const trouble = problems.length
  ? `\n\n**Problems:**\n${problems.map((p) => `- ${p}`).join('\n')}`
  : '';
const body = `<!-- cert-review -->\n${comment}\n\n**Checked by record, in code:**\n${checks}\n\n\`\`\`\n${line}\n\`\`\`${trouble}\n<!-- /cert-review -->\n`;

mkdirSync(values.out, { recursive: true });
writeFileSync(join(values.out, 'line.txt'), `${line}\n`);
writeFileSync(join(values.out, 'body.md'), body);
writeFileSync(
  join(values.out, 'record.json'),
  `${JSON.stringify({ name: NAME, version, planted: planted || null, certified, sha256: certified ? facts.sha256 : null, line, commit: facts.commit ?? null, facts, problems, review }, null, 2)}\n`
);
console.log(line);
for (const p of problems) console.error(`problem: ${p}`);
process.exit(certified ? 0 : 1);
