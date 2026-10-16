#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const here = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: { work: { type: 'string' }, only: { type: 'string', default: '' } },
});
const work = resolve(values.work);
const stage = JSON.parse(readFileSync(join(work, 'stage.json'), 'utf8'));
const rows = JSON.parse(readFileSync(join(here, 'rows.json'), 'utf8'));
const logs = join(work, 'logs');
mkdirSync(logs, { recursive: true });

const KERNEL_HELPER = /from '\.\/helpers\/kernel\.mjs'/;
const testFile = (tree, name) => join(tree, 'test/integration', `${name}.test.mjs`);
const usesKernel = (tree, name) => KERNEL_HELPER.test(readFileSync(testFile(tree, name), 'utf8'));
const clean = { ...process.env, NODE_NO_WARNINGS: '1' };
for (const k of ['NODE_TEST_CONTEXT', 'MCPCAT_CERT_KERNEL_DIR', 'MCPCAT_BIN']) delete clean[k];

function suite(name, cwd, cmd, args, env = {}, expectKernel) {
  if (values.only && !name.includes(values.only)) return undefined;
  const log = join(logs, `${name.replace(/[^\w.@-]+/g, '_')}.log`);
  const started = Date.now();
  console.log(`suites: ${name}: (${cwd}) ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, {
    cwd,
    env: { ...clean, ...env },
    encoding: 'utf8',
    timeout: 30 * 60_000,
    maxBuffer: 256 * 1024 * 1024,
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  writeFileSync(log, out);
  const count = (what) =>
    [...out.matchAll(new RegExp(`^ℹ ${what} (\\d+)$`, 'gm'))].reduce((n, m) => n + Number(m[1]), 0);
  const failed = [
    ...new Set([...out.matchAll(/^\s*✖ (.+?)(?: \([\d.]+m?s\))?$/gm)].map((m) => m[1])),
  ].filter((t) => t !== 'failing tests:');
  const kernelSeen = expectKernel ? out.includes(`kernel ${expectKernel}`) : undefined;
  const exit = r.status ?? (r.error ? `error ${r.error.code}` : `signal ${r.signal}`);
  const ok = r.status === 0 && kernelSeen !== false;
  const result = {
    name,
    ok,
    exit,
    pass: count('pass'),
    fail: count('fail'),
    skipped: count('skipped'),
    failed,
    kernelSeen,
    seconds: Math.round((Date.now() - started) / 1000),
    log,
  };
  console.log(
    `suites: ${name}: ${ok ? 'ok' : 'FAILED'} exit ${exit}, pass ${result.pass}, fail ${result.fail}, ${result.seconds}s`
  );
  return result;
}

const results = [];
const add = (r) => r && results.push(r);
const { tag, rows: rowsTree, neg } = stage.trees;

add(suite('subject host suite', tag, 'npm', ['run', 'test:integration']));
for (const k of stage.kernels) {
  add(
    suite(
      `subject cert kernel ${k.version}`,
      tag,
      'npm',
      ['run', 'cert', '--', `--kernel=${k.tgz}`],
      {},
      k.version
    )
  );
}

const names = [...new Set(Object.values(rows).flat())];
const hostRows = names.filter((n) => !usesKernel(rowsTree, n));
const kernelRows = names.filter((n) => usesKernel(rowsTree, n));
const rowArgs = (files) => [
  '--test',
  '--test-concurrency=1',
  '--test-timeout=120000',
  ...files.map((n) => testFile(rowsTree, n)),
];
add(suite('rows host', rowsTree, process.execPath, rowArgs(hostRows)));
for (const k of stage.kernels) {
  add(
    suite(
      `rows kernel ${k.version}`,
      rowsTree,
      process.execPath,
      rowArgs(kernelRows),
      { MCPCAT_CERT_KERNEL_DIR: k.dir },
      k.version
    )
  );
}

const negative = (stage.changedTests ?? [])
  .map((file) => {
    const args = ['--test', '--test-concurrency=1', '--test-timeout=120000', file];
    const head = suite(`negative head ${file}`, tag, process.execPath, args);
    const base = suite(`negative base ${file}`, neg, process.execPath, args);
    if (!head || !base) return undefined;
    return {
      file,
      head: { ok: head.ok, pass: head.pass, fail: head.fail, log: head.log },
      base: { ok: base.ok, pass: base.pass, fail: base.fail, failed: base.failed, log: base.log },
      bites: head.ok && !base.ok,
    };
  })
  .filter(Boolean);

const summary = {
  version: stage.version,
  prev: stage.prev,
  rows,
  hostRows,
  kernelRows,
  negTree: neg,
  negative,
  negativeOk: negative.every((n) => n.bites),
  ok: results.every((r) => r.ok),
  results,
};
writeFileSync(join(work, 'suites.json'), `${JSON.stringify(summary, null, 2)}\n`);
console.log(
  `suites: ${
    summary.ok
      ? 'all passed'
      : `failed: ${results
          .filter((r) => !r.ok)
          .map((r) => r.name)
          .join(', ')}`
  }`
);
