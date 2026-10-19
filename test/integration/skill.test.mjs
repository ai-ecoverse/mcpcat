import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mcpcatArgs } from './helpers/bin.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const skillFile = join(root, 'src/skill/SKILL.txt');
const builtFile = join(root, 'dist/skills/mcpcat/SKILL.md');
const skill = readFileSync(skillFile, 'utf8');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function mcpcat(args) {
  const { cmd, args: argv } = mcpcatArgs(args);
  const r = spawnSync(cmd, argv, { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function frontmatter(text) {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(text);
  assert.ok(m, 'SKILL.md starts with a frontmatter block');
  return Object.fromEntries(
    m[1].split('\n').map((line) => {
      const at = line.indexOf(':');
      return [line.slice(0, at).trim(), line.slice(at + 1).trim()];
    })
  );
}

describe('the agent skill', () => {
  it('help --skill prints the SKILL.md this package ships, byte for byte', () => {
    const r = mcpcat(['help', '--skill']);
    assert.equal(r.code, 0, r.stderr);
    assert.equal(r.stdout, skill);
    assert.equal(r.stderr, '');
  });

  it('--help names help --skill', () => {
    const r = mcpcat(['--help']);
    assert.equal(r.code, 0);
    assert.match(
      r.stdout,
      /^ {2}help --skill +Print the agent skill \(SKILL\.md\) for this version$/m
    );
  });

  it('is a valid Agent Skill whose name is its folder name', () => {
    const fm = frontmatter(skill);
    assert.equal(fm.name, 'mcpcat');
    assert.match(fm.name, /^[a-z0-9][a-z0-9-]*$/);
    assert.ok(fm.description.length > 0 && fm.description.length <= 1024, fm.description);
    assert.equal(Object.keys(fm).sort().join(), 'description,name');
  });

  it('teaches the secrets rule: placeholders, never values, never tokens in mcp.json', () => {
    assert.match(skill, /\*\*Never print, echo, log or paste a secret's value\*\*/);
    assert.match(skill, /-H 'Authorization: Bearer \$\{GH_TOKEN\}'/);
    assert.match(skill, /\*\*Never put a token into `mcp\.json`\.\*\*/);
    assert.match(skill, /`-v` traces show expanded headers as `\[REDACTED\]`/);
  });

  it('only names verbs and flags mcpcat has', () => {
    const help = mcpcat(['--help']).stdout;
    for (const verb of [
      'info',
      'tools',
      'describe',
      'call',
      'grep',
      'add',
      'list',
      'rm',
      'import',
      'login',
      'logout',
      'code',
    ])
      assert.match(help, new RegExp(`^ {2}${verb}\\b`, 'm'), verb);
    for (const flag of [
      '--json',
      '-d <json>',
      '-m, --timeout',
      '--schema',
      '--ts',
      '-s, --server',
      '-v, --verbose',
    ])
      assert.ok(help.includes(flag), flag);
  });

  it('ships in the npm package and is declared for pi as a package skill', () => {
    assert.deepEqual(pkg.pi, { skills: ['dist/skills'] });
    assert.equal(readFileSync(builtFile, 'utf8'), skill);
    const packed = JSON.parse(
      execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    );
    const files = packed[0].files.map((f) => f.path);
    assert.ok(files.includes('dist/skills/mcpcat/SKILL.md'), files.join(' '));
  });
});
