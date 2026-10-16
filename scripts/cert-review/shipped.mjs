#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

const SHIPPED = [
  /^src\//,
  /^package\.json$/,
  /^package-lock\.json$/,
  /^npm-shrinkwrap\.json$/,
  /^\.npmrc$/,
  /^\.npmignore$/,
  /^\.releaserc(\.[a-z]+)?$/,
  /^tsconfig[^/]*\.json$/,
  /^LICENSE$/,
  /^install\.sh$/,
  /^scripts\/(build|strip-own-scripts|notices)\.mjs$/,
  /^scripts\/licenses\//,
  /^\.github\/workflows\/(release|binaries)\.ya?ml$/,
];

const isShipped = (file) => SHIPPED.some((re) => re.test(file));

function shipped(repo, base, head) {
  const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const from = git(['merge-base', base, head]);
  const changed = git(['diff', '--name-only', '--no-renames', from, head])
    .split('\n')
    .filter(Boolean);
  const files = changed.filter(isShipped);
  return {
    base: from,
    head: git(['rev-parse', `${head}^{commit}`]),
    behaviour: files.length > 0,
    files,
    changed,
  };
}

const { values } = parseArgs({
  options: {
    base: { type: 'string' },
    head: { type: 'string' },
    repo: { type: 'string', default: '.' },
  },
});
if (!values.base || !values.head) {
  console.error('shipped: --base <ref> and --head <ref> are required');
  process.exit(2);
}
const r = shipped(resolve(values.repo), values.base, values.head);
const line = r.behaviour
  ? `behaviour: ${r.files.length} shipped file${r.files.length === 1 ? '' : 's'} changed: ${r.files.join(', ')}`
  : `not behaviour: none of the ${r.changed.length} changed files is shipped`;
if (process.env.GITHUB_OUTPUT)
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `behaviour=${r.behaviour}\nmerge_base=${r.base}\nfiles=${r.files.join(' ')}\n`
  );
console.log(line);
for (const f of r.changed) console.log(`${isShipped(f) ? 'shipped' : 'not shipped'}: ${f}`);
