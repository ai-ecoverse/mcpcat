#!/usr/bin/env node
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import * as esbuild from 'esbuild';
import { compareTarballs } from './compare.mjs';
import { fetchPlanted, NAME, packTree, SEMVER, sh, sha, sri, worktree } from './tarball.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const { values } = parseArgs({
  options: {
    version: { type: 'string' },
    prev: { type: 'string' },
    work: { type: 'string' },
    tarball: { type: 'string' },
    planted: { type: 'string', default: '' },
  },
});
const { version, prev } = values;
const work = resolve(values.work);
if (!SEMVER.test(version ?? '') || !SEMVER.test(prev ?? '') || !values.tarball) {
  console.error('stage: --version and --prev must be x.y.z, and --tarball is required');
  process.exit(2);
}
const KERNEL = '@ai-ecoverse/slicc-kernel';
const npmFlags = ['--no-audit', '--no-fund'];

function untar(tgz, dir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  sh('tar', ['-xzf', tgz, '-C', dir]);
  return join(dir, 'package');
}

function listTar(tgz) {
  return sh('tar', ['-tvzf', tgz])
    .trim()
    .split('\n')
    .map((l) => {
      const parts = l.trim().split(/\s+/);
      return { mode: parts[0], size: Number(parts[2]), path: parts.at(-1) };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

function swapDist(tree, pkgDir) {
  rmSync(join(tree, 'dist'), { recursive: true, force: true });
  cpSync(join(pkgDir, 'dist'), join(tree, 'dist'), { recursive: true });
}

function shadow(from, to, nodeModules, dist) {
  rmSync(to, { recursive: true, force: true });
  cpSync(from, to, {
    recursive: true,
    filter: (src) => !/[/\\](node_modules|dist|\.git)$/.test(src),
  });
  symlinkSync(nodeModules, join(to, 'node_modules'), 'dir');
  cpSync(dist, join(to, 'dist'), { recursive: true });
}

async function surface(pkgDir) {
  const bundle = join(pkgDir, 'dist/kernel/mcpcat.mjs');
  const code = readFileSync(bundle, 'utf8');
  const built = await esbuild.build({
    entryPoints: [bundle],
    bundle: true,
    write: false,
    metafile: true,
    platform: 'neutral',
    logLevel: 'silent',
    external: ['*'],
  });
  const imports = Object.values(built.metafile.inputs).flatMap((i) =>
    i.imports.map((x) => `${x.kind} ${x.path}`)
  );
  const bare = (
    await esbuild.transform(code, { minifyWhitespace: true, legalComments: 'none', format: 'esm' })
  ).code;
  const hits = (re) =>
    [...bare.matchAll(re)].map((m) => bare.slice(Math.max(0, m.index - 60), m.index + 60));
  const ctx = [
    ...new Set(
      [...code.matchAll(/\bctx\.([A-Za-z_$][\w$]*)(?:\.([A-Za-z_$][\w$]*))?/g)].map((m) => m[0])
    ),
  ].sort();
  const manifest = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  return {
    kernelBundle: { sha256: sha('sha256', bundle), bytes: code.length, imports },
    eval: hits(/\beval\s*\(/g),
    newFunction: hits(/\bnew\s+Function\b|(?<![\w$.])Function\s*\(/g),
    ctx,
    license: existsSync(join(pkgDir, 'LICENSE')),
    notices: existsSync(join(pkgDir, 'dist/THIRD_PARTY_NOTICES')),
    manifest: {
      dependencies: manifest.dependencies ?? {},
      optionalDependencies: manifest.optionalDependencies ?? {},
      peerDependencies: manifest.peerDependencies ?? {},
      scripts: manifest.scripts ?? {},
      engines: manifest.engines,
      slicc: manifest.slicc,
      bin: manifest.bin,
      files: manifest.files,
    },
  };
}

function kernelPins() {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const pins = [];
  for (const [alias, spec] of Object.entries(pkg.devDependencies ?? {})) {
    if (!alias.startsWith('kernel-cert-')) continue;
    const m = spec.match(/^npm:@ai-ecoverse\/slicc-kernel@(\d+\.\d+\.\d+)$/);
    if (!m) throw new Error(`${alias}: ${spec} is not npm:${KERNEL}@x.y.z`);
    pins.push({
      name: alias,
      version: m[1],
      integrity: lock.packages?.[`node_modules/${alias}`]?.integrity,
    });
  }
  const bios = join(root, 'node_modules/@ai-ecoverse/slicc-bios/src/packages');
  const biosVersion = JSON.parse(readFileSync(join(bios, 'package.json'), 'utf8')).dependencies[
    KERNEL
  ];
  const biosLock = JSON.parse(readFileSync(join(bios, 'package-lock.json'), 'utf8'));
  pins.push({
    name: `slicc-bios@${JSON.parse(readFileSync(join(root, 'node_modules/@ai-ecoverse/slicc-bios/package.json'), 'utf8')).version}`,
    version: biosVersion,
    integrity: biosLock.packages?.[`node_modules/${KERNEL}`]?.integrity,
  });
  const seen = new Map();
  for (const p of pins) {
    if (!SEMVER.test(p.version)) throw new Error(`${p.name}: kernel ${p.version} is not pinned`);
    const known = seen.get(p.version);
    if (known) known.names.push(p.name);
    else seen.set(p.version, { version: p.version, integrity: p.integrity, names: [p.name] });
  }
  return [...seen.values()];
}

function stageKernel(pin) {
  const dir = join(work, 'kernels');
  mkdirSync(dir, { recursive: true });
  const file = sh('npm', [
    'pack',
    `${KERNEL}@${pin.version}`,
    '--silent',
    '--pack-destination',
    dir,
  ])
    .trim()
    .split('\n')
    .at(-1);
  const tgz = join(dir, file);
  const integrity = sri(tgz);
  if (!pin.integrity || pin.integrity !== integrity) {
    throw new Error(
      `kernel ${pin.version}: the registry tarball is ${integrity}, the lockfile pins ${pin.integrity ?? 'nothing'}`
    );
  }
  const home = join(dir, `k-${pin.version}`);
  rmSync(home, { recursive: true, force: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'package.json'), '{"private":true}\n');
  sh('npm', ['install', '--ignore-scripts', ...npmFlags, tgz], { cwd: home });
  return { ...pin, tgz, dir: join(home, 'node_modules', KERNEL) };
}

mkdirSync(work, { recursive: true });
const planted = values.planted;
const subjectRef = planted ? fetchPlanted(root, planted) : `v${version}`;

const kernels = kernelPins().map(stageKernel);

mkdirSync(join(work, 'pub'), { recursive: true });
const pub = join(work, 'pub', basename(values.tarball));
cpSync(resolve(values.tarball), pub);
const pubDir = untar(pub, join(work, 'pub/x'));

const tagTree = join(work, 'tag');
worktree(root, tagTree, subjectRef);
const tag = packTree(tagTree, version, join(work, 'rebuilt-tmp'));
const rebuilt = join(work, `rebuilt-${version}.tgz`);
cpSync(tag.tgz, rebuilt);
rmSync(join(work, 'rebuilt-tmp'), { recursive: true, force: true });
const rebuiltDir = untar(rebuilt, join(work, 'rebuilt/x'));
const pubFiles = listTar(pub);
const rebuiltFiles = listTar(rebuilt);
const fileDiff = [...new Set([...pubFiles, ...rebuiltFiles].map((f) => f.path))].filter((path) => {
  const a = join(pubDir, '..', path);
  const b = join(rebuiltDir, '..', path);
  return !existsSync(a) || !existsSync(b) || sha('sha256', a) !== sha('sha256', b);
});
swapDist(join(work, 'tag'), pubDir);

const prevTree = join(work, 'prev');
const prevCommit = worktree(root, prevTree, `v${prev}`);
sh('npm', ['ci', ...npmFlags], { cwd: prevTree });
if (!existsSync(join(prevTree, 'dist/kernel/mcpcat.mjs')))
  sh('npm', ['run', 'build'], { cwd: prevTree });
shadow(
  join(work, 'tag'),
  join(work, 'neg'),
  join(work, 'tag/node_modules'),
  join(prevTree, 'dist')
);
shadow(root, join(work, 'rows'), join(root, 'node_modules'), join(pubDir, 'dist'));

const prevPack = join(work, 'prev-pub');
mkdirSync(prevPack, { recursive: true });
const prevFile = sh('npm', ['pack', `${NAME}@${prev}`, '--silent', '--pack-destination', prevPack])
  .trim()
  .split('\n')
  .at(-1);
const prevPub = untar(join(prevPack, prevFile), join(prevPack, 'x'));

const now = await surface(pubDir);
const before = await surface(prevPub);
const stage = {
  name: NAME,
  version,
  prev,
  planted: planted || null,
  subject: { ref: subjectRef, commit: tag.commit },
  prevCommit,
  tools: sh('git', ['rev-parse', 'HEAD'], { cwd: root }).trim(),
  node: process.version,
  npm: sh('npm', ['--version']).trim(),
  artifact: {
    tarball: pub,
    sha256: sha('sha256', pub),
    integrity: sri(pub),
    files: pubFiles,
  },
  rebuilt: {
    tarball: rebuilt,
    sha256: sha('sha256', rebuilt),
    integrity: sri(rebuilt),
    files: rebuiltFiles,
  },
  reproducible: sha('sha256', pub) === sha('sha256', rebuilt),
  differingFiles: fileDiff,
  rebuildDiff: compareTarballs(pub, rebuilt),
  kernels: kernels.map(({ version: v, names, tgz, dir, integrity }) => ({
    version: v,
    names,
    tgz,
    dir,
    integrity,
  })),
  surface: {
    [version]: now,
    [prev]: before,
    ctxAdded: now.ctx.filter((c) => !before.ctx.includes(c)),
    ctxRemoved: before.ctx.filter((c) => !now.ctx.includes(c)),
  },
  trees: {
    tag: join(work, 'tag'),
    neg: join(work, 'neg'),
    prev: prevTree,
    rows: join(work, 'rows'),
    artifact: pubDir,
    previousPublished: prevPub,
  },
};
writeFileSync(join(work, 'stage.json'), `${JSON.stringify(stage, null, 2)}\n`);
console.log(
  `stage: ${NAME}@${version} artifact ${stage.artifact.sha256}, rebuilt ${stage.rebuilt.sha256} (${stage.reproducible ? 'same' : `differs: ${fileDiff.join(', ')}`})`
);
