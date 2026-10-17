#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { one, run } from './checks.mjs';

const { values } = parseArgs({
  options: {
    repo: { type: 'string', default: 'ai-ecoverse/mcpcat' },
    run: { type: 'string', default: '' },
    artifact: { type: 'string', multiple: true, default: [] },
    optional: { type: 'string', multiple: true, default: [] },
    prefix: { type: 'string', multiple: true, default: [] },
    allow: { type: 'string', multiple: true, default: [] },
  },
});
const { repo } = values;
const problems = [];
const bound = [];
const api = (path) => JSON.parse(run('gh', ['api', path]));

function parse(spec) {
  const m = /^([^=]+)=([^@]*)@(.*)$/.exec(spec);
  if (!m) return { name: spec, id: '', digest: '' };
  return { name: m[1], id: m[2], digest: m[3].replace(/^sha256:/, '') };
}

function check({ name, id, digest }) {
  if (!/^\d+$/.test(id)) return problems.push(`${name}: the producer output no artifact id`);
  if (!/^[0-9a-f]{64}$/.test(digest))
    return problems.push(`${name}: the producer output no sha256 digest`);
  let a;
  try {
    a = api(`repos/${repo}/actions/artifacts/${id}`);
  } catch (error) {
    return problems.push(
      `${name}: artifact ${id} couldn't be read (${one(error.stderr || error.message).slice(0, 200)})`
    );
  }
  const wrong = [];
  if (a.name !== name) wrong.push(`is named ${one(a.name)}`);
  if (String(a.workflow_run?.id) !== values.run)
    wrong.push(`is from run ${one(a.workflow_run?.id)}`);
  if (a.digest !== `sha256:${digest}`) wrong.push(`has digest ${one(a.digest)}`);
  if (a.expired) wrong.push('has expired');
  if (wrong.length)
    return problems.push(
      `${name}: artifact ${id} ${wrong.join(', ')}, not sha256:${digest} from run ${values.run}`
    );
  bound.push(Number(id));
  console.log(`bind: ${name} is artifact ${id} sha256:${digest} from run ${values.run}`);
  return undefined;
}

function extras() {
  let all;
  try {
    all = JSON.parse(
      run('gh', [
        'api',
        '--paginate',
        '--slurp',
        `repos/${repo}/actions/runs/${values.run}/artifacts?per_page=100`,
      ])
    ).flatMap((p) => p.artifacts ?? []);
  } catch (error) {
    return problems.push(
      `this run's artifacts couldn't be listed (${one(error.stderr || error.message).slice(0, 200)})`
    );
  }
  for (const a of all) {
    if (!values.prefix.some((p) => String(a.name).startsWith(p))) continue;
    if (bound.includes(a.id) || values.allow.includes(a.name)) continue;
    problems.push(`an unexpected artifact ${one(a.name)} (${a.id}) in this run`);
  }
  return undefined;
}

if (!/^\d+$/.test(values.run) || !values.artifact.length) {
  console.error('bind: --run <id> and at least one --artifact name=id@digest are required');
  process.exit(2);
}
for (const spec of values.artifact) check(parse(spec));
for (const spec of values.optional) {
  const a = parse(spec);
  if (a.id) check(a);
}
if (values.prefix.length) extras();
if (problems.length) {
  console.log(`bind: INCOMPLETE ${problems.join('; ')}`);
  process.exit(1);
}
console.log(
  `bind: ok, ${bound.length} artifacts bound by id and digest, and no other in this run's namespaces`
);
