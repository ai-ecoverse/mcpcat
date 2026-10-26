import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const overrideDir = process.env.MCPCAT_KERNEL_DIR;
const kernelImportBase = overrideDir ? pathToFileURL(`${overrideDir}/`).href : undefined;

if (overrideDir) {
  const kpkg = JSON.parse(readFileSync(join(overrideDir, 'package.json'), 'utf8'));
  console.log(`kernel: using ${kpkg.version} from ${overrideDir}`);
}

const kernelMod = overrideDir
  ? await import(new URL('dist/index.js', kernelImportBase).href)
  : await import('@ai-ecoverse/slicc-kernel');

const kernelNodeMod = overrideDir
  ? await import(new URL('dist/node.js', kernelImportBase).href)
  : await import('@ai-ecoverse/slicc-kernel/node');

export const { attachKernel } = kernelMod;
export const { createNodeKernel, fetchTransport, nodeTransport } = kernelNodeMod;

const kernelPkgVersion = JSON.parse(
  readFileSync(
    overrideDir
      ? join(overrideDir, 'package.json')
      : new URL('../../../node_modules/@ai-ecoverse/slicc-kernel/package.json', import.meta.url),
    'utf8'
  )
).version;

export const kernelVersion = kernelPkgVersion.split('.').map(Number);

export function kernelAtLeast(minor) {
  return kernelVersion[0] > 1 || (kernelVersion[0] === 1 && kernelVersion[1] >= minor);
}

export const fetchReachesKernelLoopback = kernelAtLeast(91);
export const hasPgid = kernelAtLeast(74);
export const hasDeathSignal = kernelAtLeast(88);
export const hasSealed = kernelAtLeast(85);
export const syncSignals = kernelAtLeast(69);

export function hostUrl(port) {
  return fetchReachesKernelLoopback
    ? `http://host.slicc.internal:${port}`
    : `http://127.0.0.1:${port}`;
}
