#!/usr/bin/env node
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

async function collectBundledPackages(entryPoint) {
  const result = await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: ['node24'],
    write: false,
    metafile: true,
    logLevel: 'silent',
  });
  const inputs = Object.keys(result.metafile.inputs).filter((k) => k.includes('node_modules'));
  const pkgs = new Set();
  for (const i of inputs) {
    const m = i.match(/node_modules\/(@[^/]+\/[^/]+|[^/]+)/);
    if (m) pkgs.add(m[1]);
  }
  return pkgs;
}

function readPackageLicense(pkgName) {
  const pkgDir = join(root, 'node_modules', pkgName);
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf8'));
  } catch {
    return null;
  }

  let licenseText = null;
  for (const name of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'license', 'license.md']) {
    try {
      licenseText = readFileSync(join(pkgDir, name), 'utf8').trim();
      break;
    } catch {}
  }

  if (!licenseText) {
    try {
      const licensesDir = join(pkgDir, 'LICENSES');
      const files = readdirSync(licensesDir);
      const parts = [];
      for (const f of files.sort()) {
        parts.push(`--- ${f} ---\n${readFileSync(join(licensesDir, f), 'utf8').trim()}`);
      }
      if (parts.length > 0) licenseText = parts.join('\n\n');
    } catch {}
  }

  return {
    name: pkg.name ?? pkgName,
    version: pkg.version ?? 'unknown',
    license: pkg.license ?? 'unknown',
    licenseText,
    homepage: pkg.homepage ?? pkg.repository?.url ?? '',
  };
}

const entryPoints = [join(root, 'src/host.ts')];

const allPkgs = new Set();
for (const ep of entryPoints) {
  const pkgs = await collectBundledPackages(ep);
  for (const p of pkgs) allPkgs.add(p);
}

const sorted = [...allPkgs].sort();
const sections = [];

sections.push(`@ai-ecoverse/mcpcat
Copyright 2026 AI Ecoverse contributors
Licensed under the Apache License, Version 2.0.

This product bundles the following third-party software:
${'='.repeat(60)}
`);

for (const pkgName of sorted) {
  const info = readPackageLicense(pkgName);
  if (!info) continue;
  sections.push(`${info.name}@${info.version}
License: ${info.license}
${info.homepage ? `Homepage: ${info.homepage}` : ''}
${'-'.repeat(40)}
${info.licenseText ?? '(license text not found)'}
`);
}

const output = sections.join('\n');
const outPath = join(root, 'dist/THIRD_PARTY_NOTICES');
writeFileSync(outPath, output);
console.log(`wrote ${outPath} (${sorted.length} packages)`);
