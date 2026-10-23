import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mcpcatArgs } from './helpers/bin.mjs';
import { startFakeCdp } from './helpers/fake-cdp.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const fixturesDir = join(root, 'test/integration/fixtures');
const fakePwCli = join(fixturesDir, 'fake-playwright-cli.sh');
const fixture = join(fixturesDir, 'webmcp-tools.json');

const testHome = join(tmpdir(), `mcpcat-webmcp-dialog-${process.pid}-${Date.now()}`);
mkdirSync(join(testHome, '.pi', 'agent'), { recursive: true });
const cleanups = [];
let n = 0;

after(async () => {
  for (const fn of cleanups.reverse()) {
    try {
      await fn();
    } catch {}
  }
  rmSync(testHome, { recursive: true, force: true });
});

function scratch() {
  const dir = join(testHome, `case-${++n}`);
  mkdirSync(dir, { recursive: true });
  return { dir, log: join(dir, 'log.jsonl') };
}

function readLog(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function env(dirs, extra = {}) {
  return {
    ...process.env,
    NODE_NO_WARNINGS: '1',
    HOME: testHome,
    PI_CODING_AGENT_DIR: join(testHome, '.pi', 'agent'),
    SLICC_CDP_URL: '',
    FAKE_PWCLI_FIXTURE: fixture,
    FAKE_PWCLI_LOG: dirs.log,
    FAKE_PWCLI_DIALOG_DIR: dirs.dir,
    FAKE_PWCLI_VERSION: '1.39.0',
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
const CALL = rpc('tools/call', { name: 'get_price', arguments: { productId: 'a' } }, 2);

function run(args, runEnv, input = '') {
  const { cmd, args: cmdArgs } = mcpcatArgs(args);
  return new Promise((resolve) => {
    const started = Date.now();
    const child = execFile(
      cmd,
      cmdArgs,
      { encoding: 'utf8', timeout: 25_000, env: runEnv },
      (err, stdout, stderr) =>
        resolve({ status: err ? (err.code ?? 1) : 0, stdout, stderr, ms: Date.now() - started })
    );
    child.stdin.end(input);
  });
}

function serve(extra, runEnv, input = `${INIT}\n${CALL}\n`) {
  return run(['serve', '--webmcp', '--playwright-cli', fakePwCli, ...extra], runEnv, input);
}

function responses(stdout) {
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function fakeCdp(options) {
  const cdp = await startFakeCdp(options);
  cleanups.push(cdp.close);
  return cdp;
}

async function waitFor(check, ms = 10_000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('condition not met in time');
}

describe('serve --webmcp --webmcp-dialog', () => {
  it('dismiss answers a dialog a tool call opens and returns the tool result', async () => {
    const dirs = scratch();
    const r = await serve(
      ['--webmcp-dialog', 'dismiss', '--webmcp-polyfill', 'off'],
      env(dirs, { FAKE_PWCLI_CALL_DIALOG: 'confirm' })
    );
    assert.equal(r.status, 0, r.stderr);
    const [, call] = responses(r.stdout);
    assert.equal(call.error, undefined, JSON.stringify(call.error));
    assert.match(
      call.result.content[0].text,
      /result for get_price after the dialog was dismissed/
    );
    const log = readLog(dirs.log);
    const holds = log.filter((e) => e.command === 'dialog-hold');
    assert.equal(holds.length, 1);
    assert.equal(holds[0].tab, 'TAB1');
    const requests = log.filter((e) => e.command === 'dialog-hold-request');
    assert.equal(requests.length, 1);
    assert.deepEqual(Object.keys(requests[0].request).sort(), ['command', 'dialogId', 'id']);
    assert.equal(requests[0].request.command, 'dialog-dismiss');
    assert.match(r.stderr, /dismissed a JavaScript dialog on tab TAB1/);
  });

  it('accept answers with dialog-accept and no prompt text when consequential tools are allowed', async () => {
    const dirs = scratch();
    const cdp = await fakeCdp();
    const r = await serve(
      ['--webmcp-dialog', 'accept', '--allow-consequential', '--cdp', cdp.url],
      env(dirs, { FAKE_PWCLI_CALL_DIALOG: 'prompt' })
    );
    assert.equal(r.status, 0, r.stderr);
    const [, call] = responses(r.stdout);
    assert.match(call.result.content[0].text, /after the dialog was accepted/);
    const [request] = readLog(dirs.log).filter((e) => e.command === 'dialog-hold-request');
    assert.equal(request.request.command, 'dialog-accept');
    assert.equal('promptText' in request.request, false);
    const hold = readLog(dirs.log).find((e) => e.command === 'dialog-hold');
    assert.equal(hold.cdp, cdp.url);
  });

  it('refuses accept without --allow-consequential and an unknown mode', async () => {
    const dirs = scratch();
    const refused = await serve(['--webmcp-dialog', 'accept'], env(dirs));
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /--webmcp-dialog accept .*needs --allow-consequential/);
    assert.equal(refused.stdout, '');
    const bad = await serve(['--webmcp-dialog', 'always'], env(dirs));
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /--webmcp-dialog must be report, dismiss or accept, not always/);
    assert.equal(readLog(dirs.log).filter((e) => e.command === 'dialog-hold').length, 0);
  });

  it('restarts a holder that stopped and answers through the new one', async () => {
    const dirs = scratch();
    const { cmd, args } = mcpcatArgs([
      'serve',
      '--webmcp',
      '--http',
      '0',
      '--no-auth',
      '--webmcp-polyfill',
      'off',
      '--webmcp-dialog',
      'dismiss',
      '--playwright-cli',
      fakePwCli,
    ]);
    const child = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: env(dirs, { FAKE_PWCLI_CALL_DIALOG: 'confirm', FAKE_PWCLI_HOLD_EXIT_FIRST: '200' }),
    });
    cleanups.push(() => child.kill('SIGKILL'));
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    await waitFor(() => /listening on http:\/\/[^:]+:\d+\/mcp/.test(stderr));
    const port = Number(stderr.match(/listening on http:\/\/[^:]+:(\d+)\/mcp/)[1]);
    await waitFor(() => readLog(dirs.log).filter((e) => e.command === 'dialog-hold').length === 2);
    assert.match(stderr, /the dialog holder for tab TAB1 stopped \(playwright-cli dialog-hold: /);
    assert.match(stderr, /restarting in 1s/);
    const r = await run(
      ['call', `http://127.0.0.1:${port}/mcp`, 'get_price', '--productId', 'a'],
      env(dirs)
    );
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /after the dialog was dismissed/);
  });

  it('holds a tool call that arrives during the restart backoff until the new holder is ready', async () => {
    const dirs = scratch();
    const { cmd, args } = mcpcatArgs([
      'serve',
      '--webmcp',
      '--http',
      '0',
      '--no-auth',
      '--call-timeout',
      '6',
      '--webmcp-polyfill',
      'off',
      '--webmcp-dialog',
      'dismiss',
      '--playwright-cli',
      fakePwCli,
    ]);
    const child = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: env(dirs, { FAKE_PWCLI_CALL_DIALOG: 'confirm', FAKE_PWCLI_HOLD_EXIT_FIRST: '1500' }),
    });
    cleanups.push(() => child.kill('SIGKILL'));
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    await waitFor(() => /listening on http:\/\/[^:]+:\d+\/mcp/.test(stderr));
    const url = `http://127.0.0.1:${stderr.match(/listening on http:\/\/[^:]+:(\d+)\/mcp/)[1]}/mcp`;
    const post = async (body) => {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'mcp-protocol-version': '2025-11-25',
        },
        body,
      });
      const text = await res.text();
      const line = text.split('\n').find((l) => l.startsWith('data: '));
      return JSON.parse(line ? line.slice(6) : text);
    };
    await post(INIT);
    await waitFor(() => /restarting in 1s/.test(stderr), 10_000);
    assert.equal(readLog(dirs.log).filter((e) => e.command === 'dialog-hold').length, 1);
    const call = await post(CALL);
    assert.equal(call.error, undefined, JSON.stringify(call.error));
    assert.match(call.result.content[0].text, /after the dialog was dismissed/);
    const log = readLog(dirs.log);
    const holds = log.flatMap((e, i) => (e.command === 'dialog-hold' ? [i] : []));
    const started = log.findIndex((e) => e.command === 'webmcp-call');
    assert.ok(holds.length === 2 && holds[1] < started, JSON.stringify(log));
  });

  it('stops waiting for a holder that keeps failing and runs the call at once', async () => {
    const dirs = scratch();
    const r = await run(
      [
        'serve',
        '--webmcp',
        '--call-timeout',
        '30',
        '--webmcp-polyfill',
        'off',
        '--webmcp-dialog',
        'dismiss',
        '--playwright-cli',
        fakePwCli,
      ],
      env(dirs, { FAKE_PWCLI_HOLD_FAIL: '1' }),
      `${INIT}\n${CALL}\n`
    );
    assert.equal(r.status, 0, r.stderr);
    const [, call] = responses(r.stdout);
    assert.match(call.result.content[0].text, /result for get_price on/);
    assert.ok(r.ms < 8000, `took ${r.ms} ms`);
    assert.ok(readLog(dirs.log).filter((e) => e.command === 'dialog-hold').length >= 2);
  });

  it('keeps reporting a dialog that was open before the holder attached', async () => {
    const dirs = scratch();
    const cdp = await fakeCdp({ openDialog: 'confirm' });
    const r = await serve(
      ['--webmcp-dialog', 'dismiss', '--webmcp-polyfill', 'off', '--cdp', cdp.url],
      env(dirs)
    );
    assert.equal(r.status, 0, r.stderr);
    const [, call] = responses(r.stdout);
    assert.match(call.error.message, /^tab TAB1 is blocked by a JavaScript confirm dialog; answer/);
    assert.equal(readLog(dirs.log).filter((e) => e.command === 'dialog-hold-request').length, 0);
    assert.doesNotMatch(r.stdout + r.stderr, /Send it\?/);
  });

  it('reports a dialog the holder refuses instead of waiting for the timeout', async () => {
    const dirs = scratch();
    const r = await serve(
      ['--webmcp-dialog', 'dismiss', '--webmcp-polyfill', 'off'],
      env(dirs, { FAKE_PWCLI_CALL_DIALOG: 'confirm', FAKE_PWCLI_HOLD_REFUSE: '1' })
    );
    assert.equal(r.status, 0, r.stderr);
    const [, call] = responses(r.stdout);
    assert.match(
      call.error.message,
      /^tab TAB1 is blocked by a JavaScript dialog that mcpcat does not answer \(playwright-cli refuses/
    );
    assert.ok(r.ms < 15_000, `took ${r.ms} ms`);
  });

  it('report leaves dialog handling as it was and starts no holder', async () => {
    const dirs = scratch();
    const cdp = await fakeCdp();
    const r = await serve(
      ['--webmcp-dialog', 'report', '--cdp', cdp.url],
      env(dirs, { FAKE_PWCLI_HANG: '1', FAKE_PWCLI_DIALOG_URL: cdp.dialogUrl })
    );
    assert.equal(r.status, 0, r.stderr);
    const [, call] = responses(r.stdout);
    assert.match(call.error.message, /^tab TAB1 is blocked by a JavaScript confirm dialog; answer/);
    assert.equal(readLog(dirs.log).filter((e) => e.command === 'dialog-hold').length, 0);
  });

  it('falls back to report with one warning on playwright-cli older than 1.39.0', async () => {
    const dirs = scratch();
    const cdp = await fakeCdp();
    const r = await serve(
      ['--webmcp-dialog', 'dismiss', '--cdp', cdp.url],
      env(dirs, {
        FAKE_PWCLI_VERSION: '1.38.0',
        FAKE_PWCLI_HANG: '1',
        FAKE_PWCLI_DIALOG_URL: cdp.dialogUrl,
      })
    );
    assert.equal(r.status, 0, r.stderr);
    const warnings = r.stderr.match(
      /--webmcp-dialog dismiss needs playwright-cli 1\.39\.0 or newer \(found 1\.38\.0\); reporting JavaScript dialogs instead/g
    );
    assert.equal(warnings?.length, 1, r.stderr);
    const [, call] = responses(r.stdout);
    assert.match(call.error.message, /^tab TAB1 is blocked by a JavaScript confirm dialog; answer/);
    assert.equal(readLog(dirs.log).filter((e) => e.command === 'dialog-hold').length, 0);
  });
});
