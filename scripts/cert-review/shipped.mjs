#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { delta, isGate, isShipped } from './classify.mjs';

const { values } = parseArgs({
  options: {
    base: { type: 'string' },
    head: { type: 'string' },
    repo: { type: 'string', default: '.' },
  },
});
if (!values.base || !values.head) {
  console.error('shipped: --base <ref> and --head <ref> are required');
  process.exit(2);
}
const r = delta(resolve(values.repo), values.base, values.head);
const part = (files, kind) =>
  `${files.length} ${kind} file${files.length === 1 ? '' : 's'} changed: ${files.join(', ')}`;
const line = r.behaviour
  ? `behaviour: ${[r.shipped.length && part(r.shipped, 'shipped'), r.gate.length && part(r.gate, 'gate')].filter(Boolean).join('; ')}`
  : `not behaviour: none of the ${r.changed.length} changed files is shipped or part of the gate`;
if (process.env.GITHUB_OUTPUT)
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `behaviour=${r.behaviour}\nmerge_base=${r.base}\nfiles=${r.files.join(' ')}\n`
  );
console.log(line);
for (const f of r.changed)
  console.log(`${isShipped(f) ? 'shipped' : isGate(f) ? 'gate' : 'not shipped'}: ${f}`);
