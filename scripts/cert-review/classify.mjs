import { execFileSync } from 'node:child_process';

export const SHIPPED = [
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

export const GATE = [
  /^\.github\/workflows\/(ci|cert-review|release)\.ya?ml$/,
  /^scripts\/cert-review\//,
];

export const isShipped = (file) => SHIPPED.some((re) => re.test(file));
export const isGate = (file) => GATE.some((re) => re.test(file));

export function delta(repo, base, head) {
  const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const from = git(['merge-base', base, head]);
  const changed = git(['diff', '--name-only', '--no-renames', from, head])
    .split('\n')
    .filter(Boolean);
  const shipped = changed.filter(isShipped);
  const gate = changed.filter(isGate);
  return {
    base: from,
    head: git(['rev-parse', `${head}^{commit}`]),
    behaviour: shipped.length + gate.length > 0,
    shipped,
    gate,
    files: [...new Set([...shipped, ...gate])],
    changed,
  };
}
