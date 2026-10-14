import './isolate.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../../..');

export const mcpcatBin = process.env.MCPCAT_BIN || join(root, 'dist/host/mcpcat.mjs');
export const isStandalone = !!process.env.MCPCAT_BIN;

export function mcpcatArgs(args) {
  if (isStandalone) return { cmd: mcpcatBin, args };
  return { cmd: 'node', args: [mcpcatBin, ...args] };
}
