#!/usr/bin/env node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { checkManifest, one, run, tagOnMain } from './checks.mjs';
import { compareTarballs } from './compare.mjs';
import { manifestOf, NAME, SEMVER, sha, sri } from './tarball.mjs';

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
    source: { type: 'string', default: 'tag' },
    rebuilt: { type: 'string', default: '' },
  },
});

const WORKFLOW = '.github/workflows/release.yml';
const SLSA = 'https://slsa.dev/provenance/v1';
const { version, repo, planted, source } = values;
const fromNpm = source === 'npm';
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

async function provenance(m, commit) {
  const url = m.dist?.attestations?.url;
  if (!url) return fail('no attestations on npm');
  const res = await fetch(url);
  if (!res.ok) return fail(`attestations answered ${res.status}`);
  const prov = ((await res.json()).attestations ?? []).find((b) => b.predicateType === SLSA);
  if (!prov) return fail('no SLSA provenance attestation');
  const statement = JSON.parse(
    Buffer.from(prov.bundle.dsseEnvelope.payload, 'base64').toString('utf8')
  );
  const subject = statement.subject?.find(
    (s) => s.name === `pkg:npm/%40ai-ecoverse/mcpcat@${version}`
  );
  if (subject?.digest?.sha512 !== facts.sha512)
    fail("the provenance subject isn't the artifact's sha512");
  const build = statement.predicate?.buildDefinition ?? {};
  const wf = build.externalParameters?.workflow ?? {};
  const gitCommit = build.resolvedDependencies?.[0]?.digest?.gitCommit ?? null;
  facts.provenance = { workflow: wf, gitCommit };
  if (wf.repository !== `https://github.com/${repo}`)
    fail(`provenance repository is ${wf.repository}`);
  if (wf.path !== WORKFLOW) fail(`provenance workflow is ${wf.path}`);
  if (wf.ref !== 'refs/heads/main') fail(`provenance ref is ${wf.ref}`);
  if (gitCommit !== commit)
    fail(`the provenance gitCommit is ${gitCommit}, tag v${version} is ${commit}`);
  return true;
}

function signatures() {
  const audit = mkdtempSync(join(tmpdir(), 'cert-record-audit-'));
  try {
    writeFileSync(join(audit, 'package.json'), '{"private":true}\n');
    run('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', `${NAME}@${version}`], {
      cwd: audit,
    });
    let out;
    try {
      out = run('npm', ['audit', 'signatures'], { cwd: audit });
    } catch (error) {
      out = `${error.stdout ?? ''}${error.stderr ?? ''}`;
      fail(`npm audit signatures failed: ${one(out).slice(0, 300)}`);
    }
    facts.signatures = one(out);
    if (!/verified attestation/.test(out)) fail('npm audit signatures verified no attestation');
  } finally {
    rmSync(audit, { recursive: true, force: true });
  }
}

function rebuild(commit) {
  const tgz = resolve(values.rebuilt);
  if (!values.rebuilt || !existsSync(tgz)) return fail('no rebuild from the tag to compare with');
  const head = manifestOf(tgz).gitHead ?? null;
  if (head !== commit) fail(`the rebuild's gitHead is ${head}, tag v${version} is ${commit}`);
  const diff = compareTarballs(resolve(values.tarball), tgz);
  facts.rebuild = { sha256: sha('sha256', tgz), ...diff };
  for (const d of diff.unexplained) fail(`not reproducible from tag v${version}: ${d}`);
  return true;
}

async function registry(commit) {
  const m = JSON.parse(run('npm', ['view', `${NAME}@${version}`, '--json']));
  facts.registryGitHead = m.gitHead ?? null;
  facts.registryIntegrity = m.dist?.integrity ?? null;
  if (m.dist?.integrity !== facts.integrity)
    fail(`npm's dist.integrity is ${m.dist?.integrity}, the artifact is ${facts.integrity}`);
  if (facts.registryGitHead !== commit)
    fail(`the registry's gitHead is ${facts.registryGitHead}, tag v${version} is ${commit}`);
  if (facts.gitHead !== null && facts.gitHead !== commit)
    fail(`the tarball's gitHead is ${facts.gitHead}, tag v${version} is ${commit}`);
  facts.npm = m.dist?.integrity === facts.integrity ? 'these bytes' : 'other bytes';
  await provenance(m, commit);
  signatures();
  rebuild(commit);
}

async function artifact() {
  const tgz = resolve(values.tarball ?? '');
  if (!values.tarball || !existsSync(tgz)) return fail('no release artifact to check');
  facts.sha256 = sha('sha256', tgz);
  facts.integrity = sri(tgz);
  facts.sha512 = sha('sha512', tgz);
  const expected = values.sha256.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) fail(`the pack job's sha256 is "${one(expected)}"`);
  else if (expected !== facts.sha256)
    fail(`the artifact is sha256 ${facts.sha256}, the pack job made ${expected}`);
  checkManifest(tgz, version, fail, facts);
  if (planted) return undefined;
  const commit = tagOnMain(repo, version, fail, facts);
  facts.commit = commit;
  if (fromNpm) {
    await registry(commit);
    return true;
  }
  if (facts.gitHead !== commit)
    fail(`the tarball's gitHead is ${facts.gitHead}, tag v${version} is ${commit}`);
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
if (!['tag', 'npm'].includes(source)) {
  console.error('record: --source is tag or npm');
  process.exit(2);
}
if (fromNpm && planted) problems.push('--source npm never reviews a planted build');
if (planted) problems.push(`a planted build of ${planted}, not a release: never certified`);
if (values.upstream && values.upstream !== 'success')
  problems.push(`held: the review job ended ${values.upstream}`);
try {
  await artifact();
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
    : `- gitHead ${facts.gitHead === null ? 'none' : (facts.gitHead ?? '?')}, tag v${version} ${facts.tagCommit ?? '?'}, main...tag ${facts.onMain ?? '?'}`,
  fromNpm
    ? [
        `- the bytes already on npm: dist.integrity ${facts.registryIntegrity ?? '?'}, registry gitHead ${facts.registryGitHead ?? '?'}, provenance ${facts.provenance?.workflow?.path ?? '?'}@${facts.provenance?.workflow?.ref ?? '?'} commit ${facts.provenance?.gitCommit ?? '?'}`,
        `- rebuild from tag v${version}: ${facts.rebuild ? (facts.rebuild.identical ? 'identical' : [...facts.rebuild.explained, ...facts.rebuild.unexplained].join('; ')) : '?'}; never published from this run`,
      ].join('\n')
    : `- npm before publish: ${facts.npm ?? 'not checked'}; only these bytes are published, with provenance, and verified on npm after`,
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
  `${JSON.stringify({ name: NAME, version, source, planted: planted || null, certified, sha256: certified ? facts.sha256 : null, line, commit: facts.commit ?? null, facts, problems, review }, null, 2)}\n`
);
console.log(line);
for (const p of problems) console.error(`problem: ${p}`);
process.exit(certified ? 0 : 1);
