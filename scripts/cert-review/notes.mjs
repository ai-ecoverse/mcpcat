#!/usr/bin/env node
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { gh, one, run } from './checks.mjs';
import { lineShape, releaseNotes } from './released.mjs';
import { NAME, SEMVER } from './tarball.mjs';

const { values } = parseArgs({
  options: {
    version: { type: 'string' },
    repo: { type: 'string', default: 'ai-ecoverse/mcpcat' },
    line: { type: 'string', default: '' },
    sha256: { type: 'string', default: '' },
  },
});
const { version, repo, line } = values;
const say = (text, code) => {
  console.log(text);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
  process.exit(code);
};

if (!SEMVER.test(version ?? '')) {
  console.error('notes: --version must be x.y.z');
  process.exit(2);
}
const shape = lineShape(line, version);
if (!shape || shape.sha256 !== values.sha256)
  say(`cert-ci: INCOMPLETE ${NAME}@${version}: verify handed over no well-formed line`, 1);
let body;
try {
  body = gh(`repos/${repo}/releases/tags/v${version}`).body;
} catch (error) {
  say(
    `cert-ci: INCOMPLETE ${NAME}@${version}: the release notes couldn't be read (${one(error.stderr || error.message).slice(0, 200)})`,
    1
  );
}
const notes = releaseNotes(body, { ...shape, line });
if (notes.conflict)
  say(`supply-chain alert: ${NAME}@${version}: ${notes.conflict}; the notes stay as they are`, 1);
if (notes.unchanged) say(`notes: v${version} already carries: ${line}`, 0);
const file = join(
  mkdtempSync(join(process.env.RUNNER_TEMP ?? tmpdir(), 'cert-notes-')),
  'notes.md'
);
writeFileSync(file, notes.body);
run('gh', ['release', 'edit', `v${version}`, '--repo', repo, '--notes-file', file]);
say(`notes: wrote into v${version}'s release notes: ${line}`, 0);
