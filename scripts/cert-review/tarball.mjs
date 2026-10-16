import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

export const NAME = '@ai-ecoverse/mcpcat';
export const SEMVER = /^\d+\.\d+\.\d+$/;
export const CHANGE = /^0\.0\.0-(pr|queue)\.\d+$/;
export const COMMIT = /^[0-9a-f]{40}$/;
const npmFlags = ['--no-audit', '--no-fund'];

export function sh(cmd, args, opts = {}) {
  console.log(`${opts.cwd ? `(${opts.cwd}) ` : ''}${cmd} ${args.join(' ')}`);
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
    ...opts,
  });
}

export const sha = (algo, file, enc = 'hex') =>
  createHash(algo).update(readFileSync(file)).digest(enc);
export const sri = (file) => `sha512-${sha('sha512', file, 'base64')}`;

export function fetchPlanted(root, planted) {
  sh(
    'git',
    ['fetch', '--no-tags', 'origin', `+refs/heads/${planted}:refs/remotes/origin/${planted}`],
    { cwd: root }
  );
  return `origin/${planted}`;
}

export function fetchCommit(root, commit) {
  try {
    sh('git', ['cat-file', '-e', `${commit}^{commit}`], { cwd: root });
  } catch {
    sh('git', ['fetch', '--no-tags', 'origin', commit], { cwd: root });
  }
  return commit;
}

export function worktree(root, dir, ref) {
  rmSync(dir, { recursive: true, force: true });
  sh('git', ['worktree', 'add', '--force', '--detach', dir, ref], { cwd: root });
  return sh('git', ['rev-parse', 'HEAD'], { cwd: dir }).trim();
}

function setVersion(dir, version) {
  sh('npm', ['version', version, '--no-git-tag-version', '--allow-same-version'], { cwd: dir });
}

export function packTree(dir, version, dest) {
  const commit = sh('git', ['rev-parse', 'HEAD'], { cwd: dir }).trim();
  sh('npm', ['ci', ...npmFlags], { cwd: dir });
  setVersion(dir, version);
  sh('npm', ['pkg', 'set', `gitHead=${commit}`], { cwd: dir });
  mkdirSync(dest, { recursive: true });
  const before = new Set(readdirSync(dest));
  sh('npm', ['pack', '--silent', '--pack-destination', dest], {
    cwd: dir,
    env: { ...process.env, MCPCAT_STRIP_SCRIPTS: '1' },
  });
  const made = readdirSync(dest).filter((f) => f.endsWith('.tgz') && !before.has(f));
  if (made.length !== 1) throw new Error(`npm pack in ${dir} made ${made.length} tarballs`);
  sh('git', ['checkout', '--', 'package.json'], { cwd: dir });
  if (existsSync(join(dir, 'package-lock.json')))
    sh('git', ['checkout', '--', 'package-lock.json'], { cwd: dir });
  setVersion(dir, version);
  return { commit, tgz: join(dest, made[0]) };
}

export function manifestOf(tgz) {
  return JSON.parse(
    execFileSync('tar', ['-xzf', tgz, '-O', 'package/package.json'], { encoding: 'utf8' })
  );
}
