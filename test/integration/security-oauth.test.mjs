import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileMode, homeEnv, launch, run, scratchHome, startFixture } from './helpers/rows.mjs';

const AUTHORIZE = /(http:\/\/127\.0\.0\.1:\d+\/authorize\S+)/;

async function login(target, env, { via = 'callback' } = {}) {
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
    return { status: r.code, err: child.err };
  }
  const authorized = await fetch(url, { redirect: 'manual' });
  const location = authorized.headers.get('location');
  assert.ok(location, `the authorization server answered ${authorized.status}`);
  if (via === 'stdin') {
    child.stdin.write(`${location}\n`);
  } else {
    try {
      await fetch(location, { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    } catch {
      child.stdin.write(`${location}\n`);
    }
  }
  const timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  const r = await child.done;
  clearTimeout(timer);
  return { status: r.code, err: child.err, authorizeUrl: url };
}

const asLog = async (as) => (await fetch(`${as.base}/log`)).json();
const used = (log) => Object.values(log.refresh).filter((s) => s === 'used').length;
const leaks = (text, log) => log.issued.filter((t) => text.includes(t));

describe('security: OAuth login, redaction, rotation and the store', () => {
  let as;
  let home;
  let env;
  let url;
  let store;
  let first;

  before(async () => {
    as = await startFixture('security-oauth-as.mjs', { ROW_AS_TTL: '3600' });
    url = `${as.base}/mcp`;
    home = scratchHome('oauth');
    env = homeEnv(home);
    store = join(home, '.pi/agent/mcp-auth.json');
    first = await login(url, env);
  });

  after(() => as?.child.kill('SIGTERM'));

  it('logs in with DCR, PKCE S256, a long state, the exact redirect and the resource', async () => {
    assert.equal(first.status, 0, first.err);
    const log = await asLog(as);
    const q = new URL(first.authorizeUrl).searchParams;
    assert.equal(log.clients.length, 1);
    assert.equal(q.get('code_challenge_method'), 'S256');
    assert.equal(q.get('code_challenge').length, 43);
    assert.ok(q.get('state').length >= 16);
    assert.equal(log.clients[0].redirect_uris[0], q.get('redirect_uri'));
    assert.equal(q.get('resource'), url);
    assert.deepEqual(log.flags, []);
  });

  it('keeps the store at 0600 in a 0700 directory', () => {
    assert.equal(fileMode(store), '600');
    assert.equal(fileMode(join(home, '.pi/agent')), '700');
  });

  it('redacts a token the server reflects into an error', async () => {
    assert.equal(run(['call', url, 'whoami'], { env }).status, 0);
    const outs = [
      run(['call', url, 'fail'], { env }),
      run(['--json', 'call', url, 'fail'], { env }),
      run(['-v', 'call', url, 'fail'], { env }),
    ];
    const text = outs.map((r) => r.stdout + r.stderr).join('\n');
    assert.deepEqual(leaks(text, await asLog(as)), []);
    assert.match(text, /REDACTED/);
  });

  it('refreshes once with a rotated token, redacts it and puts a 0644 store back to 0600', async () => {
    const before = used(await asLog(as));
    chmodSync(store, 0o644);
    const tokens = JSON.parse(readFileSync(store, 'utf8'));
    for (const entry of Object.values(tokens)) entry.tokensExpireAt = Date.now() - 1000;
    writeFileSync(store, JSON.stringify(tokens));
    chmodSync(store, 0o644);
    const r = run(['-v', 'call', url, 'fail'], { env });
    const log = await asLog(as);
    assert.equal(used(log) - before, 1, r.stderr);
    assert.ok(!log.flags.includes('refresh-reuse'), JSON.stringify(log.flags));
    assert.deepEqual(leaks(r.stdout + r.stderr, log), []);
    assert.equal(fileMode(store), '600');
    assert.equal(run(['call', url, 'whoami'], { env }).status, 0);
    assert.ok(!(await asLog(as)).flags.includes('refresh-reuse'));
  });

  it('logout empties the store', () => {
    const r = run(['logout', url], { env });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(readFileSync(store, 'utf8').trim(), '{}');
  });
});

for (const mode of ['bad-state', 'evil-redirect']) {
  describe(`security: OAuth refuses a callback (${mode})`, () => {
    let as;
    after(() => as?.child.kill('SIGTERM'));

    it('exits 4 and stores no token', async () => {
      as = await startFixture('security-oauth-as.mjs', { ROW_AS_MODE: mode });
      const home = scratchHome(mode);
      const r = await login(`${as.base}/mcp`, homeEnv(home), { via: 'stdin' });
      assert.equal(r.status, 4, r.err);
      const store = join(home, '.pi/agent/mcp-auth.json');
      assert.ok(!existsSync(store) || !/access_token/.test(readFileSync(store, 'utf8')));
    });
  });
}
