import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const installer = join(root, 'install.sh');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const floor = Number(/^>=(\d+)$/.exec(pkg.engines.node)?.[1]);

const has = (cmd) => spawnSync('sh', ['-c', `command -v ${cmd}`]).status === 0;
const musl = spawnSync('sh', ['-c', 'ls /lib/ld-musl-* >/dev/null 2>&1']).status === 0;
const os = { darwin: 'darwin', linux: 'linux' }[process.platform];
const arch = { x64: 'x64', arm64: 'arm64' }[process.arch];
const skip =
  !os || !arch || musl || !has('curl') || !has('tar') || !has('xz')
    ? 'needs glibc Linux or macOS on x64/arm64 with curl, tar and xz'
    : false;

const sha = (file) => createHash('sha256').update(readFileSync(file)).digest('hex');
const run = (cmd, args, opts) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  assert.equal(r.status, 0, `${cmd} ${args.join(' ')}\n${r.stdout}\n${r.stderr}`);
  return r;
};

const fakeNode = (file, version) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `#!/bin/sh\necho ${version}\n`);
  chmodSync(file, 0o755);
};

describe('install.sh honours engines.node', () => {
  const base = mkdtempSync(join(tmpdir(), 'mcpcat-install-'));
  after(() => rmSync(base, { recursive: true, force: true }));

  const assets = join(base, 'assets');
  const stage = join(base, 'stage');
  mkdirSync(join(stage, 'package/dist/host'), { recursive: true });
  writeFileSync(join(stage, 'package/dist/host/mcpcat.mjs'), '');
  mkdirSync(assets, { recursive: true });
  if (!skip) {
    run('tar', ['czf', join(assets, 'mcpcat-9.9.9.tgz'), '-C', stage, 'package']);
    writeFileSync(
      join(assets, 'SHA256SUMS'),
      `${sha(join(assets, 'mcpcat-9.9.9.tgz'))}  mcpcat-9.9.9.tgz\n`
    );
  }

  const dist = (name, releases) => {
    const dir = join(base, name);
    mkdirSync(dir, { recursive: true });
    const lines = releases.map(
      ([version, lts]) =>
        `{"version":"${version}","date":"2026-10-01","files":["linux-x64"],"lts":${lts},"security":false}`
    );
    writeFileSync(join(dir, 'index.json'), `[\n${lines.join(',\n')}\n]\n`);
    for (const [version] of releases) {
      const archive = `node-${version}-${os}-${arch}`;
      const src = join(base, `${name}-src`, archive);
      fakeNode(join(src, 'bin/node'), version);
      mkdirSync(join(dir, version), { recursive: true });
      const out = join(dir, version, `${archive}.tar.xz`);
      run('tar', ['cJf', out, '-C', dirname(src), archive]);
      writeFileSync(join(dir, version, 'SHASUMS256.txt'), `${sha(out)}  ${archive}.tar.xz\n`);
    }
    return pathToFileURL(dir).href;
  };

  const install = (name, pathNode, distBase) => {
    const dir = join(base, name);
    const bin = join(dir, 'fakebin');
    if (pathNode) fakeNode(join(bin, 'node'), pathNode);
    const data = join(dir, 'data');
    const launcherDir = join(dir, 'bin');
    const r = spawnSync('sh', [installer], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH}`,
        XDG_DATA_HOME: data,
        INSTALL_DIR: launcherDir,
        SLICC_INSTALL_BASE_URL: pathToFileURL(assets).href,
        SLICC_NODE_DIST_BASE: distBase,
      },
    });
    const launcher = join(launcherDir, 'mcpcat');
    return {
      ...r,
      managed: join(data, 'mcpcat/node/bin/node'),
      launcher: existsSync(launcher) ? readFileSync(launcher, 'utf8') : '',
    };
  };

  it('keeps MIN_NODE equal to the engines.node floor', () => {
    assert.ok(Number.isInteger(floor), pkg.engines.node);
    assert.match(readFileSync(installer, 'utf8'), new RegExp(`^MIN_NODE=${floor}$`, 'm'));
  });

  it('names the floor in --help', () => {
    const r = run('sh', [installer, '--help']);
    assert.match(r.stdout, new RegExp(`Node ${floor}\\+ required`));
  });

  it('rejects a PATH node below the floor and prefers the newest LTS at or above it', {
    skip,
  }, () => {
    const below = `v${floor - 2}.9.0`;
    const lts = `v${floor}.2.0`;
    const base = dist('dist-lts', [
      [`v${floor + 1}.0.0`, 'false'],
      [lts, '"Testing"'],
      [`v${floor}.1.0`, 'false'],
      [below, '"Older"'],
    ]);
    const r = install('lts', below, base);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, new RegExp(`Installed Node ${lts.replaceAll('.', '\\.')} `));
    assert.ok(r.launcher.includes(`exec "${r.managed}"`), r.launcher);
  });

  it('falls back to the newest release at or above the floor when no such LTS exists', {
    skip,
  }, () => {
    const below = `v${floor - 1}.3.0`;
    const newest = `v${floor + 1}.0.0`;
    const base = dist('dist-current', [
      [newest, 'false'],
      [`v${floor}.12.1`, 'false'],
      [`v${floor - 2}.22.1`, '"Older"'],
    ]);
    const r = install('current', below, base);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, new RegExp(`Installed Node ${newest.replaceAll('.', '\\.')} `));
    assert.ok(r.launcher.includes(`exec "${r.managed}"`), r.launcher);
  });

  it('fails when no release reaches the floor', { skip }, () => {
    const base = dist('dist-old', [
      [`v${floor - 1}.0.0`, 'false'],
      [`v${floor - 2}.22.1`, '"Older"'],
    ]);
    const r = install('old', `v${floor - 2}.0.0`, base);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, new RegExp(`could not find a Node ${floor}\\+ release`));
    assert.equal(existsSync(r.managed), false);
  });

  it('uses a PATH node at the floor without downloading', { skip }, () => {
    const r = install('ok', `v${floor}.0.0`, pathToFileURL(join(base, 'missing')).href);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(r.managed), false);
    assert.ok(r.launcher.includes(join(base, 'ok/fakebin/node')), r.launcher);
  });
});
