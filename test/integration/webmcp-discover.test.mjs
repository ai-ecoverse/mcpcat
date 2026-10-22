import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mcpcatArgs } from './helpers/bin.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const fixturesDir = join(root, 'test/integration/fixtures');
const fakePwCli = join(fixturesDir, 'fake-playwright-cli.sh');
const fixture = join(fixturesDir, 'webmcp-tools.json');
const home = join(tmpdir(), `mcpcat-webmcp-discover-${process.pid}-${Date.now()}`);
mkdirSync(join(home, '.pi', 'agent'), { recursive: true });
const env = {
  ...process.env,
  NODE_NO_WARNINGS: '1',
  NO_COLOR: '1',
  HOME: home,
  PI_CODING_AGENT_DIR: join(home, '.pi', 'agent'),
  FAKE_PWCLI_FIXTURE: fixture,
};

const WEBMCP_FLAGS = [
  '--webmcp',
  '--cdp',
  '--tab',
  '--allow-consequential',
  '--webmcp-ttl',
  '--playwright-cli',
];

function mcpcat(args) {
  const { cmd, args: argv } = mcpcatArgs(args);
  const r = spawnSync(cmd, argv, { encoding: 'utf8', env, timeout: 20_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function flagLine(text, flag) {
  return new RegExp(`^ {2}${flag}(?: \\S+)? {2,}\\S`, 'm').test(text);
}

describe('webmcp discoverability', () => {
  it('--help lists every serve --webmcp flag', () => {
    const r = mcpcat(['--help']);
    assert.equal(r.code, 0, r.stderr);
    for (const flag of WEBMCP_FLAGS) assert.ok(flagLine(r.stdout, flag), `${flag} in --help`);
    assert.match(r.stdout, /serve --help/);
  });

  for (const args of [
    ['serve', '--help'],
    ['serve', '-h'],
    ['serve', '--webmcp', '--help'],
    ['help', 'serve'],
  ]) {
    it(`${args.join(' ')} prints the serve help`, () => {
      const r = mcpcat(args);
      assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /^mcpcat \S+ – serve$/m);
      assert.match(r.stdout, /^Usage: mcpcat serve /m);
      assert.doesNotMatch(r.stdout, /Client verbs:/);
      for (const flag of [...WEBMCP_FLAGS, '--http', '--proxy', '--bearer', '--no-auth']) {
        assert.ok(flagLine(r.stdout, flag), `${flag} in ${args.join(' ')}`);
      }
      assert.match(r.stdout, /--webmcp-ttl <s> +.*\(default 5\)/);
    });
  }

  it('help --skill teaches serve --webmcp and its flags', () => {
    const r = mcpcat(['help', '--skill']);
    assert.equal(r.code, 0, r.stderr);
    for (const flag of WEBMCP_FLAGS) assert.ok(r.stdout.includes(`\`${flag}`), `${flag} in skill`);
    assert.match(r.stdout, /serve --webmcp/);
  });
});

describe('webmcp annotations through the client', () => {
  let child;
  let url;

  before(async () => {
    const { cmd, args } = mcpcatArgs([
      'serve',
      '--webmcp',
      '--allow-consequential',
      '--http',
      '0',
      '--no-auth',
      '--playwright-cli',
      fakePwCli,
    ]);
    child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'], env });
    url = await new Promise((resolve, reject) => {
      let data = '';
      child.stderr.on('data', (chunk) => {
        data += chunk.toString();
        const m = data.match(/listening on (http:\/\/\S+\/mcp)/);
        if (m) resolve(m[1]);
      });
      child.on('error', reject);
      child.on('exit', (code) => reject(new Error(`serve exited ${code}: ${data}`)));
    });
  });

  after(() => {
    child?.kill('SIGKILL');
    rmSync(home, { recursive: true, force: true });
  });

  it('tools --json carries untrustedContentHint and maps consequentialHint', () => {
    const r = mcpcat(['--json', 'tools', url]);
    assert.equal(r.code, 0, r.stderr);
    const tools = Object.fromEntries(JSON.parse(r.stdout).tools.map((t) => [t.name, t]));
    assert.deepEqual(tools.search.annotations, { openWorldHint: true, untrustedContentHint: true });
    assert.deepEqual(tools.get_price.annotations, { openWorldHint: true, readOnlyHint: true });
    assert.deepEqual(tools.place_order.annotations, {
      openWorldHint: true,
      destructiveHint: true,
      consequentialHint: true,
    });
  });

  it('tools shows the page hints in human output', () => {
    const r = mcpcat(['tools', url]);
    assert.equal(r.code, 0, r.stderr);
    const lines = r.stdout.trim().split('\n');
    const line = (name) => lines.find((l) => l.startsWith(`${name} `));
    assert.match(line('get_price'), /^get_price \[read-only\] {2}Returns the current price/);
    assert.match(line('search'), /^search \[untrusted\] {2}Searches the page content/);
    assert.match(line('place_order'), /^place_order \[consequential\] {2}Places an order/);
  });
});
