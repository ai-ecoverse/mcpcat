#!/usr/bin/env node
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { manifestOf, NAME, SEMVER, sha } from './tarball.mjs';

const { values } = parseArgs({
  options: {
    tarball: { type: 'string' },
    record: { type: 'string' },
    sha256: { type: 'string', default: '' },
  },
});

function decide() {
  if (!values.tarball || !existsSync(values.tarball)) return { why: 'no tarball' };
  if (!values.record || !existsSync(values.record)) return { why: 'no cert-review record' };
  const record = JSON.parse(readFileSync(values.record, 'utf8'));
  const line = String(record.line ?? '').split('\n')[0];
  const version = String(record.version ?? '');
  const actual = sha('sha256', values.tarball);
  const packed = values.sha256.trim().toLowerCase();
  const subject = SEMVER.test(version) ? `${NAME}@${version}` : NAME;
  const refuse = (why) => ({ subject, line, why });
  if (!SEMVER.test(version)) return refuse(`the record's version is "${version}"`);
  if (record.planted) return refuse(`the record is for a planted build of ${record.planted}`);
  if (record.certified !== true || !line.startsWith(`certified ${subject} `))
    return refuse('the verdict is not certified');
  if (record.sha256 !== actual)
    return refuse(`the verdict's sha256 ${record.sha256} is not the tarball's ${actual}`);
  if (packed !== actual)
    return refuse(`the pack job's sha256 ${packed || '(none)'} is not the tarball's ${actual}`);
  if (!line.startsWith(`certified ${subject} sha256=${actual} `))
    return refuse("the verdict line doesn't name the tarball's sha256");
  const manifest = manifestOf(values.tarball);
  if (manifest.name !== NAME || manifest.version !== version)
    return refuse(`the tarball is ${manifest.name}@${manifest.version}`);
  return { subject, line, sha256: actual };
}

const d = decide();
const say = d.why
  ? `refuse to publish ${d.subject ?? NAME}: ${d.why}${d.line ? `\n${d.line}` : ''}`
  : `publish ${d.subject} sha256=${d.sha256}\n${d.line}`;
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `\`\`\`\n${say}\n\`\`\`\n`);
if (d.why) {
  console.log(`::error::${say.replace(/\n/g, ' | ')}`);
  process.exit(2);
}
console.log(say);
