import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { homeEnv, launch, run, scratchHome, startFixture } from './helpers/rows.mjs';

const AUTHORIZE = /(http:\/\/127\.0\.0\.1:\d+\/authorize\S+)/;

async function login(target, env, extraArgs = []) {
  const child = launch(['login', target, '--no-browser', ...extraArgs], { env });
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
  return { status: r.code, err: child.err, out: child.out, authorizeUrl: url };
}

function writeFakeJerk(binDir, home, version, { honourPort = true, logName = 'jerk.log' } = {}) {
  const logPath = join(home, logName);
  const createBody = honourPort
    ? `cfg="\${PI_MCP_CONFIG:?missing PI_MCP_CONFIG}"
    test "$cfg" != "$HOME/.pi/agent/mcp.json" || exit 3
    port=$(node -e "const j=require(process.argv[1]); const o=j.mcpServers.ch.oauth||{}; if(!o.callbackPort) process.exit(2); console.log(o.callbackPort)" "$cfg") || exit 2
    echo "CREATE_PORT=$port" >> "${logPath}"
    exit 0`
    : `echo "CREATE_OLD" >> "${logPath}"
    sleep 60
    exit 0`;
  writeFileSync(
    join(binDir, 'jerk'),
    `#!/bin/sh
echo "ARGV: $@" >> "${logPath}"
case "$1" in
  --version) echo "jerk ${version}"; exit 0 ;;
  list) echo '[{"provider":"mcp:ch","source":"mcp.json"}]'; exit 0 ;;
esac
case "$2" in
  create)
    ${createBody}
    ;;
  drop) exit 0 ;;
  get) echo '{"token":"t","expires_at":9999999999}'; exit 0 ;;
esac
exit 2
`,
    { mode: 0o755 }
  );
  return logPath;
}

describe('login falls back when jerk is below the callbackPort floor', () => {
  let as;
  let home;
  let env;
  let url;
  let logPath;
  let store;

  before(async () => {
    as = await startFixture('exact-redirect-oauth-as.mjs');
    url = `${as.base}/mcp`;
    home = scratchHome('jerk-floor-old');
    const binDir = join(home, 'bin');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(home, '.pi/agent'), { recursive: true });
    writeFileSync(
      join(home, '.pi/agent/mcp.json'),
      JSON.stringify({ mcpServers: { ch: { url } } }, null, 2)
    );
    store = join(home, '.pi/agent/mcp-auth.json');
    logPath = writeFakeJerk(binDir, home, '1.4.0', { honourPort: false });
    env = { ...homeEnv(home), PATH: `${binDir}:${process.env.PATH}` };
  });

  after(() => as?.child.kill('SIGTERM'));

  it('uses own sign-in, leaves no hanging create, and info works from pi store', async () => {
    const r = await login('ch', { ...env, MCPCAT_NO_JERK: undefined });
    assert.equal(r.status, 0, r.err);
    assert.match(r.err, /jerk 1\.4\.0 is older than 1\.5\.0/);
    assert.match(r.err, /using own sign-in/);
    const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
    assert.doesNotMatch(log, / create/);
    assert.ok(existsSync(store));
    assert.match(readFileSync(store, 'utf8'), /access_token|client_id/);
    const noJerkPath = (process.env.PATH || '')
      .split(':')
      .filter((d) => !d.includes(home) && !/jerk/.test(d))
      .join(':');
    const info = run(['info', 'ch'], { env: { ...env, PATH: noJerkPath } });
    assert.equal(info.status, 0, info.stderr);
  });

  it('-v names the own path and jerk version', () => {
    const r = run(['-v', 'login', 'ch', '--no-browser'], { env, input: '' });
    assert.match(r.stderr, /login via own sign-in \(jerk 1\.4\.0\)/);
    assert.match(r.stderr, /older than 1\.5\.0/);
  });
});

describe('login --no-jerk skips a new-enough jerk', () => {
  let as;
  let home;
  let env;
  let url;
  let logPath;
  let store;

  before(async () => {
    as = await startFixture('exact-redirect-oauth-as.mjs');
    url = `${as.base}/mcp`;
    home = scratchHome('jerk-floor-nojerk');
    const binDir = join(home, 'bin');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(home, '.pi/agent'), { recursive: true });
    writeFileSync(
      join(home, '.pi/agent/mcp.json'),
      JSON.stringify({ mcpServers: { ch: { url } } }, null, 2)
    );
    store = join(home, '.pi/agent/mcp-auth.json');
    logPath = writeFakeJerk(binDir, home, '1.5.0', { honourPort: true });
    env = { ...homeEnv(home), PATH: `${binDir}:${process.env.PATH}` };
  });

  after(() => as?.child.kill('SIGTERM'));

  it('own sign-in into mcp-auth.json; MCPCAT_NO_JERK keeps later reads on pi', async () => {
    const r = await login('ch', env, ['--no-jerk']);
    assert.equal(r.status, 0, r.err);
    assert.match(r.err, /skipping jerk \(--no-jerk\)/);
    const log = existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';
    assert.doesNotMatch(log, / create/);
    assert.ok(existsSync(store));
    const info = run(['info', 'ch'], { env: { ...env, MCPCAT_NO_JERK: '1' } });
    assert.equal(info.status, 0, info.stderr);
  });
});

describe('login keeps the jerk path for a new-enough jerk', () => {
  let as;
  let home;
  let env;
  let url;
  let logPath;

  before(async () => {
    as = await startFixture('exact-redirect-oauth-as.mjs');
    url = `${as.base}/mcp`;
    home = scratchHome('jerk-floor-new');
    const binDir = join(home, 'bin');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(home, '.pi/agent'), { recursive: true });
    writeFileSync(
      join(home, '.pi/agent/mcp.json'),
      JSON.stringify({ mcpServers: { ch: { url } } }, null, 2)
    );
    logPath = writeFakeJerk(binDir, home, '1.5.0', { honourPort: true });
    env = { ...homeEnv(home), PATH: `${binDir}:${process.env.PATH}` };
  });

  after(() => as?.child.kill('SIGTERM'));

  it('delegates to jerk create and -v names that path', () => {
    const r = run(['-v', 'login', 'ch', '--no-browser'], { env });
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.match(r.stderr, /login via jerk create \(jerk 1\.5\.0\)/);
    assert.match(readFileSync(logPath, 'utf8'), / create/);
    assert.match(readFileSync(logPath, 'utf8'), /CREATE_PORT=/);
  });
});

describe('login --help mentions --no-jerk', () => {
  it('prints per-verb help', () => {
    const r = run(['login', '--help']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /– login/);
    assert.match(r.stdout, /--no-jerk/);
    assert.match(r.stdout, /MCPCAT_NO_JERK/);
  });
});

describe('login --no-jerk does not probe a slow jerk --version', () => {
  let home;
  let env;
  let logPath;

  before(() => {
    home = scratchHome('jerk-floor-slow-ver');
    const binDir = join(home, 'bin');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(join(home, '.pi/agent'), { recursive: true });
    writeFileSync(
      join(home, '.pi/agent/mcp.json'),
      JSON.stringify({ mcpServers: { ch: { url: 'https://example.com/mcp' } } }, null, 2)
    );
    logPath = join(home, 'jerk.log');
    writeFileSync(
      join(binDir, 'jerk'),
      `#!/bin/sh
echo "ARGV: $@" >> "${logPath}"
case "$1" in
  --version) sleep 30; echo "jerk 1.5.0"; exit 0 ;;
  list) echo '[{"provider":"mcp:ch","source":"mcp.json"}]'; exit 0 ;;
esac
exit 2
`,
      { mode: 0o755 }
    );
    env = { ...homeEnv(home), PATH: `${binDir}:${process.env.PATH}` };
  });

  it('returns without starting jerk', () => {
    const started = Date.now();
    const r = run(['login', 'ch', '--no-jerk', '--no-browser'], { env, input: '' });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 2000, `waited ${elapsed}ms`);
    assert.match(r.stderr, /skipping jerk \(--no-jerk\)/);
    assert.equal(existsSync(logPath), false);
  });
});
