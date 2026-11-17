import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, afterEach, before, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import {
  fixtures,
  homeEnv,
  run,
  scratchHome,
  launch as spawnMcpcat,
  startFixture,
} from './helpers/rows.mjs';

const WEB = 'https://www.sliccy.ai/oauth/mcp-callback';
const CLIENT = 'web_client';
const AUTHORIZE = /(http:\/\/127\.0\.0\.1:\d+\/authorize\S+)/;
const PROBE = `--import=${pathToFileURL(join(fixtures, 'listen-probe-preload.mjs')).href}`;

const live = new Set();

afterEach(() => {
  for (const child of live) child.kill('SIGKILL');
  live.clear();
});

function launch(args, options) {
  const child = spawnMcpcat(args, options);
  live.add(child);
  child.on('exit', () => live.delete(child));
  return child;
}

function waitFor(child, pattern) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), 15_000);
    const check = () => {
      const m = (child.err + child.out).match(pattern);
      if (m) {
        clearTimeout(timer);
        resolve(m);
      }
    };
    check();
    child.stderr.on('data', check);
    child.stdout.on('data', check);
    child.on('exit', () => setTimeout(() => resolve(undefined), 100));
  });
}

async function finish(child) {
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  const r = await child.done;
  clearTimeout(timer);
  return { status: r.code, err: child.err, out: child.out };
}

async function authorize(url) {
  const res = await fetch(url, { redirect: 'manual' });
  const location = res.headers.get('location');
  assert.ok(location, `authorize answered ${res.status}: ${await res.text()}`);
  return location;
}

function listens(env) {
  const log = env.LISTEN_PROBE_LOG;
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function setup(tag, oauth, extra = {}, asEnv = {}) {
  const as = await startFixture('exact-redirect-oauth-as.mjs', {
    PRECLIENTS: JSON.stringify([{ client_id: CLIENT, redirect_uris: [WEB] }]),
    ...asEnv,
  });
  const home = scratchHome(tag);
  const binDir = join(home, 'bin');
  mkdirSync(binDir, { recursive: true });
  const jerkLog = join(home, 'jerk.log');
  writeFileSync(
    join(binDir, 'jerk'),
    `#!/bin/sh
echo "$@" >> "${jerkLog}"
case "$1" in
  --version) echo "jerk 1.4.1"; exit 0 ;;
  list) echo '[{"provider":"mcp:svc","source":"mcp.json"}]'; exit 0 ;;
esac
exit 2
`,
    { mode: 0o755 }
  );
  const env = {
    ...homeEnv(home),
    PATH: `${binDir}:${process.env.PATH}`,
    NODE_OPTIONS: PROBE,
    LISTEN_PROBE_LOG: join(home, 'listen.log'),
    ...extra,
  };
  writeFileSync(
    join(home, '.pi/agent/mcp.json'),
    JSON.stringify({ mcpServers: { svc: { url: `${as.base}/mcp`, oauth } } }, null, 2)
  );
  return { as, home, env, jerkLog };
}

describe('web callbackUrl (non-loopback, no port)', () => {
  let ctx;

  before(async () => {
    ctx = await setup('web-callback', { clientId: CLIENT, callbackUrl: WEB });
  });

  after(() => ctx?.as.child.kill('SIGTERM'));

  it('sends the callbackUrl verbatim, binds nothing, and accepts the pasted URL', async () => {
    const child = launch(['login', 'svc', '--no-browser'], { env: ctx.env });
    const m = await waitFor(child, AUTHORIZE);
    assert.ok(m, child.err + child.out);
    const authUrl = new URL(m[1]);
    assert.equal(authUrl.searchParams.get('redirect_uri'), WEB);
    assert.equal(authUrl.searchParams.get('client_id'), CLIENT);
    assert.ok(await waitFor(child, /Paste the full URL of that page/), child.err);
    assert.match(child.err, new RegExp(`lands on a page at ${WEB}`));
    const location = await authorize(m[1]);
    assert.ok(location.startsWith(`${WEB}?`), location);
    child.stdin.write(`${location}\n`);
    const r = await finish(child);
    assert.equal(r.status, 0, r.err);
    assert.match(r.out, /Signed in to svc/);
    assert.match(r.err, /callbackUrl is a web redirect; using own sign-in/);
    assert.deepEqual(listens(ctx.env), []);
    const jerkCalls = existsSync(ctx.jerkLog) ? readFileSync(ctx.jerkLog, 'utf8') : '';
    assert.doesNotMatch(jerkCalls, /create/);
    const log = await (await fetch(`${ctx.as.base}/log`)).json();
    assert.deepEqual(log.flags, []);
    assert.equal(log.clients.length, 1);
    const called = run(['call', 'svc', 'whoami'], { env: ctx.env });
    assert.equal(called.status, 0, called.stderr);
    assert.match(called.stdout, new RegExp(`user:${CLIENT}`));
  });

  it('prompts for the pasted URL without --no-browser too', async () => {
    const child = launch(['login', 'svc'], { env: ctx.env });
    const m = await waitFor(child, AUTHORIZE);
    assert.ok(m, child.err + child.out);
    assert.equal(new URL(m[1]).searchParams.get('redirect_uri'), WEB);
    assert.ok(await waitFor(child, /Paste the full URL of that page/), child.err);
    child.stdin.write(`${await authorize(m[1])}\n`);
    const r = await finish(child);
    assert.equal(r.status, 0, r.err);
    assert.deepEqual(listens(ctx.env), []);
  });

  it('rejects a pasted URL whose state does not match', async () => {
    const child = launch(['login', 'svc', '--no-browser'], { env: ctx.env });
    const m = await waitFor(child, AUTHORIZE);
    assert.ok(m, child.err + child.out);
    const pasted = new URL(await authorize(m[1]));
    pasted.searchParams.set('state', 'not-this-sign-in');
    child.stdin.write(`${pasted.href}\n`);
    const r = await finish(child);
    assert.equal(r.status, 4, r.err);
    assert.match(r.err, /belongs to a different sign-in/);
    const log = await (await fetch(`${ctx.as.base}/log`)).json();
    assert.deepEqual(log.flags, []);
  });

  it('rejects a pasted URL on another redirect URI', async () => {
    const child = launch(['login', 'svc', '--no-browser'], { env: ctx.env });
    const m = await waitFor(child, AUTHORIZE);
    assert.ok(m, child.err + child.out);
    const pasted = new URL(await authorize(m[1]));
    pasted.pathname = '/elsewhere';
    child.stdin.write(`${pasted.href}\n`);
    const r = await finish(child);
    assert.equal(r.status, 4, r.err);
    assert.match(r.err, /does not match this sign-in's redirect URI/);
  });

  it('cancels on an empty paste', async () => {
    const child = launch(['login', 'svc', '--no-browser'], { env: ctx.env });
    assert.ok(await waitFor(child, AUTHORIZE), child.err + child.out);
    child.stdin.end('\n');
    const r = await finish(child);
    assert.equal(r.status, 1, r.err);
    assert.match(r.err, /sign-in cancelled/);
  });
});

describe('web callbackUrl with DCR', () => {
  let ctx;

  before(async () => {
    ctx = await setup('web-callback-dcr', { callbackUrl: WEB });
  });

  after(() => ctx?.as.child.kill('SIGTERM'));

  it('registers the verbatim callbackUrl', async () => {
    const child = launch(['login', 'svc', '--no-browser'], { env: ctx.env });
    const m = await waitFor(child, AUTHORIZE);
    assert.ok(m, child.err + child.out);
    assert.equal(new URL(m[1]).searchParams.get('redirect_uri'), WEB);
    child.stdin.write(`${await authorize(m[1])}\n`);
    const r = await finish(child);
    assert.equal(r.status, 0, r.err);
    const log = await (await fetch(`${ctx.as.base}/log`)).json();
    assert.deepEqual(log.clients.at(-1).redirect_uris, [WEB]);
    assert.deepEqual(listens(ctx.env), []);
  });
});

describe('web callbackUrl with a CIMD-capable server', () => {
  let auto;
  let cimd;

  before(async () => {
    auto = await setup('web-callback-cimd-auto', { callbackUrl: WEB }, {}, { CIMD: '1' });
    cimd = await setup(
      'web-callback-cimd-explicit',
      { callbackUrl: WEB, clientRegistration: 'cimd' },
      {},
      { CIMD: '1' }
    );
  });

  after(() => {
    auto?.as.child.kill('SIGTERM');
    cimd?.as.child.kill('SIGTERM');
  });

  it('registers with DCR instead of offering the loopback-only CIMD document', async () => {
    const child = launch(['login', 'svc', '--no-browser'], { env: auto.env });
    const m = await waitFor(child, AUTHORIZE);
    assert.ok(m, child.err + child.out);
    const authUrl = new URL(m[1]);
    assert.equal(authUrl.searchParams.get('redirect_uri'), WEB);
    assert.doesNotMatch(authUrl.searchParams.get('client_id'), /^https:/);
    child.stdin.write(`${await authorize(m[1])}\n`);
    const r = await finish(child);
    assert.equal(r.status, 0, r.err);
    const log = await (await fetch(`${auto.as.base}/log`)).json();
    assert.deepEqual(log.clients.at(-1).redirect_uris, [WEB]);
    assert.deepEqual(log.flags, []);
  });

  it('honours an explicit clientRegistration cimd', async () => {
    const child = launch(['login', 'svc', '--no-browser'], { env: cimd.env });
    const m = await waitFor(child, AUTHORIZE);
    assert.ok(m, child.err + child.out);
    const authUrl = new URL(m[1]);
    assert.equal(
      authUrl.searchParams.get('client_id'),
      'https://mcpcat.sliccy.ai/oauth/client.json'
    );
    assert.equal(authUrl.searchParams.get('redirect_uri'), WEB);
    child.kill('SIGKILL');
    await child.done;
    const log = await (await fetch(`${cimd.as.base}/log`)).json();
    assert.equal(log.clients.length, 1);
    assert.deepEqual(listens(cimd.env), []);
  });
});

describe('web callbackUrl with callbackPort keeps the listener', () => {
  let ctx;

  before(async () => {
    ctx = await setup(
      'web-callback-port',
      { clientId: CLIENT, callbackUrl: WEB, callbackPort: 47913 },
      { MCPCAT_NO_JERK: '1' }
    );
  });

  after(() => ctx?.as.child.kill('SIGTERM'));

  it('tries to listen on the callbackUrl host at callbackPort', async () => {
    const child = launch(['login', 'svc', '--no-browser'], { env: ctx.env });
    const r = await finish(child);
    assert.equal(r.status, 4, r.err);
    const calls = listens(ctx.env);
    assert.ok(
      calls.some((args) => args[0] === 47913 && args[1] === 'www.sliccy.ai'),
      JSON.stringify(calls)
    );
  });
});

describe('loopback callbackUrl is unchanged', () => {
  const cases = [
    {
      name: 'localhost without a port',
      oauth: { callbackUrl: 'http://localhost/cb' },
      redirect: /^http:\/\/localhost:\d+\/cb$/,
      host: '127.0.0.1',
    },
    {
      name: '127.0.0.1 with a port',
      oauth: { callbackUrl: 'http://127.0.0.1:47914/cb' },
      redirect: /^http:\/\/127\.0\.0\.1:47914\/cb$/,
      host: '127.0.0.1',
      port: 47914,
    },
    {
      name: '[::1] without a port',
      oauth: { callbackUrl: 'http://[::1]/cb' },
      redirect: /^http:\/\/\[::1\]:\d+\/cb$/,
      host: '::1',
    },
  ];

  for (const c of cases) {
    describe(c.name, () => {
      let ctx;

      before(async () => {
        ctx = await setup(
          `loopback-${c.host}`,
          { clientRegistration: 'dcr', ...c.oauth },
          {
            MCPCAT_NO_JERK: '1',
          }
        );
      });

      after(() => ctx?.as.child.kill('SIGTERM'));

      it('listens on loopback and completes from the browser redirect', async (t) => {
        const child = launch(['login', 'svc', '--no-browser'], { env: ctx.env });
        const m = await waitFor(child, AUTHORIZE);
        if (!m && c.host === '::1' && /EADDRNOTAVAIL|EAFNOSUPPORT/.test(child.err)) {
          child.kill('SIGKILL');
          t.skip('no IPv6 loopback');
          return;
        }
        assert.ok(m, child.err + child.out);
        const redirect = new URL(m[1]).searchParams.get('redirect_uri');
        assert.match(redirect, c.redirect);
        assert.ok(await waitFor(child, /Paste the redirect URL from your browser address bar/));
        const calls = listens(ctx.env);
        assert.ok(
          calls.some((args) => args[1] === c.host && (c.port === undefined || args[0] === c.port)),
          JSON.stringify(calls)
        );
        const location = await authorize(m[1]);
        await fetch(location, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
        const r = await finish(child);
        assert.equal(r.status, 0, r.err);
      });
    });
  }
});
