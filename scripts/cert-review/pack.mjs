#!/usr/bin/env node
import { appendFileSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { compareTarballs } from './compare.mjs';
import {
  CHANGE,
  COMMIT,
  fetchCommit,
  fetchPlanted,
  NAME,
  packTree,
  SEMVER,
  sh,
  sha,
  sri,
  worktree,
} from './tarball.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { values } = parseArgs({
  options: {
    version: { type: 'string' },
    out: { type: 'string' },
    planted: { type: 'string', default: '' },
    source: { type: 'string', default: 'tag' },
    commit: { type: 'string', default: '' },
  },
});
const { version, planted, source, commit: change } = values;
const versionOk = change
  ? COMMIT.test(change) && CHANGE.test(version ?? '') && source === 'tag' && !planted
  : SEMVER.test(version ?? '');
if (!versionOk || !values.out || !['tag', 'npm'].includes(source)) {
  console.error(
    'pack: --version x.y.z (or 0.0.0-pr.<n>/0.0.0-queue.<n> with --commit <sha>), --out <dir> and --source tag|npm are required'
  );
  process.exit(2);
}
if (source === 'npm' && planted) {
  console.error('pack: --source npm packs the registry bytes, never a planted branch');
  process.exit(2);
}
const out = resolve(values.out);
const ref = change
  ? fetchCommit(root, change)
  : planted
    ? fetchPlanted(root, planted)
    : `v${version}`;
const tree = join(out, 'tree');
worktree(root, tree, ref);
const { commit, tgz } = packTree(tree, version, join(out, 'tmp'));
let file;
let rebuild;
if (source === 'npm') {
  const reg = join(out, 'registry');
  rmSync(reg, { recursive: true, force: true });
  mkdirSync(reg, { recursive: true });
  sh('npm', ['pack', `${NAME}@${version}`, '--silent', '--pack-destination', reg]);
  const made = readdirSync(reg).filter((f) => f.endsWith('.tgz'));
  if (made.length !== 1)
    throw new Error(`npm pack ${NAME}@${version} made ${made.length} tarballs`);
  file = join(out, made[0]);
  renameSync(join(reg, made[0]), file);
  mkdirSync(join(out, 'rebuilt'), { recursive: true });
  rebuild = join(out, 'rebuilt', basename(tgz));
  renameSync(tgz, rebuild);
} else {
  file = join(out, basename(tgz));
  renameSync(tgz, file);
}
const sha256 = sha('sha256', file);
writeFileSync(`${file}.sha256`, `${sha256}  ${basename(file)}\n`);
const facts = { source, ref, commit, file, sha256, integrity: sri(file) };
if (rebuild)
  facts.rebuilt = {
    file: rebuild,
    sha256: sha('sha256', rebuild),
    ...compareTarballs(file, rebuild),
  };
writeFileSync(join(out, 'pack.json'), `${JSON.stringify(facts, null, 2)}\n`);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `sha256=${sha256}\nfile=${basename(file)}\ncommit=${commit}\n`
  );
}
console.log(
  `pack: ${basename(file)} sha256=${sha256} from ${source === 'npm' ? `npm, rebuilt from ${ref}` : ref} (${commit})`
);
