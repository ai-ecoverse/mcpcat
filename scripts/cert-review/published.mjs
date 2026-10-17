#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { checkPublished, WORKFLOW } from './released.mjs';
import { NAME, SEMVER } from './tarball.mjs';

const { values } = parseArgs({
  options: {
    version: { type: 'string' },
    repo: { type: 'string', default: 'ai-ecoverse/mcpcat' },
    wait: { type: 'string', default: '300' },
  },
});

const { version, repo } = values;
if (!SEMVER.test(version ?? '')) {
  console.error('published: --version must be x.y.z');
  process.exit(2);
}
const { problems, missing, facts } = await checkPublished({ version, repo, wait: values.wait });
const all = [...problems, ...missing];
const line = all.length
  ? `cert-ci: FAIL published ${NAME}@${version}: ${all.join('; ')}`
  : `verified ${NAME}@${version} sha256=${facts.sha256} on npm: ${facts.integrity}, provenance ${WORKFLOW}@refs/heads/main commit ${facts.provenance.gitCommit} = gitHead = tag v${version}, on main`;
console.log(line);
process.exit(all.length ? 1 : 0);
