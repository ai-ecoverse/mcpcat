import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mcpcatArgs } from './helpers/bin.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const fixturesDir = join(root, 'test/integration/fixtures');
const fakePwCli = join(fixturesDir, 'fake-playwright-cli.sh');
const policyFixture = join(fixturesDir, 'webmcp-tools-policy.json');

const testHome = join(tmpdir(), `mcpcat-webmcp-polyfill-${process.pid}-${Date.now()}`);
mkdirSync(testHome, { recursive: true });
const children = [];
let n = 0;

after(() => {
  for (const c of children) {
    try {
      c.kill('SIGKILL');
    } catch {}
  }
  rmSync(testHome, { recursive: true, force: true });
});

function scratch() {
  const dir = join(testHome, `case-${++n}`);
  mkdirSync(dir, { recursive: true });
  return { log: join(dir, 'log.jsonl'), holder: join(dir, 'holder') };
}

function readLog(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function baseEnv(dirs, extra = {}) {
  return {
    ...process.env,
    NODE_NO_WARNINGS: '1',
    HOME: testHome,
    FAKE_PWCLI_FIXTURE: policyFixture,
    FAKE_PWCLI_LOG: dirs.log,
    FAKE_PWCLI_HOLDER_FILE: dirs.holder,
    FAKE_PWCLI_HOLDER: 'polyfill',
    FAKE_PWCLI_NEEDS_HOLDER: '1',
    ...extra,
  };
}

function rpc(method, params, id) {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

const INIT = rpc(
  'initialize',
  { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't' } },
  1
);

function run(args, env, input) {
  const { cmd, args: cmdArgs } = mcpcatArgs(args);
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      cmdArgs,
      { encoding: 'utf8', timeout: 20_000, env },
      (err, stdout, stderr) => resolve({ status: err ? (err.code ?? 1) : 0, stdout, stderr })
    );
    if (input !== undefined) child.stdin.end(input);
  });
}

function stdioServe(extra, env) {
  const input = `${[INIT, rpc('tools/list', {}, 2)].join('\n')}\n`;
  return run(['serve', '--webmcp', '--playwright-cli', fakePwCli, ...extra], env, input);
}

function listResult(stdout) {
  return JSON.parse(stdout.trim().split('\n')[1]);
}

async function httpServe(extra, env) {
  const { cmd, args } = mcpcatArgs([
    'serve',
    '--webmcp',
    '--http',
    '0',
    '--no-auth',
    '--playwright-cli',
    fakePwCli,
    ...extra,
  ]);
  const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
  children.push(child);
  let stderr = '';
  const port = await new Promise((resolve, reject) => {
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      const match = stderr.match(/listening on http:\/\/[^:]+:(\d+)\/mcp/);
      if (match) resolve(Number(match[1]));
    });
    child.on('exit', (code) => reject(new Error(`serve exited ${code}: ${stderr}`)));
  });
  return { child, port, stderr: () => stderr };
}

async function until(check, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

function stopped(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) resolve(child.exitCode);
    else child.on('exit', (code, signal) => resolve(code ?? signal));
  });
}

describe('serve --webmcp polyfill', () => {
  it('auto starts the holder on the pinned tab and lists through it', async () => {
    const dirs = scratch();
    const r = await stdioServe(['--tab', 'TAB1'], baseEnv(dirs));
    assert.equal(r.status, 0, r.stderr);
    const names = listResult(r.stdout).result.tools.map((t) => t.name);
    assert.deepEqual(names, ['get_inbox_state', 'open_thread']);
    const log = readLog(dirs.log);
    const holders = log.filter((e) => e.command === 'webmcp-polyfill');
    assert.equal(holders.length, 1);
    assert.equal(holders[0].tab, 'TAB1');
    assert.equal(holders[0].reload, false);
    assert.ok(log.filter((e) => e.command === 'webmcp-list').every((e) => e.holder));
    assert.ok(log.some((e) => e.command === 'webmcp-polyfill-stdin-closed'));
    assert.equal(existsSync(dirs.holder), false);
  });

  it('--webmcp-polyfill off never starts the holder and hints that WebMCP is missing', async () => {
    const dirs = scratch();
    const r = await stdioServe(['--webmcp-polyfill', 'off'], baseEnv(dirs));
    assert.equal(r.status, 0, r.stderr);
    const resp = listResult(r.stdout);
    assert.deepEqual(resp.result.tools, []);
    assert.match(resp.result._meta['io.mcpcat/hint'], /--webmcp-polyfill is off/);
    assert.match(r.stderr, /WebMCP is not enabled in this browser/);
    assert.ok(!readLog(dirs.log).some((e) => e.command === 'webmcp-polyfill'));
  });

  it('a native browser stops the holder and never restarts it', async () => {
    const dirs = scratch();
    const env = baseEnv(dirs, { FAKE_PWCLI_HOLDER: 'native', FAKE_PWCLI_NEEDS_HOLDER: '' });
    const { child, port } = await httpServe([], env);
    await until(() => readLog(dirs.log).some((e) => e.command === 'webmcp-polyfill-stdin-closed'));
    await new Promise((r) => setTimeout(r, 1200));
    const resp = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: rpc('tools/list', {}, 2),
    }).then((res) => res.json());
    assert.ok(!resp.result.tools.some((t) => t.annotations.late));
    assert.equal(readLog(dirs.log).filter((e) => e.command === 'webmcp-polyfill').length, 1);
    child.kill('SIGTERM');
    await stopped(child);
  });

  it('restarts a holder that exits, without reloading the tab again', async () => {
    const dirs = scratch();
    const env = baseEnv(dirs, { FAKE_PWCLI_HOLDER_EXIT_FIRST: '100' });
    const { child, stderr } = await httpServe(['--webmcp-reload'], env);
    const restarted = await until(
      () => readLog(dirs.log).filter((e) => e.command === 'webmcp-polyfill').length >= 2
    );
    assert.ok(restarted, stderr());
    const holders = readLog(dirs.log).filter((e) => e.command === 'webmcp-polyfill');
    assert.equal(holders[0].reload, true);
    assert.equal(holders[1].reload, false);
    assert.match(stderr(), /holder for tab TAB1 exited .*target closed.*; restarting/);
    child.kill('SIGTERM');
    await stopped(child);
    assert.ok(
      await until(() => readLog(dirs.log).some((e) => e.command === 'webmcp-polyfill-stdin-closed'))
    );
  });

  it('backs off a holder that becomes ready and exits right away', async () => {
    const dirs = scratch();
    const env = baseEnv(dirs, { FAKE_PWCLI_HOLDER_EXIT_ALWAYS: '50' });
    const { child, stderr } = await httpServe([], env);
    await new Promise((r) => setTimeout(r, 3500));
    const holders = readLog(dirs.log).filter((e) => e.command === 'webmcp-polyfill').length;
    child.kill('SIGTERM');
    await stopped(child);
    assert.ok(holders >= 2 && holders <= 4, `${holders} holder starts in 3.5s\n${stderr()}`);
    assert.match(stderr(), /restarting in 2s/);
  });

  it('surfaces policy and late in tools --json and the human tools output', async () => {
    const dirs = scratch();
    const { child, port } = await httpServe([], baseEnv(dirs));
    const url = `http://127.0.0.1:${port}/mcp`;
    const env = { ...process.env, NODE_NO_WARNINGS: '1', HOME: testHome };
    const json = await run(['tools', url, '--json'], env);
    assert.equal(json.status, 0, json.stderr);
    const tools = JSON.parse(json.stdout).tools;
    const byName = Object.fromEntries(tools.map((t) => [t.name, t.annotations]));
    assert.equal(byName.get_inbox_state.policy, 'allowed');
    assert.equal(byName.open_thread.policy, 'unknown');
    assert.equal(byName.get_inbox_state.late, true);
    assert.equal(byName.get_inbox_state.untrustedContentHint, true);
    assert.equal(byName.send_reply, undefined);
    const human = await run(['tools', url], env);
    assert.equal(human.status, 0, human.stderr);
    assert.match(human.stdout, /get_inbox_state \[read-only, untrusted, policy: allowed, late\]/);
    assert.match(human.stdout, /open_thread \[untrusted, policy: unknown, late\]/);
    const call = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: rpc('tools/call', { name: 'get_inbox_state', arguments: {} }, 3),
    }).then((res) => res.json());
    assert.match(call.result.content[0].text, /^<<untrusted-page-content id=[0-9a-f]{16}>>/);
    child.kill('SIGTERM');
    await stopped(child);
  });

  it('drops late after --webmcp-reload and after the holder reports a new document', async () => {
    const reloaded = scratch();
    const r = await stdioServe(['--webmcp-reload'], baseEnv(reloaded));
    assert.equal(r.status, 0, r.stderr);
    const tools = listResult(r.stdout).result.tools;
    assert.ok(tools.every((t) => t.annotations.late === undefined));
    assert.equal(readLog(reloaded.log).find((e) => e.command === 'webmcp-polyfill').reload, true);

    const navigated = scratch();
    const env = baseEnv(navigated, { FAKE_PWCLI_HOLDER_NAVIGATE: '300' });
    const { child, port } = await httpServe(['--webmcp-ttl', '60'], env);
    const list = () =>
      fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: rpc('tools/list', {}, 2),
      }).then((res) => res.json());
    assert.equal((await list()).result.tools[0].annotations.late, true);
    await new Promise((r) => setTimeout(r, 600));
    assert.equal((await list()).result.tools[0].annotations.late, undefined);
    child.kill('SIGTERM');
    await stopped(child);
  });

  it('hints at --webmcp-reload when a late polyfill shows 0 tools', async () => {
    const dirs = scratch();
    const env = baseEnv(dirs, { FAKE_PWCLI_HOLDER_EMPTY: '1' });
    const r = await stdioServe([], env);
    assert.equal(r.status, 0, r.stderr);
    const resp = listResult(r.stdout);
    assert.deepEqual(resp.result.tools, []);
    assert.match(resp.result._meta['io.mcpcat/hint'], /--webmcp-reload/);
    assert.match(r.stderr, /reload the tab, or restart with --webmcp-reload/);

    const { child, port } = await httpServe(
      [],
      baseEnv(scratch(), { FAKE_PWCLI_HOLDER_EMPTY: '1' })
    );
    const clientEnv = { ...process.env, NODE_NO_WARNINGS: '1', HOME: testHome };
    const human = await run(['tools', `http://127.0.0.1:${port}/mcp`], clientEnv);
    assert.equal(human.stdout, '(no tools)\n');
    assert.match(human.stderr, /hint: the page may check for WebMCP only when it loads/);
    const json = await run(['tools', `http://127.0.0.1:${port}/mcp`, '--json'], clientEnv);
    assert.match(JSON.parse(json.stdout).hint, /--webmcp-reload/);
    child.kill('SIGTERM');
    await stopped(child);
  });

  it('an older playwright-cli gets a warning and no holder', async () => {
    const dirs = scratch();
    const r = await stdioServe([], baseEnv(dirs, { FAKE_PWCLI_VERSION: '1.30.22' }));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /needs playwright-cli 1\.32\.0 or newer \(found 1\.30\.22\)/);
    assert.ok(!readLog(dirs.log).some((e) => e.command === 'webmcp-polyfill'));
  });

  it('passes --webmcp-from-origin to webmcp-list and webmcp-call', async () => {
    const dirs = scratch();
    const input = `${[INIT, rpc('tools/call', { name: 'get_inbox_state', arguments: {} }, 2)].join('\n')}\n`;
    const r = await run(
      [
        'serve',
        '--webmcp',
        '--playwright-cli',
        fakePwCli,
        '--webmcp-from-origin',
        'https://widgets.example.com',
        '--webmcp-from-origin',
        'https://pay.example.com',
      ],
      baseEnv(dirs),
      input
    );
    assert.equal(r.status, 0, r.stderr);
    const log = readLog(dirs.log);
    for (const command of ['webmcp-list', 'webmcp-call']) {
      const entry = log.find((e) => e.command === command);
      assert.ok(entry, command);
      const argv = entry.argv.join(' ');
      assert.match(argv, /--from-origin https:\/\/widgets\.example\.com/);
      assert.match(argv, /--from-origin https:\/\/pay\.example\.com/);
    }
    assert.ok(!log.find((e) => e.command === 'webmcp-polyfill').argv.includes('--from-origin'));
  });

  it('rejects a bad --webmcp-polyfill, --webmcp-reload with off, and a non-origin', async () => {
    const env = baseEnv(scratch());
    for (const extra of [
      ['--webmcp-polyfill', 'always'],
      ['--webmcp-polyfill', 'off', '--webmcp-reload'],
      ['--webmcp-from-origin', 'https://pay.example.com/path'],
    ]) {
      const r = await stdioServe(extra, env);
      assert.equal(r.status, 2, `${extra.join(' ')}: ${r.stderr}`);
      assert.match(r.stderr, /mcpcat serve --webmcp: --webmcp-/);
    }
  });

  it('serve --help documents the polyfill flags', async () => {
    const r = await run(['serve', '--help'], { ...process.env, NODE_NO_WARNINGS: '1' });
    for (const flag of ['--webmcp-polyfill auto|off', '--webmcp-reload', '--webmcp-from-origin']) {
      assert.ok(r.stdout.includes(flag), flag);
    }
    const skill = await run(['help', '--skill'], { ...process.env, NODE_NO_WARNINGS: '1' });
    assert.match(skill.stdout, /webmcp-polyfill/);
  });
});
