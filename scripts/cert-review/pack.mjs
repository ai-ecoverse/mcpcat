#!/usr/bin/env node
import { appendFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { fetchPlanted, packTree, SEMVER, sha, sri, worktree } from './tarball.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { values } = parseArgs({
  options: {
    version: { type: 'string' },
    out: { type: 'string' },
    planted: { type: 'string', default: '' },
  },
});
const { version, planted } = values;
if (!SEMVER.test(version ?? '') || !values.out) {
  console.error('pack: --version x.y.z and --out <dir> are required');
  process.exit(2);
}
const out = resolve(values.out);
const ref = planted ? fetchPlanted(root, planted) : `v${version}`;
const tree = join(out, 'tree');
worktree(root, tree, ref);
const { commit, tgz } = packTree(tree, version, join(out, 'tmp'));
const file = join(out, basename(tgz));
renameSync(tgz, file);
const sha256 = sha('sha256', file);
writeFileSync(`${file}.sha256`, `${sha256}  ${basename(file)}\n`);
const facts = { ref, commit, file, sha256, integrity: sri(file) };
writeFileSync(join(out, 'pack.json'), `${JSON.stringify(facts, null, 2)}\n`);
if (process.env.GITHUB_OUTPUT) {
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `sha256=${sha256}\nfile=${basename(file)}\ncommit=${commit}\n`
  );
}
console.log(`pack: ${basename(file)} sha256=${sha256} from ${ref} (${commit})`);
