#!/usr/bin/env node
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const minVersion = pkg.engines['slicc-kernel'].replace(/^>=/, '');

console.log(`Testing against slicc-kernel@${minVersion} (engines minimum)...`);

execSync(`npm install --no-save @ai-ecoverse/slicc-kernel@${minVersion}`, {
  cwd: root,
  stdio: 'inherit',
});

try {
  const concurrency = process.env.TEST_CONCURRENCY
    ? ` --test-concurrency=${process.env.TEST_CONCURRENCY}`
    : '';
  execSync(`node --test${concurrency} --test-timeout=30000 test/integration/*kernel*.test.mjs`, {
    cwd: root,
    stdio: 'inherit',
  });
  console.log(`\nAll kernel tests passed on slicc-kernel@${minVersion}`);
} finally {
  execSync('npm ci', { cwd: root, stdio: 'inherit' });
}
