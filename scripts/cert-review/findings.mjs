import { existsSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { one } from './checks.mjs';

const read = (dir, file) => {
  if (!dir || !existsSync(join(dir, file))) return undefined;
  try {
    return JSON.parse(readFileSync(join(dir, file), 'utf8'));
  } catch {
    return undefined;
  }
};

const list = (v) => (Array.isArray(v) ? v : []);

function binding(stage, suites, version, sha256, out) {
  if (stage.version !== version || suites.version !== version)
    out.gaps.push(
      `the evidence is for ${one(stage.version)}/${one(suites.version)}, not ${version}`
    );
  if (sha256 && stage.artifact?.sha256 !== sha256)
    out.gaps.push(`the suites ran on sha256 ${one(stage.artifact?.sha256)}, not the artifact's`);
}

function results(stage, suites, out) {
  const kernels = list(stage.kernels);
  if (!kernels.length) out.gaps.push('no pinned kernel was staged');
  const ran = list(suites.results);
  const expected = [
    'subject host suite',
    'rows host',
    ...kernels.flatMap((k) => [`subject cert kernel ${k.version}`, `rows kernel ${k.version}`]),
  ];
  for (const name of expected)
    if (!ran.some((r) => r.name === name)) out.gaps.push(`${name} didn't run`);
  for (const r of ran) {
    const failed = list(r.failed).slice(0, 5).map(one).join(', ');
    if (r.kernelSeen === false) out.gaps.push(`${r.name} didn't run on its kernel`);
    else if (r.exit !== 0)
      out.defects.push(`${r.name} failed (exit ${one(r.exit)}${failed ? `: ${failed}` : ''})`);
    else if (!(r.pass > 0)) out.gaps.push(`${r.name} ran no tests`);
  }
}

function securityRows(suites, rows, out) {
  if (JSON.stringify(suites.rows) !== JSON.stringify(rows))
    out.gaps.push("the security rows that ran aren't rows.json's");
  const ran = new Set([...list(suites.hostRows), ...list(suites.kernelRows)]);
  for (const name of new Set(Object.values(rows).flat()))
    if (!ran.has(name)) out.gaps.push(`the security row test ${name} didn't run`);
}

const SHA = /^[0-9a-f]{40}$/;

function negativeBase(stage, out) {
  const n = stage.negative ?? {};
  out.negative = { tests: n.tests ?? null, base: n.base ?? null, fromBase: list(n.fromBase) };
  if (!list(stage.changedTests).length) return;
  const named = SHA.test(n.tests ?? '') && SHA.test(n.base ?? '');
  if (!named || n.tests !== stage.subject?.commit || n.base !== stage.base?.commit)
    out.gaps.push("the NEGATIVE doesn't name the subject's tests and the base's sha it ran on");
  for (const part of ['dist', 'scripts', '.github/workflows'])
    if (!out.negative.fromBase.includes(part))
      out.gaps.push(`the NEGATIVE didn't take ${part} from the base`);
}

function negative(stage, suites, out) {
  negativeBase(stage, out);
  const runs = list(suites.negative);
  for (const file of list(stage.changedTests)) {
    const n = runs.find((x) => x.file === file);
    if (!n) out.gaps.push(`the NEGATIVE didn't run ${file}`);
    else if (!n.head?.ok) out.defects.push(`the changed test ${file} fails on the subject`);
    else if (n.base?.ok) out.notes.push(`no-negative ${basename(file)}`);
  }
}

function surface(stage, version, rebuild, out) {
  const bundle = stage.surface?.[version]?.kernelBundle;
  if (!bundle) out.gaps.push('no surface of the kernel bundle');
  else if (list(bundle.imports).length)
    out.defects.push(`the kernel bundle imports ${bundle.imports.map(one).join(', ')}`);
  if (!rebuild) return;
  for (const d of list(stage.rebuildDiff?.unexplained))
    out.defects.push(`not reproducible: ${one(d)}`);
}

export function codeFindings({ dir, rows, version, sha256, rebuild = true }) {
  const out = { defects: [], gaps: [], notes: [] };
  const stage = read(dir, 'stage.json');
  const suites = read(dir, 'suites.json');
  if (!stage || !suites) {
    const absent = [!stage && 'stage.json', !suites && 'suites.json'].filter(Boolean);
    out.gaps.push(`no code-made evidence (${absent.join(' and ')})`);
    return out;
  }
  binding(stage, suites, version, sha256, out);
  results(stage, suites, out);
  securityRows(suites, rows, out);
  negative(stage, suites, out);
  surface(stage, version, rebuild, out);
  return out;
}
