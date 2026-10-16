#!/usr/bin/env node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { checkManifest, one, run, tagOnMain } from './checks.mjs';
import { NAME, SEMVER, sha } from './tarball.mjs';

const { values } = parseArgs({
  options: {
    version: { type: 'string' },
    repo: { type: 'string', default: 'ai-ecoverse/mcpcat' },
    wait: { type: 'string', default: '300' },
  },
});

const WORKFLOW = '.github/workflows/release.yml';
const SLSA = 'https://slsa.dev/provenance/v1';
const { version, repo } = values;
const problems = [];
const facts = {};
const fail = (what) => {
  problems.push(what);
  return undefined;
};

async function meta() {
  const until = Date.now() + Number(values.wait) * 1000;
  for (;;) {
    try {
      return JSON.parse(run('npm', ['view', `${NAME}@${version}`, '--json']));
    } catch (error) {
      if (Date.now() > until) throw error;
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
}

async function download(m, tgz) {
  const url = new URL(m.dist.tarball);
  if (url.origin !== 'https://registry.npmjs.org') return fail(`the tarball is at ${url.origin}`);
  const res = await fetch(url);
  if (!res.ok) return fail(`downloading ${url} answered ${res.status}`);
  writeFileSync(tgz, Buffer.from(await res.arrayBuffer()));
  facts.sha256 = sha('sha256', tgz);
  facts.sha512 = sha('sha512', tgz);
  facts.integrity = `sha512-${sha('sha512', tgz, 'base64')}`;
  if (m.dist.integrity !== facts.integrity)
    fail(`dist.integrity is ${m.dist.integrity}, the tarball is ${facts.integrity}`);
  return true;
}

async function provenance(m) {
  const url = m.dist.attestations?.url;
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
    fail("the provenance subject isn't this tarball's sha512");
  const build = statement.predicate?.buildDefinition ?? {};
  const wf = build.externalParameters?.workflow ?? {};
  const commit = build.resolvedDependencies?.[0]?.digest?.gitCommit;
  facts.provenance = { workflow: wf, gitCommit: commit };
  if (wf.repository !== `https://github.com/${repo}`)
    fail(`provenance repository is ${wf.repository}`);
  if (wf.path !== WORKFLOW) fail(`provenance workflow is ${wf.path}`);
  if (wf.ref !== 'refs/heads/main') fail(`provenance ref is ${wf.ref}`);
  if (commit !== m.gitHead)
    fail(`provenance gitCommit ${commit} isn't the package's gitHead ${m.gitHead}`);
  return commit;
}

function signatures(dir) {
  const audit = join(dir, 'audit');
  mkdirSync(audit);
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
}

if (!SEMVER.test(version ?? '')) {
  console.error('published: --version must be x.y.z');
  process.exit(2);
}
const dir = mkdtempSync(join(tmpdir(), 'cert-published-'));
try {
  const m = await meta();
  const tgz = join(dir, 'package.tgz');
  if (await download(m, tgz)) {
    checkManifest(tgz, version, fail, facts);
    if (m.hasInstallScript) fail('npm says hasInstallScript');
    const commit = await provenance(m);
    signatures(dir);
    const tag = tagOnMain(repo, version, fail, facts);
    if (commit !== tag) fail(`tag v${version} is ${tag}, provenance says ${commit}`);
  }
} catch (error) {
  problems.push(`check failed: ${one(error.stderr || error.message).slice(0, 300)}`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
const line = problems.length
  ? `cert-ci: FAIL published ${NAME}@${version}: ${problems.join('; ')}`
  : `verified ${NAME}@${version} sha256=${facts.sha256} on npm: ${facts.integrity}, provenance ${WORKFLOW}@refs/heads/main commit ${facts.provenance.gitCommit} = gitHead = tag v${version}, on main`;
console.log(line);
process.exit(problems.length ? 1 : 0);
