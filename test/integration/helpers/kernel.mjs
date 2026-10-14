import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const certKernelDir = process.env.MCPCAT_CERT_KERNEL_DIR;
const kernelImportBase = certKernelDir ? pathToFileURL(`${certKernelDir}/`).href : undefined;

if (certKernelDir) {
  const kpkg = JSON.parse(readFileSync(join(certKernelDir, 'package.json'), 'utf8'));
  console.log(`cert: using kernel ${kpkg.version} from ${certKernelDir}`);
}

const kernelMod = certKernelDir
  ? await import(new URL('dist/index.js', kernelImportBase).href)
  : await import('@ai-ecoverse/slicc-kernel');

const kernelNodeMod = certKernelDir
  ? await import(new URL('dist/node.js', kernelImportBase).href)
  : await import('@ai-ecoverse/slicc-kernel/node');

export const kernelDir = certKernelDir;
export const { attachKernel } = kernelMod;
export const { createNodeKernel, nodeTransport } = kernelNodeMod;
