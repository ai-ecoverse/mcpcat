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

const MIT_TEXT = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

const piLicenseText = readFileSync(join(root, 'scripts/licenses/pi-LICENSE'), 'utf8').trim();

const FALLBACK_LICENSES = {
  '@earendil-works/pi-codemode': {
    license: 'MIT',
    text: piLicenseText,
    note: 'Source: earendil-works/pi repository root LICENSE (covers packages/codemode)',
  },
  '@earendil-works/pi-mcp': {
    license: 'MIT',
    text: piLicenseText,
    note: 'Source: earendil-works/pi repository root LICENSE (covers packages/mcp)',
  },
};

const EXTRA_NOTICES = [
  {
    name: 'QuickJS',
    version: '2024-01-13+',
    license: 'MIT',
    homepage: 'https://bellard.org/quickjs/',
    licenseText: `MIT License

Copyright (c) 2017-2024 Fabrice Bellard
Copyright (c) 2017-2024 Charlie Gordon

${MIT_TEXT}

QuickJS is compiled into quickjs.wasm via quickjs-wasi.`,
  },
];

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

  let bundledLicenses = null;
  try {
    const licensesDir = join(pkgDir, 'LICENSES');
    const files = readdirSync(licensesDir);
    const parts = [];
    for (const f of files.sort()) {
      parts.push(`--- ${f} ---\n${readFileSync(join(licensesDir, f), 'utf8').trim()}`);
    }
    if (parts.length > 0) bundledLicenses = parts.join('\n\n');
  } catch {}

  if (!licenseText && FALLBACK_LICENSES[pkgName]) {
    const fb = FALLBACK_LICENSES[pkgName];
    licenseText = fb.text;
    if (fb.note) licenseText += `\n\n(${fb.note})`;
  }

  if (bundledLicenses) {
    if (licenseText) {
      licenseText = `${licenseText}\n\nBundled third-party licenses:\n${bundledLicenses}`;
    } else {
      licenseText = bundledLicenses;
    }
  }

  return {
    name: pkg.name ?? pkgName,
    version: pkg.version ?? 'unknown',
    license: pkg.license ?? FALLBACK_LICENSES[pkgName]?.license ?? 'unknown',
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
const missing = [];

sections.push(`@ai-ecoverse/mcpcat
Copyright 2026 AI Ecoverse contributors
Licensed under the Apache License, Version 2.0.

This product bundles the following third-party software:
${'='.repeat(60)}
`);

for (const pkgName of sorted) {
  const info = readPackageLicense(pkgName);
  if (!info) continue;
  if (!info.licenseText) {
    missing.push(pkgName);
  }
  sections.push(`${info.name}@${info.version}
License: ${info.license}
${info.homepage ? `Homepage: ${info.homepage}` : ''}
${'-'.repeat(40)}
${info.licenseText ?? '(license text not found)'}
`);
}

for (const extra of EXTRA_NOTICES) {
  sections.push(`${extra.name}@${extra.version}
License: ${extra.license}
${extra.homepage ? `Homepage: ${extra.homepage}` : ''}
${'-'.repeat(40)}
${extra.licenseText}
`);
}

if (missing.length > 0) {
  console.error(`THIRD_PARTY_NOTICES: missing license text for: ${missing.join(', ')}`);
  process.exit(1);
}

const output = sections.join('\n');
const outPath = join(root, 'dist/THIRD_PARTY_NOTICES');
writeFileSync(outPath, output);
console.log(`wrote ${outPath} (${sorted.length + EXTRA_NOTICES.length} packages)`);
