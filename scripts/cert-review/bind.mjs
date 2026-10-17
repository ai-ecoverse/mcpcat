#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { gh, one } from './checks.mjs';

const { values } = parseArgs({
  options: {
    repo: { type: 'string', default: 'ai-ecoverse/mcpcat' },
    run: { type: 'string', default: '' },
    name: { type: 'string', default: '' },
    id: { type: 'string', default: '' },
    digest: { type: 'string', default: '' },
  },
});
const { repo, run, name, id } = values;
const digest = values.digest.replace(/^sha256:/, '');
const say = (ok, text) => {
  console.log(ok ? `bind: ${text}` : `bind: INCOMPLETE ${text}`);
  process.exit(ok ? 0 : 1);
};

if (!/^\d+$/.test(id)) say(false, `${name}: the producer output no artifact id ("${one(id)}")`);
if (!/^[0-9a-f]{64}$/.test(digest))
  say(false, `${name}: the producer output no sha256 digest ("${one(values.digest)}")`);
let a;
try {
  a = gh(`repos/${repo}/actions/artifacts/${id}`);
} catch (error) {
  say(
    false,
    `${name}: artifact ${id} couldn't be read (${one(error.stderr || error.message).slice(0, 200)})`
  );
}
const problems = [];
if (a.name !== name) problems.push(`is named ${one(a.name)}`);
if (String(a.workflow_run?.id) !== run) problems.push(`is from run ${one(a.workflow_run?.id)}`);
if (a.digest !== `sha256:${digest}`) problems.push(`has digest ${one(a.digest)}`);
if (a.expired) problems.push('has expired');
if (problems.length)
  say(
    false,
    `${name}: artifact ${id} ${problems.join(', ')}, not ${name} sha256:${digest} from run ${run}`
  );
say(true, `${name} is artifact ${id} sha256:${digest} from run ${run}`);
