import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { homeEnv, launch, run, scratchHome, startFixture } from './helpers/rows.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const hostBin = join(here, '../../dist/host/mcpcat.mjs');
const AUTHORIZE = /(http:\/\/127\.0\.0\.1:\d+\/authorize\S+)/;
const MARKER = 'JERK_FRESH_k9mP_DO_NOT_EXPOSE';

async function startServer(script, args = []) {
  const child = spawn(process.execPath, [join(here, 'fixtures', script), ...args], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const info = await new Promise((resolve, reject) => {
    child.stdout.once('data', (c) => resolve(JSON.parse(String(c).split('\n')[0])));
    child.once('exit', (code) => reject(new Error(`${script} exited ${code}`)));
  });
  return { child, ...info };
}

async function ownLogin(target, env) {
  const child = launch(['login', target, '--no-browser'], { env });
  const url = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), 15_000);
    const check = () => {
      const m = (child.err + child.out).match(AUTHORIZE);
      if (m) {
        clearTimeout(timer);
        resolve(m[1]);
      }
    };
    child.stderr.on('data', check);
    child.stdout.on('data', check);
    child.on('exit', () => setTimeout(() => resolve(undefined), 100));
  });
  if (!url) {
    const r = await child.done;
    return { status: r.code, err: child.err, out: child.out };
  }
  const authorized = await fetch(url, { redirect: 'manual' });
  const location = authorized.headers.get('location');
  assert.ok(location, `authorize answered ${authorized.status}`);
  try {
    await fetch(location, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
  } catch {
    child.stdin.write(`${location}\n`);
  }
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  const r = await child.done;
  clearTimeout(timer);
  return { status: r.code, err: child.err, out: child.out };
}

describe('successful jerk login beats a stale pi entry', () => {
  let tmp;
  let binDir;
  let log;
  let as;
  let mcp;
  let url;
  let store;

  function env() {
    return { PATH: `${binDir}${delimiter}${process.env.PATH}`, HOME: tmp, NODE_NO_WARNINGS: '1' };
  }

  function runHost(args) {
    try {
      const stdout = execFileSync(process.execPath, [hostBin, ...args], {
        encoding: 'utf8',
        timeout: 15_000,
        env: { ...process.env, ...env() },
        input: '',
      });
      return { status: 0, stdout, stderr: '' };
    } catch (err) {
      return { status: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
    }
  }

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'mcpcat-jerk-stale-pi-'));
    binDir = join(tmp, 'bin');
    log = join(tmp, 'jerk.log');
    store = join(tmp, '.pi', 'agent', 'mcp-auth.json');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, 'jerk'),
      `#!/bin/sh
echo "ARGV: $@" >> "${log}"
case "$1" in
  --version) echo "jerk 1.4.1"; exit 0 ;;
  list) echo '[{"provider":"mcp:named","source":"mcp.json"}]'; exit 0 ;;
  mcp:named)
    case "$2" in
      get) echo '{"token":"${MARKER}","expires_at":1800000000}'; exit 0 ;;
      create) echo "signed in" >&2; exit 0 ;;
      drop) exit 0 ;;
    esac ;;
esac
exit 2
`,
      { mode: 0o755 }
    );
    as = await startServer('oauth-as.mjs');
    mcp = await startServer('server-2026-oauth-protected.mjs', [as.issuer]);
    url = `http://127.0.0.1:${mcp.port}/mcp`;
    mkdirSync(join(tmp, '.pi', 'agent'), { recursive: true });
    writeFileSync(
      join(tmp, '.pi', 'agent', 'mcp.json'),
      JSON.stringify({ mcpServers: { named: { url } } })
    );
  });

  after(() => {
    as?.child.kill('SIGTERM');
    mcp?.child.kill('SIGTERM');
    rmSync(tmp, { recursive: true, force: true });
  });

  it('login via jerk clears pi and call uses the jerk token', async () => {
    writeFileSync(
      store,
      JSON.stringify({
        [`mcp__named|${url}`]: { tokens: { access_token: 'STALE_PI', token_type: 'bearer' } },
        [url]: { tokens: { access_token: 'STALE_LEGACY', token_type: 'bearer' } },
      })
    );
    await fetch(`http://127.0.0.1:${mcp.port}/_control/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ add: MARKER }),
    });
    rmSync(log, { force: true });
    const login = runHost(['login', 'named', '--no-browser']);
    assert.equal(login.status, 0, login.stderr + login.stdout);
    assert.match(readFileSync(log, 'utf8'), / create/);
    const body = readFileSync(store, 'utf8').trim();
    assert.equal(body === '' || body === '{}', true, body);
    rmSync(log, { force: true });
    const call = runHost(['call', 'named', 'echo', '-d', '{"text":"after-jerk-login"}']);
    assert.equal(call.status, 0, call.stderr);
    assert.match(call.stdout, /after-jerk-login/);
    assert.match(readFileSync(log, 'utf8'), /mcp:named get/);
    assert.ok(!call.stdout.includes(MARKER) && !call.stderr.includes(MARKER), 'token leaked');
  });
});

describe('own-sign-in fallback still wins over an old jerk on PATH', () => {
  let as;
  let home;
  let env;
  let url;
  let store;
  let logPath;

  before(async () => {
    as = await startFixture('exact-redirect-oauth-as.mjs');
    url = `${as.base}/mcp`;
    home = scratchHome('jerk-stale-fallback');
    const binDir = join(home, 'bin');
    mkdirSync(binDir, { recursive: true });
    store = join(home, '.pi/agent/mcp-auth.json');
    logPath = join(home, 'jerk.log');
    writeFileSync(
      join(home, '.pi/agent/mcp.json'),
      JSON.stringify({ mcpServers: { ch: { url } } }, null, 2)
    );
    writeFileSync(
      join(binDir, 'jerk'),
      `#!/bin/sh
echo "ARGV: $@" >> "${logPath}"
case "$1" in
  --version) echo "jerk 1.4.0"; exit 0 ;;
  list) echo '[{"provider":"mcp:ch","source":"mcp.json"}]'; exit 0 ;;
esac
case "$2" in
  create) echo CREATE_OLD >> "${logPath}"; sleep 60; exit 0 ;;
  get) echo '{"token":"OLD_JERK","expires_at":9999999999}'; exit 0 ;;
esac
exit 2
`,
      { mode: 0o755 }
    );
    env = { ...homeEnv(home), PATH: `${binDir}:${process.env.PATH}` };
  });

  after(() => as?.child.kill('SIGTERM'));

  it('info and call succeed from pi while old jerk remains listed', async () => {
    const r = await ownLogin('ch', env);
    assert.equal(r.status, 0, r.err);
    assert.match(r.err, /older than 1\.4\.1/);
    assert.ok(existsSync(store));
    assert.match(readFileSync(store, 'utf8'), /access_token|client_id/);
    const info = run(['info', 'ch'], { env });
    assert.equal(info.status, 0, info.stderr);
    const call = run(['call', 'ch', 'whoami'], { env });
    assert.equal(call.status, 0, call.stderr);
  });
});
