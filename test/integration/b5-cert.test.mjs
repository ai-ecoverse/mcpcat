import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const hostBin = join(root, 'dist/host/mcpcat.mjs');
const fixturesDir = join(root, 'test/integration/fixtures');

function runHost(args, opts = {}) {
  const r = spawnSync('node', [hostBin, ...args], {
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...process.env, NODE_NO_WARNINGS: '1', ...opts.env },
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? 1 };
}

async function startFixtureServer(script) {
  const child = spawn('node', [join(fixturesDir, script)], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  const info = await new Promise((resolve, reject) => {
    let data = '';
    child.stdout.on('data', (chunk) => {
      data += chunk.toString();
      if (data.includes('\n')) {
        try {
          resolve(JSON.parse(data.trim()));
        } catch (e) {
          reject(e);
        }
      }
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (!data.includes('\n')) reject(new Error(`Server exited ${code}: ${data}`));
    });
  });
  return { child, ...info };
}

describe('B5-1: flag-style tool arguments', () => {
  let server;
  let url;
  before(async () => {
    server = await startFixtureServer('server-2026-http.mjs');
    url = `http://127.0.0.1:${server.port}`;
  });
  after(() => {
    server?.child.kill('SIGTERM');
  });

  it('mcpcat call <url> add --a 2 --b 3 prints 5', () => {
    const { stdout, status } = runHost(['call', url, 'add', '--a', '2', '--b', '3']);
    assert.equal(status, 0);
    assert.equal(stdout.trim(), '5');
  });

  it('curl form: mcpcat <url> add --a 2 --b 3 prints 5', () => {
    const { stdout, status } = runHost([url, 'add', '--a', '2', '--b', '3']);
    assert.equal(status, 0);
    assert.equal(stdout.trim(), '5');
  });

  it('mcpcat <url> weather --city NYC sends city', () => {
    const { stdout, status } = runHost([url, 'weather', '--city', 'NYC']);
    assert.equal(status, 0);
    assert.ok(stdout.includes('Weather for NYC'));
  });

  it('-d merges with flags, flags win', () => {
    const { stdout, status } = runHost(['call', url, 'add', '-d', '{"a":10,"b":20}', '--a', '99']);
    assert.equal(status, 0);
    assert.equal(stdout.trim(), '119');
  });

  it('unknown flags exit 2 and name the flag', () => {
    const { stderr, status } = runHost(['call', url, 'weather', '--bogus', 'x']);
    assert.equal(status, 2);
    assert.ok(stderr.includes('--bogus'));
  });

  it('missing required flag exits 2 before any request', () => {
    const { stderr, status } = runHost(['call', url, 'weather', '--days', '3']);
    assert.equal(status, 2);
    assert.ok(stderr.includes('--city'));
  });

  it('--no-validate skips required check', () => {
    const { status } = runHost(['--no-validate', 'call', url, 'weather', '--days', '3']);
    assert.equal(status, 0);
  });

  it('lone --help is mcpcat help, not a tool arg', () => {
    const { stdout, status } = runHost(['--help']);
    assert.equal(status, 0);
    assert.ok(stdout.includes('mcpcat'));
  });
});

describe('B5-1: tool param named verbose/v does not collide', () => {
  let server;
  let url;
  before(async () => {
    server = await startFixtureServer('server-header-echo.mjs');
    url = `http://127.0.0.1:${server.port}`;
  });
  after(() => {
    server?.child.kill('SIGTERM');
  });

  it('--verbose and --v after tool name are tool args', () => {
    const { stdout, status } = runHost([
      'call',
      url,
      'verbose-tool',
      '--verbose',
      'true',
      '--v',
      'true',
      '--message',
      'hi',
    ]);
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout.trim());
    assert.equal(parsed.verbose, true);
    assert.equal(parsed.v, true);
    assert.equal(parsed.message, 'hi');
  });

  it('-v before verb is mcpcat verbose', () => {
    const { stderr, status } = runHost(['-v', 'call', url, 'verbose-tool', '--message', 'hi']);
    assert.equal(status, 0);
    assert.ok(stderr.includes('>') || stderr.includes('<'));
  });
});

describe('B5-2: ${VAR} in mcp.json headers is expanded', () => {
  let server;
  let url;
  let tmpDir;
  let configPath;

  before(async () => {
    server = await startFixtureServer('server-header-echo.mjs');
    url = `http://127.0.0.1:${server.port}`;
    tmpDir = join(tmpdir(), `mcpcat-b5-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    configPath = join(tmpDir, 'mcp.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: {
          'test-echo': {
            url: `http://127.0.0.1:${server.port}/mcp`,
            headers: { Authorization: 'Bearer ${TEST_CONFIG_TOKEN}' },
          },
        },
      })
    );
  });

  after(() => {
    server?.child.kill('SIGTERM');
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('config header ${VAR} is expanded at connect time', () => {
    const marker = `secret-config-token-${Date.now()}`;
    const { stdout, status, stderr } = runHost(['call', 'test-echo', 'echo-auth'], {
      env: {
        TEST_CONFIG_TOKEN: marker,
        HOME: tmpDir,
        PI_CODING_AGENT_DIR: tmpDir,
      },
    });
    assert.equal(status, 0, `stderr: ${stderr}`);
    assert.ok(stdout.includes(`Bearer ${marker}`));
  });

  it('config header with unset var is dropped with warning', () => {
    const { stderr, status } = runHost(['call', 'test-echo', 'echo-auth'], {
      env: {
        HOME: tmpDir,
        PI_CODING_AGENT_DIR: tmpDir,
      },
    });
    assert.equal(status, 0, `stderr: ${stderr}`);
    assert.ok(stderr.includes('TEST_CONFIG_TOKEN'));
  });
});

describe('B5-3: error output is redacted', () => {
  let server;
  let url;
  before(async () => {
    server = await startFixtureServer('server-header-echo.mjs');
    url = `http://127.0.0.1:${server.port}`;
  });
  after(() => {
    server?.child.kill('SIGTERM');
  });

  it('RPC error reflecting auth is redacted in text mode', () => {
    const marker = `SUPER_SECRET_${Date.now()}`;
    const { stderr, stdout, status } = runHost(
      ['-H', `Authorization: Bearer ${marker}`, 'call', url, 'fail-with-auth', '-d', '{}'],
      {}
    );
    assert.equal(status, 5);
    assert.ok(!stdout.includes(marker), 'secret in stdout');
    assert.ok(!stderr.includes(marker), 'secret in stderr');
  });

  it('RPC error reflecting auth is redacted in --json mode', () => {
    const marker = `JSON_SECRET_${Date.now()}`;
    const { stderr, stdout, status } = runHost(
      [
        '-H',
        `Authorization: Bearer ${marker}`,
        '--json',
        'call',
        url,
        'fail-with-auth',
        '-d',
        '{}',
      ],
      {}
    );
    assert.equal(status, 5);
    assert.ok(!stdout.includes(marker), 'secret in stdout');
    assert.ok(!stderr.includes(marker), 'secret in stderr');
  });
});

describe('B5: -o/--output writes to file', () => {
  let server;
  let url;
  let tmpDir;
  before(async () => {
    server = await startFixtureServer('server-2026-http.mjs');
    url = `http://127.0.0.1:${server.port}`;
    tmpDir = join(tmpdir(), `mcpcat-output-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
  });
  after(() => {
    server?.child.kill('SIGTERM');
    if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('-o writes call result to file', () => {
    const outPath = join(tmpDir, 'result.txt');
    const { status } = runHost(['-o', outPath, 'call', url, 'echo', '-d', '{"message":"hello"}']);
    assert.equal(status, 0);
    const content = readFileSync(outPath, 'utf8');
    assert.equal(content, 'hello');
  });
});

describe('B5: add on fresh HOME', () => {
  it('add on empty HOME does not crash with stack trace', () => {
    const tmpDir = join(tmpdir(), `mcpcat-fresh-${Date.now()}`);
    mkdirSync(tmpDir, { recursive: true });
    const { stderr, status } = runHost(
      ['add', '--no-probe', 'test-srv', 'https://example.com/mcp'],
      { env: { HOME: tmpDir } }
    );
    assert.ok(status === 0 || status === 2, `unexpected exit ${status}: ${stderr}`);
    assert.ok(!stderr.includes('Error:') || !stderr.includes('at '), 'should not have stack trace');
    rmSync(tmpDir, { recursive: true, force: true });
  });
});

describe('B5: unset ${VAR} in -H exits 2', () => {
  let server;
  let url;
  before(async () => {
    server = await startFixtureServer('server-2026-http.mjs');
    url = `http://127.0.0.1:${server.port}`;
  });
  after(() => {
    server?.child.kill('SIGTERM');
  });

  it('unset var in -H exits 2 naming the variable', () => {
    const { stderr, status } = runHost([
      '-H',
      'Authorization: Bearer ${MY_MISSING_TOKEN}',
      'info',
      url,
    ]);
    assert.equal(status, 2);
    assert.ok(stderr.includes('MY_MISSING_TOKEN'));
  });
});

describe('B5: missing stdio command exits 3 cleanly', () => {
  it('nonexistent stdio command exits 3 with one-line message', () => {
    const { stderr, status } = runHost(['info', 'stdio:nonexistent-binary-xyz-42']);
    assert.equal(status, 3);
    assert.ok(stderr.includes('command not found') || stderr.includes('ENOENT'));
    assert.ok(!stderr.includes('at '), 'should not have stack trace');
    const lines = stderr
      .trim()
      .split('\n')
      .filter((l) => l.length > 0);
    assert.ok(lines.length <= 3, `expected <=3 lines, got ${lines.length}`);
  });
});

describe('B5: prompt with flag args (M10)', () => {
  let server;
  let url;
  before(async () => {
    server = await startFixtureServer('server-2026-http-prompts.mjs');
    url = `http://127.0.0.1:${server.port}`;
  });
  after(() => {
    server?.child.kill('SIGTERM');
  });

  it('mcpcat prompt <target> <name> --topic x works', () => {
    const { stdout, status } = runHost(['prompt', url, 'summarize', '--topic', 'AI']);
    assert.equal(status, 0);
    assert.ok(stdout.includes('AI'));
  });

  it('missing required prompt arg exits 2', () => {
    const { stderr, status } = runHost(['prompt', url, 'summarize']);
    assert.equal(status, 2);
    assert.ok(stderr.includes('--topic'));
  });
});
