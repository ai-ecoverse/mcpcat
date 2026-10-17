import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkManifest, one, run, tagOnMain } from './checks.mjs';
import { NAME, sha } from './tarball.mjs';

export const WORKFLOW = '.github/workflows/release.yml';
const SLSA = 'https://slsa.dev/provenance/v1';

async function meta(version, wait) {
  const until = Date.now() + Number(wait) * 1000;
  for (;;) {
    try {
      return JSON.parse(run('npm', ['view', `${NAME}@${version}`, '--json']));
    } catch (error) {
      if (Date.now() > until) throw error;
      await new Promise((r) => setTimeout(r, 10_000));
    }
  }
}

function download(dir, version, fail) {
  const dest = join(dir, 'pack');
  mkdirSync(dest);
  run('npm', ['pack', `${NAME}@${version}`, '--silent', '--pack-destination', dest]);
  const made = readdirSync(dest).filter((f) => f.endsWith('.tgz'));
  if (made.length !== 1) return fail(`npm pack ${NAME}@${version} made ${made.length} tarballs`);
  return join(dest, made[0]);
}

function hashes(m, tgz, facts, fail) {
  facts.sha256 = sha('sha256', tgz);
  facts.sha512 = sha('sha512', tgz);
  facts.integrity = `sha512-${sha('sha512', tgz, 'base64')}`;
  if (m.dist.integrity !== facts.integrity)
    fail(`dist.integrity is ${m.dist.integrity}, the tarball is ${facts.integrity}`);
  return true;
}

async function provenance(m, version, repo, facts, fail, gap) {
  const url = m.dist.attestations?.url;
  if (!url) return fail('no attestations on npm');
  const res = await fetch(url);
  if (!res.ok) return gap(`attestations answered ${res.status}`);
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

function signatures(dir, version, facts, fail) {
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

export async function checkPublished({ version, repo, wait }) {
  const problems = [];
  const missing = [];
  const facts = {};
  const fail = (what) => {
    problems.push(what);
    return undefined;
  };
  const gap = (what) => {
    missing.push(what);
    return undefined;
  };
  const dir = mkdtempSync(join(tmpdir(), 'cert-published-'));
  try {
    const m = await meta(version, wait);
    const tgz = download(dir, version, fail);
    if (tgz && hashes(m, tgz, facts, fail)) {
      checkManifest(tgz, version, fail, facts);
      if (m.hasInstallScript) fail('npm says hasInstallScript');
      const commit = await provenance(m, version, repo, facts, fail, gap);
      signatures(dir, version, facts, fail);
      const tag = tagOnMain(repo, version, fail, facts);
      if (commit !== undefined && commit !== tag)
        fail(`tag v${version} is ${tag}, provenance says ${commit}`);
    }
  } catch (error) {
    missing.push(`check failed: ${one(error.stderr || error.message).slice(0, 300)}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  return { problems, missing, facts };
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function releaseNotes(body, { prefix, sha256, line }) {
  const text = body ?? '';
  const found = [
    ...text.matchAll(
      new RegExp(`(?:certified|verified) ${escape(prefix)} sha256=([0-9a-f]{64})`, 'g')
    ),
  ].map((m) => m[1]);
  const other = found.find((s) => s !== sha256);
  if (other) return { conflict: `the release notes already name ${prefix} sha256=${other}` };
  const word = line.split(' ')[0];
  const block = [...text.matchAll(/<!-- cert-verify -->\n([\s\S]*?)<!-- \/cert-verify -->/g)]
    .map((m) => m[1])
    .join('');
  if (block.split('\n').some((l) => l.startsWith(`${word} ${prefix} sha256=${sha256} `)))
    return { unchanged: true, body: text };
  const rest = text
    .replace(/\n*<!-- cert-verify -->[\s\S]*?<!-- \/cert-verify -->\n*/g, '\n\n')
    .trim();
  return {
    body: `${rest}${rest ? '\n\n' : ''}<!-- cert-verify -->\n${line}\n<!-- /cert-verify -->\n`,
  };
}

export function lineShape(line, version) {
  const m = new RegExp(
    `^(certified|verified) (${escape(`${NAME}@${version}`)}) sha256=([0-9a-f]{64}) \\(ci: https://\\S+; `
  ).exec(line ?? '');
  return m ? { word: m[1], prefix: m[2], sha256: m[3] } : undefined;
}
