import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const hostBin = join(here, '../../dist/host/mcpcat.mjs');
const MARKER = 'JERK_URL_TOKEN_v7Xq_DO_NOT_EXPOSE';

function fakeJerk(version, log, signedIn) {
  return `#!/bin/sh
echo "ARGV: $@" >> "${log}"
case "$1" in
  --version) echo "jerk ${version}"; exit 0 ;;
  list) echo '[{"provider":"github","source":"built-in"},{"provider":"mcp:named","source":"mcp.json"}]'; exit 0 ;;
  mcp:named)
    case "$2" in
      get) echo '{"token":"${MARKER}","expires_at":1800000000}'; exit 0 ;;
      create) exit 0 ;;
      drop) exit 0 ;;
    esac ;;
  mcp:url:*)
    url="\${1#mcp:url:}"
    case "$url" in
      *\\?*) echo "jerk: mcp:url: the URL must not have a query" >&2; exit 2 ;;
      *@*) echo "jerk: mcp:url: the URL must not contain userinfo" >&2; exit 2 ;;
      http://127.0.0.1*|https://*) ;;
      *) echo "jerk: mcp:url: the URL must use https, or http on loopback" >&2; exit 2 ;;
    esac
    case "$2" in
      get)
        if [ -f "${signedIn}" ]; then echo '{"token":"${MARKER}","expires_at":1800000000}'; exit 0; fi
        echo "jerk: $1: not signed in; run jerk $1 create" >&2; exit 3 ;;
      create) touch "${signedIn}"; exit 0 ;;
      drop) rm -f "${signedIn}"; exit 0 ;;
    esac ;;
esac
echo "jerk: unknown provider $1; jerk list shows the configured ones" >&2
exit 2
`;
}

async function startServer() {
  const child = spawn(
    process.execPath,
    [join(here, 'fixtures', 'server-2026-oauth-protected.mjs'), 'http://127.0.0.1:9'],
    { stdio: ['ignore', 'pipe', 'inherit'] }
  );
  const info = await new Promise((resolve, reject) => {
    child.stdout.once('data', (c) => resolve(JSON.parse(String(c).split('\n')[0])));
    child.once('exit', (code) => reject(new Error(`server exited ${code}`)));
  });
  return { child, ...info };
}

function harness(version) {
  const h = {};
  h.setup = async () => {
    h.tmp = mkdtempSync(join(tmpdir(), 'mcpcat-jerk-url-ids-'));
    const binDir = join(h.tmp, 'bin');
    h.log = join(h.tmp, 'jerk.log');
    h.signedIn = join(h.tmp, 'signed-in');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'jerk'), fakeJerk(version, h.log, h.signedIn), { mode: 0o755 });
    h.mcp = await startServer();
    h.url = `http://127.0.0.1:${h.mcp.port}/mcp`;
    mkdirSync(join(h.tmp, '.pi', 'agent'), { recursive: true });
    writeFileSync(
      join(h.tmp, '.pi', 'agent', 'mcp.json'),
      JSON.stringify({ mcpServers: { named: { url: h.url } } })
    );
    await fetch(`http://127.0.0.1:${h.mcp.port}/_control/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ add: MARKER }),
    });
    h.env = {
      ...process.env,
      PATH: `${binDir}${delimiter}${process.env.PATH}`,
      HOME: h.tmp,
      NODE_NO_WARNINGS: '1',
    };
  };
  h.teardown = () => {
    h.mcp?.child.kill('SIGTERM');
    rmSync(h.tmp, { recursive: true, force: true });
  };
  h.run = (args) => {
    rmSync(h.log, { force: true });
    try {
      const stdout = execFileSync(process.execPath, [hostBin, ...args], {
        encoding: 'utf8',
        timeout: 15_000,
        env: h.env,
        input: '',
      });
      return { status: 0, stdout, stderr: '' };
    } catch (err) {
      return { status: err.status, stdout: err.stdout ?? '', stderr: err.stderr ?? '' };
    }
  };
  h.calls = () => (existsSync(h.log) ? readFileSync(h.log, 'utf8') : '');
  return h;
}

describe('jerk 0.19.0: URL-only targets use mcp:url ids', () => {
  const h = harness('0.19.0');
  before(h.setup);
  after(h.teardown);

  it('call on an unsigned URL asks jerk and exits 4 naming mcpcat login', () => {
    const r = h.run(['call', h.url, 'echo', '-d', '{"text":"hi"}']);
    assert.equal(r.status, 4, r.stderr);
    assert.match(r.stderr, /mcpcat login/);
    assert.match(h.calls(), new RegExp(`ARGV: mcp:url:${h.url} get --reveal --json`));
  });

  it('login, call and logout on a URL go through jerk, never pi store', () => {
    const login = h.run(['login', h.url]);
    assert.equal(login.status, 0, login.stderr);
    assert.match(h.calls(), new RegExp(`ARGV: mcp:url:${h.url} create`));
    const call = h.run(['call', h.url, 'echo', '-d', '{"text":"via-jerk-url"}']);
    assert.equal(call.status, 0, call.stderr);
    assert.match(call.stdout, /via-jerk-url/);
    assert.ok(!call.stdout.includes(MARKER) && !call.stderr.includes(MARKER), 'token leaked');
    const logout = h.run(['logout', h.url]);
    assert.equal(logout.status, 0, logout.stderr);
    assert.match(logout.stdout, /Signed out/);
    assert.match(h.calls(), new RegExp(`ARGV: mcp:url:${h.url} drop --yes`));
    assert.ok(!existsSync(join(h.tmp, '.pi', 'agent', 'mcp-auth.json')), 'pi store written');
  });

  it('the id uses the canonical URL, which matches the url: key', () => {
    for (const [raw, canonical] of [
      ['HTTPS://Example.com:443', 'https://example.com/'],
      ['https://MCP.Example.com/a/B/', 'https://mcp.example.com/a/B/'],
      ['Example.com/mcp', 'https://example.com/mcp'],
      [`HTTP://127.0.0.1:${h.mcp.port}`, `http://127.0.0.1:${h.mcp.port}/`],
    ]) {
      const r = h.run(['logout', raw]);
      assert.equal(r.status, 0, r.stderr);
      assert.match(h.calls(), new RegExp(`ARGV: mcp:url:${canonical.replaceAll('.', '\\.')} drop`));
    }
  });

  it('a URL jerk refuses exits 2 with jerk message', () => {
    const q = `${h.url}?k=hunter2`;
    for (const args of [
      ['call', q, 'echo', '-d', '{"text":"hi"}'],
      ['login', q],
      ['logout', q],
    ]) {
      const r = h.run(args);
      assert.equal(r.status, 2, `${args[0]}: ${r.stderr}`);
      assert.match(r.stderr, /mcp:url: the URL must not have a query/);
    }
    const plain = h.run(['logout', 'http://example.com/mcp']);
    assert.equal(plain.status, 2, plain.stderr);
    assert.match(plain.stderr, /https, or http on loopback/);
  });

  it('a configured name still goes through mcp:<name>', () => {
    const r = h.run(['call', 'named', 'echo', '-d', '{"text":"via-named"}']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /via-named/);
    assert.match(h.calls(), /ARGV: mcp:named get --reveal --json/);
    assert.doesNotMatch(h.calls(), /mcp:url:/);
    const login = h.run(['login', 'named']);
    assert.equal(login.status, 0, login.stderr);
    assert.match(h.calls(), /ARGV: mcp:named create/);
  });
});

describe('jerk 0.18.9: URL-only targets stay on pi store', () => {
  const h = harness('0.18.9');
  before(h.setup);
  after(h.teardown);

  it('call and logout on a URL never ask jerk for mcp:url', () => {
    const call = h.run(['call', h.url, 'echo', '-d', '{"text":"hi"}']);
    assert.equal(call.status, 4, call.stderr);
    assert.match(call.stderr, /mcpcat login/);
    assert.doesNotMatch(h.calls(), /mcp:url:/);
    const logout = h.run(['logout', h.url]);
    assert.equal(logout.status, 0, logout.stderr);
    assert.match(logout.stdout, /No credentials stored/);
    assert.doesNotMatch(h.calls(), /mcp:url:/);
  });
});
