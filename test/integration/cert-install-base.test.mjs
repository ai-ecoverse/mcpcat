import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { installBase } from '../../scripts/cert-review/tarball.mjs';

const work = mkdtempSync(join(tmpdir(), 'mcpcat-cert-install-base-'));
after(() => rmSync(work, { recursive: true, force: true }));

function base() {
  const dir = mkdtempSync(join(work, 'base-'));
  const pkg = {
    name: 'base',
    version: '1.0.0',
    scripts: {
      prepare: 'echo prepare ran >&2 && exit 1',
      build:
        "node -e \"require('node:fs').mkdirSync('dist');require('node:fs').writeFileSync('dist/built','yes')\"",
    },
  };
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  writeFileSync(
    join(dir, 'package-lock.json'),
    JSON.stringify({
      name: 'base',
      version: '1.0.0',
      lockfileVersion: 3,
      requires: true,
      packages: { '': { name: 'base', version: '1.0.0' } },
    })
  );
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['config', 'core.hooksPath', '.githooks'], { cwd: dir });
  return dir;
}

describe('cert-review installBase', () => {
  it('installs the base without its lifecycle scripts, then builds it', () => {
    const dir = base();
    installBase(dir);
    assert.equal(readFileSync(join(dir, 'dist/built'), 'utf8'), 'yes');
  });

  it('a plain npm ci of the same base runs its failing prepare', () => {
    const dir = base();
    assert.throws(() =>
      execFileSync('npm', ['ci', '--no-audit', '--no-fund'], { cwd: dir, stdio: 'pipe' })
    );
  });
});
