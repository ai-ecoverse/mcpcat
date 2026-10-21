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
  /^\.github\/workflows\/(ci|cert-review|cert-verify|release)\.ya?ml$/,
  /^scripts\/cert-review\//,
  /^scripts\/(cert|kernel-test-files|cert-count-reporter)\.mjs$/,
  /^test\/integration\/cert(-[^/]+)?\.test\.mjs$/,
  /^test\/integration\/[^/]+\.cert\.mjs$/,
  /^test\/integration\/helpers\//,
];

export const isShipped = (file) => SHIPPED.some((re) => re.test(file));
export const isGate = (file, rowTests = new Set()) =>
  GATE.some((re) => re.test(file)) || rowTests.has(file);

function rowTestsAt(git, rev) {
  try {
    const rows = JSON.parse(git(['show', `${rev}:scripts/cert-review/rows.json`]));
    return Object.values(rows)
      .flat()
      .map((name) => `test/integration/${name}.test.mjs`);
  } catch {
    return [];
  }
}

export function delta(repo, base, head) {
  const git = (args) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' }).trim();
  const from = git(['merge-base', base, head]);
  const changed = git(['diff', '--name-only', '--no-renames', from, head])
    .split('\n')
    .filter(Boolean);
  const shipped = changed.filter(isShipped);
  const rowTests = new Set([...rowTestsAt(git, from), ...rowTestsAt(git, head)]);
  const gate = changed.filter((f) => isGate(f, rowTests));
  return {
    base: from,
    head: git(['rev-parse', `${head}^{commit}`]),
    behaviour: shipped.length + gate.length > 0,
    shipped,
    gate,
    files: [...new Set([...shipped, ...gate])],
    changed,
    rowTests,
  };
}
