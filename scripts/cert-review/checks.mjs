import { execFileSync } from 'node:child_process';
import { NAME } from './tarball.mjs';

export const one = (text) =>
  String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();

export function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts });
}

export const gh = (path) => JSON.parse(run('gh', ['api', path]));

const DEP_FIELDS = [
  'dependencies',
  'optionalDependencies',
  'peerDependencies',
  'bundleDependencies',
  'bundledDependencies',
];

export function checkManifest(tgz, version, fail, facts) {
  const files = run('tar', ['-tzf', tgz]).trim().split('\n');
  const manifest = JSON.parse(run('tar', ['-xzf', tgz, '-O', 'package/package.json']));
  facts.files = files;
  facts.gitHead = manifest.gitHead ?? null;
  if (manifest.name !== NAME || manifest.version !== version) {
    fail(`the tarball's package.json is ${manifest.name}@${manifest.version}`);
  }
  for (const field of DEP_FIELDS) {
    const v = manifest[field];
    const n = Array.isArray(v) ? v.length : Object.keys(v ?? {}).length;
    if (n) fail(`${field} has ${n} entries: ${JSON.stringify(v)}`);
  }
  const scripts = Object.keys(manifest.scripts ?? {}).filter((s) =>
    /^(pre|post)?install$|^prepare$/.test(s)
  );
  if (scripts.length) fail(`install scripts: ${scripts.join(', ')}`);
  if (files.some((f) => f.endsWith('/binding.gyp')))
    fail('the tarball has a binding.gyp (an implicit install script)');
  return manifest;
}

export function tagOnMain(repo, version, fail, facts) {
  let ref = gh(`repos/${repo}/git/ref/tags/v${version}`).object;
  if (ref.type === 'tag') ref = gh(`repos/${repo}/git/tags/${ref.sha}`).object;
  facts.tagCommit = ref.sha;
  const cmp = gh(`repos/${repo}/compare/main...${ref.sha}`);
  facts.onMain = cmp.status;
  if (cmp.status !== 'identical' && cmp.status !== 'behind')
    fail(`tag v${version} (${ref.sha}) is ${cmp.status} of main`);
  return ref.sha;
}
