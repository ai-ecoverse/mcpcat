#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
if (process.env.GITHUB_ACTIONS !== 'true' && process.env.MCPCAT_STRIP_SCRIPTS !== '1') {
  console.log('strip-own-scripts: not in CI, keeping prepare/prepack');
  process.exit(0);
}
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
if (pkg.scripts) {
  delete pkg.scripts.prepare;
  delete pkg.scripts.prepack;
}
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
console.log('strip-own-scripts: removed prepare/prepack from package.json for packing');
