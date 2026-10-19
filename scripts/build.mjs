#!/usr/bin/env node
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, 'host'), { recursive: true });
mkdirSync(join(dist, 'kernel'), { recursive: true });

const define = {
  MCPCAT_VERSION: JSON.stringify(pkg.version),
  MCPCAT_SKILL: JSON.stringify(readFileSync(join(root, 'src/skill/SKILL.txt'), 'utf8')),
};

const hostBanner = `#!/usr/bin/env node
import { createRequire as __mcpcat_createRequire } from 'node:module';
const require = __mcpcat_createRequire(import.meta.url);`;

await esbuild.build({
  entryPoints: [join(root, 'src/host.ts')],
  outfile: join(dist, 'host/mcpcat.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node24'],
  banner: { js: hostBanner },
  define,
  logLevel: 'info',
});

chmodSync(join(dist, 'host/mcpcat.mjs'), 0o755);
mkdirSync(join(dist, 'skills/mcpcat'), { recursive: true });
copyFileSync(join(root, 'src/skill/SKILL.txt'), join(dist, 'skills/mcpcat/SKILL.md'));

await esbuild.build({
  entryPoints: [join(root, 'src/codemode/worker.ts')],
  outfile: join(dist, 'host/codemode-worker.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node24'],
  define,
  logLevel: 'info',
});

const require = createRequire(import.meta.url);
const wasmSource = require.resolve('quickjs-wasi/quickjs.wasm');
copyFileSync(wasmSource, join(dist, 'quickjs.wasm'));

await esbuild.build({
  entryPoints: [join(root, 'src/kernel.ts')],
  outfile: join(dist, 'kernel/mcpcat.mjs'),
  bundle: true,
  format: 'esm',
  platform: 'neutral',
  target: ['es2024'],
  define: {
    ...define,
    'Buffer.byteLength': '__mcpcat_byteLength',
  },
  banner: {
    js: 'var __mcpcat_byteLength = (s) => new TextEncoder().encode(s).length;',
  },
  logLevel: 'info',
  external: [],
  alias: {
    'node:fs': join(root, 'src/stubs/node-stub.ts'),
    'node:fs/promises': join(root, 'src/stubs/node-stub.ts'),
    'node:child_process': join(root, 'src/stubs/node-stub.ts'),
    'node:stream': join(root, 'src/stubs/node-stub.ts'),
    'node:tty': join(root, 'src/stubs/node-stub.ts'),
    'node:path': join(root, 'src/stubs/node-stub.ts'),
    'node:url': join(root, 'src/stubs/node-stub.ts'),
    'node:net': join(root, 'src/stubs/node-stub.ts'),
    'node:os': join(root, 'src/stubs/node-stub.ts'),
    'node:events': join(root, 'src/stubs/node-stub.ts'),
    'node:util': join(root, 'src/stubs/node-stub.ts'),
    'node:process': join(root, 'src/stubs/node-stub.ts'),
    'node:worker_threads': join(root, 'src/stubs/node-stub.ts'),
    'node:module': join(root, 'src/stubs/node-stub.ts'),
    'node:http': join(root, 'src/stubs/node-stub.ts'),
    'node:crypto': join(root, 'src/stubs/node-stub.ts'),
    'cross-spawn': join(root, 'src/stubs/node-stub.ts'),
  },
});

console.log(
  'built dist/host/mcpcat.mjs, dist/host/codemode-worker.mjs, dist/kernel/mcpcat.mjs, and dist/quickjs.wasm'
);

await import('./notices.mjs');
