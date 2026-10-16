import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const EXPLAINED = 'gitHead';

function unpack(tgz, dir) {
  mkdirSync(dir, { recursive: true });
  execFileSync('tar', ['-xzf', tgz, '-C', dir], { stdio: ['ignore', 'ignore', 'pipe'] });
  return new Set(
    readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((d) => d.isFile())
      .map((d) => join(d.parentPath, d.name).slice(dir.length + 1))
  );
}

function withoutGitHead(text) {
  try {
    const manifest = JSON.parse(text);
    delete manifest[EXPLAINED];
    return JSON.stringify(manifest);
  } catch {
    return undefined;
  }
}

export function compareTarballs(subject, rebuilt) {
  const base = mkdtempSync(join(tmpdir(), 'cert-compare-'));
  try {
    const a = join(base, 'a');
    const b = join(base, 'b');
    const left = unpack(subject, a);
    const right = unpack(rebuilt, b);
    const explained = [];
    const unexplained = [];
    for (const path of [...new Set([...left, ...right])].sort()) {
      if (!left.has(path) || !right.has(path)) {
        unexplained.push(`${path}: only in the ${left.has(path) ? 'subject' : 'rebuild'}`);
        continue;
      }
      const x = readFileSync(join(a, path));
      const y = readFileSync(join(b, path));
      if (x.equals(y)) continue;
      if (path === 'package/package.json') {
        const p = withoutGitHead(x.toString('utf8'));
        if (p !== undefined && p === withoutGitHead(y.toString('utf8'))) {
          const gx = JSON.parse(x.toString('utf8'))[EXPLAINED] ?? null;
          const gy = JSON.parse(y.toString('utf8'))[EXPLAINED] ?? null;
          explained.push(`${path}: only gitHead differs (subject ${gx}, rebuild ${gy})`);
          continue;
        }
        unexplained.push(`${path}: differs in more than gitHead`);
        continue;
      }
      unexplained.push(`${path}: different bytes`);
    }
    return { identical: !explained.length && !unexplained.length, explained, unexplained };
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}
