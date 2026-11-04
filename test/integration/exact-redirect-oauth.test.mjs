import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { homeEnv, launch, run, scratchHome, startFixture } from './helpers/rows.mjs';

const AUTHORIZE = /(http:\/\/127\.0\.0\.1:\d+\/authorize\S+)/;

async function login(target, env) {
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
  assert.ok(location, `authorize answered ${authorized.status}: ${await authorized.text()}`);
  try {
    await fetch(location, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
  } catch {
    child.stdin.write(`${location}\n`);
  }
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  const r = await child.done;
  clearTimeout(timer);
  return { status: r.code, err: child.err, authorizeUrl: url };
}

describe('exact-match redirect_uri (ClickHouse-like AS)', () => {
  let as;
  let home;
  let env;
  let url;
  let store;

  before(async () => {
    as = await startFixture('exact-redirect-oauth-as.mjs');
    url = `${as.base}/mcp`;
    home = scratchHome('exact-redirect');
    env = {
      ...homeEnv(home),
      PATH: (process.env.PATH || '')
        .split(':')
        .filter((d) => !/jerk/.test(d))
        .join(':'),
    };
    store = join(home, '.pi/agent/mcp-auth.json');
    mkdirSync(join(home, '.pi/agent'), { recursive: true });
    writeFileSync(
      join(home, '.pi/agent/mcp.json'),
      JSON.stringify({ mcpServers: { ch: { url } } }, null, 2)
    );
  });

  after(() => as?.child.kill('SIGTERM'));

  it('registers and authorizes with the identical redirect_uri string', async () => {
    const r = await login('ch', env);
    assert.equal(r.status, 0, r.err);
    const log = await (await fetch(`${as.base}/log`)).json();
    assert.equal(log.clients.length, 1);
    const registered = log.clients[0].redirect_uris[0];
    const sent = new URL(r.authorizeUrl).searchParams.get('redirect_uri');
    assert.equal(registered, sent);
    assert.ok(!/:0(?:\/|$)/.test(registered), registered);
    assert.deepEqual(log.flags, []);
    assert.equal(run(['call', 'ch', 'whoami'], { env }).status, 0);
  });

  it('discards a cached client registered for another redirect_uri and re-registers', async () => {
    const before = JSON.parse(readFileSync(store, 'utf8'));
    const key = Object.keys(before)[0];
    assert.ok(key);
    before[key].clientInformation = {
      client_id: 'stale_client',
      redirect_uris: ['http://127.0.0.1:65534/old-callback'],
      token_endpoint_auth_method: 'none',
    };
    delete before[key].tokens;
    delete before[key].tokensExpireAt;
    writeFileSync(store, `${JSON.stringify(before, null, 2)}\n`);

    const r = await login('ch', env);
    assert.equal(r.status, 0, r.err);
    const log = await (await fetch(`${as.base}/log`)).json();
    const last = log.clients.at(-1);
    assert.notEqual(last.client_id, 'stale_client');
    const sent = new URL(r.authorizeUrl).searchParams.get('redirect_uri');
    assert.equal(last.redirect_uris[0], sent);
    assert.ok(!log.flags.some((f) => f.authorize === 'invalid_redirect_uri'));
  });

  it('logout drops the cached client', () => {
    assert.ok(existsSync(store));
    assert.match(readFileSync(store, 'utf8'), /client_id/);
    const r = run(['logout', 'ch'], { env });
    assert.equal(r.status, 0, r.stderr);
    const body = readFileSync(store, 'utf8').trim();
    assert.equal(body, '{}');
  });
});

describe('exact-match redirect_uri with jerk create + PI_MCP_CONFIG callbackPort', () => {
  let as;
  let home;
  let env;
  let url;
  let binDir;
  let mcpPath;
  let originalMcp;

  before(async () => {
    as = await startFixture('exact-redirect-oauth-as.mjs');
    url = `${as.base}/mcp`;
    home = scratchHome('exact-jerk');
    binDir = join(home, 'bin');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(home, '.pi/agent'), { recursive: true });
    mcpPath = join(home, '.pi/agent/mcp.json');
    originalMcp = `${JSON.stringify({ mcpServers: { ch: { url } } }, null, 2)}\n`;
    writeFileSync(mcpPath, originalMcp);
    const logPath = join(home, 'jerk.log');
    writeFileSync(
      join(binDir, 'jerk'),
      `#!/bin/sh
echo "ARGV: $@" >> "${logPath}"
echo "PI_MCP_CONFIG=\${PI_MCP_CONFIG-}" >> "${logPath}"
case "$1" in
  --version) echo "jerk 0.19.0"; exit 0 ;;
  list) echo '[{"provider":"mcp:ch","source":"mcp.json"}]'; exit 0 ;;
esac
case "$2" in
  create)
    cfg="\${PI_MCP_CONFIG:?missing PI_MCP_CONFIG}"
    test "$cfg" != "$HOME/.pi/agent/mcp.json" || exit 3
    port=$(node -e "const j=require(process.argv[1]); const o=j.mcpServers.ch.oauth||{}; if(!o.callbackPort) process.exit(2); console.log(o.callbackPort)" "$cfg") || exit 2
    node -e '
      const fs=require("fs");
      const port=process.argv[1];
      const base=process.argv[2];
      const redirect="http://127.0.0.1:"+port+"/callback";
      fetch(base+"/register",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({client_name:"mcpcat",redirect_uris:[redirect],token_endpoint_auth_method:"none",application_type:"native"})}).then(async r=>{
        const j=await r.json();
        if(!r.ok){ console.error(JSON.stringify(j)); process.exit(1); }
        const u=new URL(base+"/authorize");
        u.searchParams.set("response_type","code");
        u.searchParams.set("client_id",j.client_id);
        u.searchParams.set("redirect_uri",redirect);
        u.searchParams.set("code_challenge","AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
        u.searchParams.set("code_challenge_method","S256");
        u.searchParams.set("state","0123456789abcdef0123456789abcdef");
        u.searchParams.set("resource",base+"/mcp");
        const a=await fetch(u,{redirect:"manual"});
        const text=await a.text();
        if(a.status!==302){ console.error(text); process.exit(1); }
        process.exit(0);
      });
    ' "$port" "${as.base}"
    exit $?
    ;;
  drop) exit 0 ;;
  get) echo '{"token":"t","expires_at":9999999999}'; exit 0 ;;
  import-pi) exit 0 ;;
esac
exit 2
`,
      { mode: 0o755 }
    );
    env = {
      ...homeEnv(home),
      PATH: `${binDir}:${process.env.PATH}`,
    };
  });

  after(() => as?.child.kill('SIGTERM'));

  it('passes a nonzero callbackPort via PI_MCP_CONFIG so jerk DCR matches authorize', async () => {
    const r = run(['login', 'ch', '--no-browser'], { env });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    const log = await (await fetch(`${as.base}/log`)).json();
    assert.ok(log.clients.length >= 1);
    const registered = log.clients[0].redirect_uris[0];
    assert.ok(!/:0(?:\/|$)/.test(registered), registered);
    assert.ok(!log.flags.some((f) => f === 'port-zero' || f.register === 'port-zero'));
    assert.ok(!log.flags.some((f) => f.authorize === 'invalid_redirect_uri'));
    assert.equal(readFileSync(mcpPath, 'utf8'), originalMcp);
  });
});

describe('exact-match redirect_uri scenarios that fail on base oauth', () => {
  let as;
  let home;
  let env;
  let url;
  let store;

  before(async () => {
    as = await startFixture('exact-redirect-oauth-as.mjs');
    url = `${as.base}/mcp`;
    home = scratchHome('exact-base-fail');
    env = {
      ...homeEnv(home),
      PATH: (process.env.PATH || '')
        .split(':')
        .filter((d) => !/jerk/.test(d))
        .join(':'),
    };
    store = join(home, '.pi/agent/mcp-auth.json');
    mkdirSync(join(home, '.pi/agent'), { recursive: true });
    writeFileSync(
      join(home, '.pi/agent/mcp.json'),
      JSON.stringify({ mcpServers: { ch: { url, oauth: { clientRegistration: 'dcr' } } } }, null, 2)
    );
  });

  after(() => as?.child.kill('SIGTERM'));

  it('seeds auth state with a successful login', async () => {
    const r = await login('ch', env);
    assert.equal(r.status, 0, r.err);
    assert.ok(existsSync(store));
  });

  it('falls back when the preferred registered port is occupied', async () => {
    const before = JSON.parse(readFileSync(store, 'utf8'));
    const key = Object.keys(before)[0];
    assert.ok(key);
    const { createServer } = await import('node:net');
    const holder = createServer();
    await new Promise((resolve) => holder.listen(0, '127.0.0.1', resolve));
    const occupied = holder.address().port;
    before[key].clientInformation = {
      client_id: 'occupied_port_client',
      redirect_uris: [`http://127.0.0.1:${occupied}/callback`],
      token_endpoint_auth_method: 'none',
    };
    delete before[key].tokens;
    delete before[key].tokensExpireAt;
    writeFileSync(store, `${JSON.stringify(before, null, 2)}\n`);

    try {
      const r = await login('ch', env);
      assert.equal(r.status, 0, r.err);
      const sent = new URL(r.authorizeUrl).searchParams.get('redirect_uri');
      assert.ok(sent);
      assert.notEqual(sent, `http://127.0.0.1:${occupied}/callback`);
      assert.ok(!/:0(?:\/|$)/.test(sent), sent);
      const log = await (await fetch(`${as.base}/log`)).json();
      assert.ok(!log.flags.some((f) => f.authorize === 'invalid_redirect_uri'));
    } finally {
      await new Promise((resolve) => holder.close(resolve));
    }
  });

  it('re-registers when a cached DCR client has no redirect_uris', async () => {
    const before = JSON.parse(readFileSync(store, 'utf8'));
    const key = Object.keys(before)[0];
    assert.ok(key);
    before[key].clientInformation = {
      client_id: 'no_redirect_metadata',
      token_endpoint_auth_method: 'none',
    };
    delete before[key].tokens;
    delete before[key].tokensExpireAt;
    writeFileSync(store, `${JSON.stringify(before, null, 2)}\n`);

    const r = await login('ch', env);
    assert.equal(r.status, 0, r.err);
    const after = JSON.parse(readFileSync(store, 'utf8'));
    assert.notEqual(after[key].clientInformation.client_id, 'no_redirect_metadata');
    const registered = after[key].clientInformation.redirect_uris ?? [];
    assert.ok(registered.length > 0);
    assert.ok(!/:0(?:\/|$)/.test(registered[0]));
  });

  it('re-registers a stale client whose redirect_uri was registered as port zero', async () => {
    const before = JSON.parse(readFileSync(store, 'utf8'));
    const key = Object.keys(before)[0];
    assert.ok(key);
    before[key].clientInformation = {
      client_id: 'port_zero_client',
      redirect_uris: ['http://127.0.0.1:0/callback'],
      token_endpoint_auth_method: 'none',
    };
    delete before[key].tokens;
    delete before[key].tokensExpireAt;
    writeFileSync(store, `${JSON.stringify(before, null, 2)}\n`);

    const r = await login('ch', env);
    assert.equal(r.status, 0, r.err);
    const sent = new URL(r.authorizeUrl).searchParams.get('redirect_uri');
    assert.ok(sent);
    assert.ok(!/:0(?:\/|$)/.test(sent), sent);
    const after = JSON.parse(readFileSync(store, 'utf8'));
    assert.notEqual(after[key].clientInformation.client_id, 'port_zero_client');
    const log = await (await fetch(`${as.base}/log`)).json();
    assert.ok(!log.flags.some((f) => f === 'port-zero' || f.register === 'port-zero'));
  });
});
