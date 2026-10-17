import { cpSync, existsSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';

export const FROM_BASE = ['dist', 'scripts', '.github/workflows'];

export function negativeTree({ subject, base, out, nodeModules }) {
  rmSync(out, { recursive: true, force: true });
  cpSync(subject, out, {
    recursive: true,
    filter: (src) => !/[/\\](node_modules|dist|\.git)$/.test(src),
  });
  symlinkSync(nodeModules, join(out, 'node_modules'), 'dir');
  for (const part of FROM_BASE) {
    rmSync(join(out, part), { recursive: true, force: true });
    if (existsSync(join(base, part)))
      cpSync(join(base, part), join(out, part), { recursive: true });
  }
  return FROM_BASE;
}
