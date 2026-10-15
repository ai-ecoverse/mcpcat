import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const hostBin = join(root, 'dist/host/mcpcat.mjs');

function runAsync(args, env, killAfterMs) {
  return new Promise((resolve) => {
    const start = Date.now();
    const child = spawn('node', [hostBin, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1', ...env },
    });
    child.stdin.write('y\n');
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      stdout += c;
    });
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      child.kill('SIGKILL');
    }, killAfterMs);
    child.on('close', (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr, killed, elapsed: Date.now() - start });
    });
  });
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function gone(pid, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    await sleep(50);
  }
  return !alive(pid);
}

function pids(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(Number);
}

describe('test isolation', () => {
  it('no directory on PATH holds a jerk, and HOME is a temp dir', () => {
    for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
      assert.ok(!existsSync(join(dir, 'jerk')), `${dir} holds a jerk`);
    }
    assert.ok(process.env.HOME.startsWith(tmpdir()), `HOME is ${process.env.HOME}`);
    assert.equal(process.env.PI_CODING_AGENT_DIR, undefined);
  });

  it('strips a developer jerk from PATH but keeps node', () => {
    const dev = mkdtempSync(join(tmpdir(), 'mcpcat-devbin-'));
    writeFileSync(join(dev, 'jerk'), '#!/bin/sh\necho "jerk 9.9.9"\n', { mode: 0o755 });
    const out = execFileSync(
      process.execPath,
      [
        '--import',
        join(here, 'helpers/isolate.mjs'),
        '-e',
        'console.log(JSON.stringify({PATH:process.env.PATH,HOME:process.env.HOME}))',
      ],
      { encoding: 'utf8', env: { ...process.env, PATH: `${dev}${delimiter}${process.env.PATH}` } }
    );
    rmSync(dev, { recursive: true, force: true });
    const env = JSON.parse(out);
    assert.ok(!env.PATH.split(delimiter).includes(dev), 'developer jerk dir kept on PATH');
    assert.ok(
      env.PATH.split(delimiter).some((d) => existsSync(join(d, 'node'))),
      'node not on PATH'
    );
    assert.notEqual(env.HOME, process.env.HOME);
  });

  it('every integration test file isolates PATH and HOME', () => {
    const files = readdirSync(here).filter((f) => /\.(test|cert)\.mjs$/.test(f));
    for (const f of files) {
      const src = readFileSync(join(here, f), 'utf8');
      assert.ok(src.startsWith("import './helpers/isolate.mjs';"), `${f} does not import isolate`);
    }
  });
});

describe('mcpcat never hangs on jerk', () => {
  let tmp;
  let binDir;
  let server;
  let url;
  let log;
  let pidFile;

  function writeJerk(getBody, versionBody = 'echo "jerk 0.15.2"') {
    writeFileSync(
      join(binDir, 'jerk'),
      `#!/bin/sh
echo "ARGV: $@" >> "${log}"
if [ "$1" = "list" ]; then
  echo '[{"provider":"mcp:locked","source":"mcp.json"}]'
  exit 0
fi
if [ "$1" = "--version" ]; then
  echo $$ >> "${pidFile}"
  ${versionBody}
  exit 0
fi
for a in "$@"; do
  case "$a" in
    get|drop)
      echo $$ >> "${pidFile}"
      ${getBody}
      ;;
  esac
done
exit 2
`,
      { mode: 0o755 }
    );
  }

  function env() {
    return { PATH: `${binDir}${delimiter}${process.env.PATH}`, HOME: tmp };
  }

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'mcpcat-jerk-hang-'));
    binDir = join(tmp, 'bin');
    mkdirSync(binDir, { recursive: true });
    log = join(tmp, 'jerk.log');
    pidFile = join(tmp, 'jerk.pids');
    server = spawn('node', [join(here, 'fixtures/server-401.mjs')], {
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    const info = await new Promise((resolve) => {
      server.stdout.once('data', (c) => resolve(JSON.parse(String(c).trim())));
    });
    url = `http://127.0.0.1:${info.port}/mcp`;
    mkdirSync(join(tmp, '.pi', 'agent'), { recursive: true });
    writeFileSync(
      join(tmp, '.pi', 'agent', 'mcp.json'),
      JSON.stringify({ mcpServers: { locked: { url } } })
    );
  });

  after(() => {
    server?.kill('SIGTERM');
    for (const pid of pids(pidFile)) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {}
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  function reset() {
    rmSync(log, { force: true });
    rmSync(pidFile, { force: true });
  }

  it('jerk get never reads mcpcat stdin', async () => {
    reset();
    writeJerk(`if read -r line; then echo "STDIN: $line" >> "${log}"; fi
      exit 3`);
    const r = await runAsync(['call', 'locked', 'echo', '-d', '{}'], env(), 10_000);
    assert.equal(r.killed, false, `mcpcat hung on a jerk reading stdin: ${r.stderr}`);
    assert.equal(r.status, 4, r.stderr);
    const text = readFileSync(log, 'utf8');
    assert.match(text, /ARGV: mcp:locked get/);
    assert.doesNotMatch(text, /STDIN:/);
  });

  it('a silent jerk get is killed after --timeout and exits 4 with the command to run', async () => {
    reset();
    writeJerk('exec sleep 60');
    const r = await runAsync(
      ['--timeout', '2', 'call', 'locked', 'echo', '-d', '{}'],
      env(),
      15_000
    );
    assert.equal(r.killed, false, 'mcpcat hung on a silent jerk');
    assert.equal(r.status, 4, r.stderr);
    assert.ok(r.elapsed < 8_000, `took ${r.elapsed}ms`);
    assert.match(r.stderr, /jerk did not answer; run `jerk mcp:locked get` yourself/);
    const getPid = pids(pidFile).at(-1);
    assert.ok(await gone(getPid), `jerk get ${getPid} survived`);
  });

  it('a silent jerk get times out after 15s by default', async () => {
    reset();
    writeJerk('exec sleep 60');
    const r = await runAsync(['call', 'locked', 'echo', '-d', '{}'], env(), 28_000);
    assert.equal(r.killed, false, 'mcpcat hung on a silent jerk');
    assert.equal(r.status, 4, r.stderr);
    assert.ok(r.elapsed >= 14_000 && r.elapsed < 25_000, `took ${r.elapsed}ms`);
    assert.match(r.stderr, /jerk did not answer; run `jerk mcp:locked get` yourself/);
  });

  it('a silent jerk --version falls back to pi and is killed', async () => {
    reset();
    writeJerk('exit 3', 'exec sleep 60');
    const r = await runAsync(['call', 'locked', 'echo', '-d', '{}'], env(), 15_000);
    assert.equal(r.killed, false, 'mcpcat hung on jerk --version');
    assert.equal(r.status, 4, r.stderr);
    assert.match(r.stderr, /mcpcat login/);
    const versionPid = pids(pidFile)[0];
    assert.ok(await gone(versionPid), `jerk --version ${versionPid} survived`);
  });

  it('a silent jerk drop does not hang logout', async () => {
    reset();
    writeJerk('exec sleep 60');
    const r = await runAsync(['--timeout', '2', 'logout', 'locked'], env(), 15_000);
    assert.equal(r.killed, false, 'logout hung on a silent jerk');
    assert.equal(r.status, 4, r.stderr);
    assert.match(r.stderr, /jerk did not answer; run `jerk mcp:locked drop` yourself/);
    const dropPid = pids(pidFile).at(-1);
    assert.ok(await gone(dropPid), `jerk drop ${dropPid} survived`);
  });
});
