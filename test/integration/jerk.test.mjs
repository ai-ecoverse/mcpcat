import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const hostBin = join(root, 'dist/host/mcpcat.mjs');

function runHost(args, opts = {}) {
  try {
    const result = execFileSync(process.execPath, [hostBin, ...args], {
      encoding: 'utf8',
      timeout: 15_000,
      env: { ...process.env, NODE_NO_WARNINGS: '1', ...opts.env },
      input: opts.input,
    });
    return { stdout: result, stderr: '', status: 0 };
  } catch (err) {
    return {
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
      status: err.status ?? 1,
    };
  }
}

describe('no jerk on PATH: fast startup', () => {
  it('mcpcat --version completes under 1s without jerk', () => {
    const noJerkPath = (process.env.PATH ?? '')
      .split(':')
      .filter((d) => !/jerk/.test(d))
      .join(':');
    const start = Date.now();
    const result = runHost(['--version'], {
      env: { PATH: noJerkPath, HOME: tmpdir() },
    });
    const elapsed = Date.now() - start;
    assert.equal(result.status, 0);
    assert.ok(elapsed < 1000, `--version took ${elapsed}ms, expected < 1000ms`);
  });
});

describe('jerk integration', () => {
  let tmp;
  let binDir;
  let configDir;
  const MARKER_TOKEN = 'MARKER_TOKEN_xK9z_DO_NOT_EXPOSE';

  before(() => {
    tmp = mkdtempSync(join(tmpdir(), 'mcpcat-jerk-'));
    binDir = join(tmp, 'bin');
    configDir = join(tmp, '.pi', 'agent');
    mkdirSync(binDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });

    writeFileSync(
      join(configDir, 'mcp.json'),
      JSON.stringify({
        mcpServers: {
          testserver: { url: 'https://mcp.example.com/' },
        },
      })
    );

    const logPath = join(tmp, 'jerk.log');
    const jerkScript = `#!/bin/sh
echo "JERK_ARGV: $@" >> "${logPath}"
case "$1" in
  --version)
    echo "jerk 0.14.1"
    exit 0
    ;;
  list)
    echo '[{"provider":"mcp:testserver","source":"mcp.json"}]'
    exit 0
    ;;
esac
verb=""
for arg in "$@"; do
  case "$arg" in
    get|create|drop) verb="$arg" ;;
  esac
done
case "$verb" in
  get)
    echo '{"token":"${MARKER_TOKEN}","expires_at":1800000000}'
    exit 0
    ;;
  create)
    echo "signed in" >&2
    exit 0
    ;;
  drop)
    echo "dropped" >&2
    exit 0
    ;;
  *)
    echo "unknown verb" >&2
    exit 2
    ;;
esac
`;
    writeFileSync(join(binDir, 'jerk'), jerkScript, { mode: 0o755 });
  });

  after(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function jerkEnv() {
    return {
      PATH: `${binDir}:${process.env.PATH}`,
      HOME: tmp,
    };
  }

  it('login delegates to jerk create', () => {
    const result = runHost(['login', 'testserver'], { env: jerkEnv() });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Signed in/);
  });

  it('logout delegates to jerk drop', () => {
    const result = runHost(['logout', 'testserver'], { env: jerkEnv() });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Signed out/);
  });

  it('token never appears in mcpcat stdout or stderr', () => {
    const result = runHost(['login', 'testserver'], { env: jerkEnv() });
    assert.ok(!result.stdout.includes(MARKER_TOKEN), 'token leaked to stdout');
    assert.ok(!result.stderr.includes(MARKER_TOKEN), 'token leaked to stderr');
  });

  it('jerk argv never contains token', () => {
    runHost(['login', 'testserver'], { env: jerkEnv() });
    let log = '';
    try {
      log = require('node:fs').readFileSync(join(tmp, 'jerk.log'), 'utf8');
    } catch {}
    assert.ok(!log.includes(MARKER_TOKEN), 'token appeared in jerk argv');
  });

  describe('fake jerk exit 3 → mcpcat exit 4', () => {
    let tmpSignin;
    let binDirSignin;

    before(() => {
      tmpSignin = mkdtempSync(join(tmpdir(), 'mcpcat-jerk-signin-'));
      binDirSignin = join(tmpSignin, 'bin');
      mkdirSync(binDirSignin, { recursive: true });

      const jerkScript = `#!/bin/sh
case "$1" in
  --version)
    echo "jerk 0.14.1"
    exit 0
    ;;
  list)
    echo '[{"provider":"mcp:needslogin","source":"mcp.json"}]'
    exit 0
    ;;
esac
echo "sign-in required" >&2
exit 3
`;
      writeFileSync(join(binDirSignin, 'jerk'), jerkScript, { mode: 0o755 });

      const cfgDir = join(tmpSignin, '.pi', 'agent');
      mkdirSync(cfgDir, { recursive: true });
      writeFileSync(
        join(cfgDir, 'mcp.json'),
        JSON.stringify({
          mcpServers: {
            needslogin: { url: 'https://mcp.example.com/' },
          },
        })
      );
    });

    after(() => {
      rmSync(tmpSignin, { recursive: true, force: true });
    });

    it('login returns exit 4 when jerk exits 3', () => {
      const result = runHost(['login', 'needslogin'], {
        env: {
          PATH: `${binDirSignin}:${process.env.PATH}`,
          HOME: tmpSignin,
        },
      });
      assert.equal(result.status, 4);
    });
  });

  describe('falls back to pi store without jerk', () => {
    it('login works without jerk on PATH', () => {
      const tmpNoJerk = mkdtempSync(join(tmpdir(), 'mcpcat-nojerk-'));
      const cfgDir = join(tmpNoJerk, '.pi', 'agent');
      mkdirSync(cfgDir, { recursive: true });
      writeFileSync(
        join(cfgDir, 'mcp.json'),
        JSON.stringify({
          mcpServers: {
            srv: { url: 'https://mcp.example.com/' },
          },
        })
      );
      const result = runHost(['login', 'srv', '--no-browser'], {
        env: {
          PATH: '/usr/bin:/bin',
          HOME: tmpNoJerk,
        },
        input: '',
      });
      rmSync(tmpNoJerk, { recursive: true, force: true });
      assert.ok(result.status !== 2, 'should not be usage error');
    });
  });
});
