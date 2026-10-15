import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = 'test/integration';
const usesKernelHelper = /from '\.\/helpers\/kernel\.mjs'/;

export function kernelTestFiles() {
  return readdirSync(join(root, dir))
    .filter((f) => f.endsWith('.test.mjs'))
    .filter((f) => usesKernelHelper.test(readFileSync(join(root, dir, f), 'utf8')))
    .sort()
    .map((f) => `${dir}/${f}`);
}
