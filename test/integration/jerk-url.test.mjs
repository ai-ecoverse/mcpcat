import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { waitForAuthorizeUrl } from './helpers/authorize.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const hostBin = join(here, '../../dist/host/mcpcat.mjs');

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

describe('jerk without mcp:url ids: URL-only targets use pi store', () => {
  let tmp;
  let binDir;
  let log;
  let as;
  let mcp;
  let url;
  const MARKER = 'JERK_TOKEN_k3Qz_DO_NOT_EXPOSE';

  function env() {
    return { PATH: `${binDir}${delimiter}${process.env.PATH}`, HOME: tmp, NODE_NO_WARNINGS: '1' };
  }

  function run(args) {
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

  function jerkCalls() {
    return existsSync(log) ? readFileSync(log, 'utf8') : '';
  }

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'mcpcat-jerk-url-'));
    binDir = join(tmp, 'bin');
    log = join(tmp, 'jerk.log');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, 'jerk'),
      `#!/bin/sh
echo "ARGV: $@" >> "${log}"
case "$1" in
  --version) echo "jerk 0.15.2"; exit 0 ;;
  list) echo '[{"provider":"github","source":"built-in"},{"provider":"mcp:named","source":"mcp.json"}]'; exit 0 ;;
  mcp:named)
    case "$2" in
      get) echo '{"token":"${MARKER}","expires_at":1800000000}'; exit 0 ;;
      create) echo "signed in" >&2; exit 0 ;;
    esac ;;
esac
echo "jerk: unknown provider $1; jerk list shows the configured ones" >&2
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
      JSON.stringify({ mcpServers: { named: { url }, other: { url } } })
    );
  });

  after(() => {
    as?.child.kill('SIGTERM');
    mcp?.child.kill('SIGTERM');
    rmSync(tmp, { recursive: true, force: true });
  });

  it('call on an unsigned URL exits 4 naming mcpcat login, never asking jerk for mcp:url', () => {
    rmSync(log, { force: true });
    const r = run(['call', url, 'echo', '-d', '{"text":"hi"}']);
    assert.equal(r.status, 4, r.stderr);
    assert.match(r.stderr, /mcpcat login/);
    assert.doesNotMatch(r.stderr, /unknown provider/);
    assert.doesNotMatch(jerkCalls(), /mcp:url:/);
  });

  it('login on a URL signs in through pi store and call then succeeds', async () => {
    rmSync(log, { force: true });
    const proc = spawn(process.execPath, [hostBin, 'login', url, '--no-browser'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env() },
    });
    let stderr = '';
    proc.stderr.on('data', (c) => {
      stderr += c;
    });
    const authorizeUrl = await waitForAuthorizeUrl(proc, () => stderr);
    const res = await fetch(authorizeUrl, { redirect: 'manual' });
    proc.stdin.end(`${res.headers.get('location')}\n`);
    const code = await new Promise((r) => proc.on('close', r));
    assert.equal(code, 0, stderr);
    const store = JSON.parse(readFileSync(join(tmp, '.pi', 'agent', 'mcp-auth.json'), 'utf8'));
    const entry = Object.values(store)[0];
    assert.ok(entry.tokens?.access_token, 'pi store holds the token');
    await fetch(`http://127.0.0.1:${mcp.port}/_control/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ add: entry.tokens.access_token }),
    });
    const r = run(['call', url, 'echo', '-d', '{"text":"via-pi"}']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /via-pi/);
    assert.doesNotMatch(jerkCalls(), /mcp:url:/);
  });

  it('logout on a URL uses pi store', () => {
    rmSync(log, { force: true });
    const r = run(['logout', url]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /Signed out/);
    assert.doesNotMatch(jerkCalls(), /mcp:url:/);
  });

  it('a configured name jerk lists still goes through jerk', async () => {
    rmSync(log, { force: true });
    await fetch(`http://127.0.0.1:${mcp.port}/_control/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ add: MARKER }),
    });
    const r = run(['call', 'named', 'echo', '-d', '{"text":"via-jerk"}']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /via-jerk/);
    assert.ok(!r.stdout.includes(MARKER) && !r.stderr.includes(MARKER), 'token leaked');
    assert.match(jerkCalls(), /ARGV: mcp:named get --reveal --json/);
    const login = run(['login', 'named']);
    assert.equal(login.status, 0, login.stderr);
    assert.match(jerkCalls(), /ARGV: mcp:named create/);
  });

  it('a configured name jerk does not list uses pi store', () => {
    rmSync(log, { force: true });
    const r = run(['logout', 'other']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /No credentials stored/);
    assert.doesNotMatch(jerkCalls(), /mcp:other/);
  });
});
