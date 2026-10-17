#!/usr/bin/env node
import { appendFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { gh, one, run } from './checks.mjs';
import { checkPublished, lineShape, releaseNotes, WORKFLOW } from './released.mjs';
import { NAME, SEMVER } from './tarball.mjs';

const { values } = parseArgs({
  options: {
    version: { type: 'string' },
    repo: { type: 'string', default: 'ai-ecoverse/mcpcat' },
    run: { type: 'string', default: '' },
    wait: { type: 'string', default: '300' },
    out: { type: 'string', default: '' },
  },
});

const MERGE = /^Merge pull request #(\d+) from /;
const { version, repo } = values;
const ghAll = (path) =>
  JSON.parse(run('gh', ['api', '--paginate', '--slurp', path])).flatMap((p) =>
    Array.isArray(p) ? p : (p.commits ?? [])
  );
const say = (text) => {
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
};

function previousTag() {
  const [a, b, c] = version.split('.').map(Number);
  return ghAll(`repos/${repo}/tags?per_page=100`)
    .map((t) => t.name)
    .filter((t) => /^v\d+\.\d+\.\d+$/.test(t))
    .map((t) => t.slice(1).split('.').map(Number))
    .filter((v) => v[0] < a || (v[0] === a && (v[1] < b || (v[1] === b && v[2] < c))))
    .sort((x, y) => y[0] - x[0] || y[1] - x[1] || y[2] - x[2])[0]
    ?.join('.');
}

function pullRequests(since) {
  const seen = new Set();
  for (const c of ghAll(`repos/${repo}/compare/v${since}...v${version}`)) {
    const n = MERGE.exec(c.commit?.message ?? '')?.[1];
    if (n !== undefined) seen.add(Number(n));
  }
  return [...seen]
    .sort((x, y) => x - y)
    .map((n) => {
      const head = gh(`repos/${repo}/pulls/${n}`).head.sha;
      const status = ghAll(`repos/${repo}/commits/${head}/statuses`).find(
        (s) => s.context === 'cert-review'
      );
      return { pr: n, head, state: status?.state, description: status?.description };
    });
}

function groupVerdict(prs) {
  const ok = [];
  const not = [];
  for (const p of prs) {
    const at = p.head.slice(0, 12);
    if (p.state === 'success')
      ok.push(
        `#${p.pr} ${/^not behaviour/.test(p.description ?? '') ? 'not behaviour' : 'certified'} at ${at}`
      );
    else
      not.push(
        `#${p.pr} has ${p.state ? `cert-review ${p.state}` : 'no cert-review'} on its head ${at}`
      );
  }
  return not.length
    ? { all: false, text: `not all: ${[...not, ...ok].join(', ')}` }
    : { all: true, text: ok.join(', ') || 'no pull requests' };
}

const ci = values.run || 'https://github.com/local';
const finish = (state, line, extra = {}) => {
  say(line);
  if (values.out)
    writeFileSync(values.out, `${JSON.stringify({ version, state, line, ...extra }, null, 2)}\n`);
  process.exit(state === 'success' ? 0 : 1);
};

if (!SEMVER.test(version ?? '')) {
  console.error('certify: --version must be x.y.z');
  process.exit(2);
}
const subject = `${NAME}@${version}`;
const { problems, missing, facts } = await checkPublished({ version, repo, wait: values.wait });
if (problems.length)
  finish(
    'failure',
    `supply-chain alert: ${subject} on npm doesn't verify: ${problems.join('; ')}${missing.length ? `; also missing: ${missing.join('; ')}` : ''} (ci: ${ci})`,
    { problems, missing }
  );
if (missing.length)
  finish(
    'error',
    `cert-ci: INCOMPLETE ${subject}: ${missing.join('; ')}; re-run the failed jobs (ci: ${ci})`,
    { missing }
  );
let group;
let body;
try {
  const since = previousTag();
  group = groupVerdict(since ? pullRequests(since) : []);
  group.since = since ?? null;
  body = gh(`repos/${repo}/releases/tags/v${version}`).body;
} catch (error) {
  finish(
    'error',
    `cert-ci: INCOMPLETE ${subject}: the pull requests or the release notes couldn't be read (${one(error.stderr || error.message).slice(0, 200)}); re-run the failed jobs (ci: ${ci})`
  );
}
const word = group.all ? 'certified' : 'verified';
const line = `${word} ${subject} sha256=${facts.sha256} (ci: ${ci}; npm: ${facts.integrity}, provenance ${WORKFLOW}@refs/heads/main commit ${facts.provenance.gitCommit} = gitHead = tag v${version}; pr-certified since v${group.since ?? 'none'}: ${group.text})`;
const shape = lineShape(line, version);
if (!shape) finish('error', `cert-ci: INCOMPLETE ${subject}: certify made a malformed line`);
const notes = releaseNotes(body, { ...shape, line });
if (notes.conflict)
  finish(
    'failure',
    `supply-chain alert: ${subject}: ${notes.conflict}, but npm serves sha256=${facts.sha256} (ci: ${ci})`
  );
finish('success', line, {
  sha256: facts.sha256,
  word,
  notes: notes.unchanged ? 'unchanged' : 'to write',
});
