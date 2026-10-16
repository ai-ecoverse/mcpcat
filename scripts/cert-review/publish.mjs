#!/usr/bin/env node
import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { manifestOf, NAME, sri } from './tarball.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: {
    tarball: { type: 'string' },
    record: { type: 'string' },
    sha256: { type: 'string', default: '' },
    'dry-run': { type: 'boolean', default: false },
  },
});
const dryRun = values['dry-run'];
const summary = (text) =>
  process.env.GITHUB_STEP_SUMMARY &&
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\`\`\`\n${text}\n\`\`\`\n`);

const gate = spawnSync(
  process.execPath,
  [
    join(here, 'gate.mjs'),
    '--tarball',
    values.tarball ?? '',
    '--record',
    values.record ?? '',
    '--sha256',
    values.sha256,
  ],
  { stdio: 'inherit' }
);
if (gate.status !== 0) process.exit(gate.status ?? 2);

const { version } = manifestOf(values.tarball);
const env = { ...process.env };
for (const k of ['NODE_AUTH_TOKEN', 'NPM_TOKEN', 'NPM_CONFIG_TOKEN']) delete env[k];
let onNpm = '';
try {
  onNpm = execFileSync('npm', ['view', `${NAME}@${version}`, 'dist.integrity'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env,
  }).trim();
} catch {}
const ours = sri(values.tarball);
const args = ['publish', values.tarball, '--provenance', '--access', 'public', '--tag', 'latest'];
if (dryRun) {
  const note = onNpm
    ? `${NAME}@${version} is already on npm (${onNpm === ours ? 'these bytes' : onNpm}); dry-run with --force`
    : `${NAME}@${version} is not on npm`;
  console.log(note);
  summary(`dry-run: would publish ${NAME}@${version} ${ours}\n${note}`);
  execFileSync('npm', [...args, '--dry-run', '--force'], { stdio: 'inherit', env });
  process.exit(0);
}
if (onNpm) {
  if (onNpm === ours) {
    summary(`${NAME}@${version} is already on npm with these bytes: nothing to publish`);
    console.log(`${NAME}@${version} is already on npm with these bytes`);
    process.exit(0);
  }
  console.log(`::error::${NAME}@${version} is on npm as ${onNpm}, not the certified ${ours}`);
  process.exit(2);
}
execFileSync('npm', args, { stdio: 'inherit', env });
summary(`published ${NAME}@${version} ${ours} with provenance`);
