#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { kernelTestFiles } from './kernel-test-files.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const minVersion = pkg.engines['slicc-kernel'].replace(/^>=/, '');

console.log(`Testing against slicc-kernel@${minVersion} (engines minimum)...`);

execSync(`npm install --no-save @ai-ecoverse/slicc-kernel@${minVersion}`, {
  cwd: root,
  stdio: 'inherit',
});

try {
  execSync(`node --test --test-timeout=30000 ${kernelTestFiles().join(' ')}`, {
    cwd: root,
    stdio: 'inherit',
  });
  console.log(`\nAll kernel tests passed on slicc-kernel@${minVersion}`);
} finally {
  execSync('npm ci', { cwd: root, stdio: 'inherit' });
}
