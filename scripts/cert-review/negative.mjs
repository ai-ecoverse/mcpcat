import { cpSync, existsSync, readdirSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

export const FROM_SUBJECT = 'test';
const SKIP = new Set([FROM_SUBJECT, 'node_modules', '.git']);

export function negativeTree({ subject, base, out, nodeModules }) {
  rmSync(out, { recursive: true, force: true });
  const fromBase = readdirSync(base)
    .filter((part) => !SKIP.has(part))
    .sort();
  for (const part of fromBase)
    cpSync(join(base, part), join(out, part), {
      recursive: true,
      filter: (src) => !/[/\\](node_modules|\.git)$/.test(src),
    });
  if (existsSync(join(subject, FROM_SUBJECT)))
    cpSync(join(subject, FROM_SUBJECT), join(out, FROM_SUBJECT), { recursive: true });
  symlinkSync(nodeModules, join(out, 'node_modules'), 'dir');
  return fromBase;
}
