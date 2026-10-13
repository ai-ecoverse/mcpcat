#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const seaDir = join(dist, 'sea');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

const version = process.env.MCPCAT_SEA_VERSION || pkg.version;

mkdirSync(seaDir, { recursive: true });

const define = {
  MCPCAT_VERSION: JSON.stringify(version),
};

await esbuild.build({
  entryPoints: [join(root, 'src/sea-host.ts')],
  outfile: join(seaDir, 'mcpcat.js'),
  bundle: true,
  format: 'cjs',
  platform: 'node',
  target: ['node24'],
  define,
  logLevel: 'warning',
});

await esbuild.build({
  entryPoints: [join(root, 'src/codemode/worker.ts')],
  outfile: join(seaDir, 'codemode-worker.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node24'],
  define,
  logLevel: 'warning',
});

const require = createRequire(import.meta.url);
const wasmSource = require.resolve('quickjs-wasi/quickjs.wasm');
copyFileSync(wasmSource, join(seaDir, 'quickjs.wasm'));

const seaConfig = {
  main: join(seaDir, 'mcpcat.js'),
  output: join(seaDir, 'sea-prep.blob'),
  disableExperimentalSEAWarning: true,
  assets: {
    'codemode-worker.mjs': join(seaDir, 'codemode-worker.mjs'),
    'quickjs.wasm': join(seaDir, 'quickjs.wasm'),
  },
};

const configPath = join(seaDir, 'sea-config.json');
writeFileSync(configPath, JSON.stringify(seaConfig, null, 2));

execFileSync(process.execPath, ['--experimental-sea-config', configPath], {
  stdio: 'inherit',
  cwd: root,
});

console.log(`SEA blob: ${join(seaDir, 'sea-prep.blob')}`);
console.log(`Version: ${version}`);
