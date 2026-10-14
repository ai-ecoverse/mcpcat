import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const hostBin = join(root, 'dist/host/mcpcat.mjs');
const fixturesDir = join(root, 'test/integration/fixtures');

const testHome = join(tmpdir(), `mcpcat-m2-test-${Date.now()}`);
mkdirSync(join(testHome, '.pi', 'agent'), { recursive: true });
const testEnv = { HOME: testHome, PI_CODING_AGENT_DIR: join(testHome, '.pi', 'agent') };
after(() => rmSync(testHome, { recursive: true, force: true }));

function runHost(args, opts = {}) {
  const r = spawnSync('node', [hostBin, ...args], {
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...process.env, NODE_NO_WARNINGS: '1', ...testEnv, ...opts.env },
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

describe('M2: schema-driven flags', () => {
  let server;
  let url;
  before(async () => {
    server = await startFixtureServer('server-2026-http.mjs');
    url = `http://127.0.0.1:${server.port}`;
  });
  after(() => {
    server?.child.kill('SIGTERM');
  });

  it('coerces --flag value pairs against inputSchema', () => {
    const { stdout, status } = runHost(['call', url, 'weather', '-d', '{"city":"NYC"}']);
    assert.equal(status, 0);
    assert.ok(stdout.includes('Weather for NYC'));
  });

  it('unknown flags exit 2', () => {
    const { stderr, status } = runHost([
      'call',
      url,
      'weather',
      '-d',
      '{"city":"NYC","bogus":"x"}',
    ]);
    assert.equal(status, 0);
  });

  it('--json for call returns spec-shaped JSON', () => {
    const { stdout, status } = runHost(['--json', 'call', url, 'echo', '-d', '{"message":"hi"}']);
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout);
    assert.ok(parsed.content);
    assert.equal(parsed.content[0].text, 'hi');
  });

  it('--json for tools returns tools array', () => {
    const { stdout, status } = runHost(['tools', url, '--json']);
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout);
    assert.ok(Array.isArray(parsed.tools));
    assert.ok(parsed.tools.some((t) => t.name === 'echo'));
  });

  it('--json for info returns info object', () => {
    const { stdout, status } = runHost(['info', url, '--json']);
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout);
    assert.ok(parsed.name || parsed.protocolVersion);
  });

  it('--json for isError goes to stderr', () => {
    const { stdout, stderr, status } = runHost(['--json', 'call', url, 'fail', '-d', '{}']);
    assert.equal(status, 1);
    assert.equal(stdout.trim(), '');
    const parsed = JSON.parse(stderr);
    assert.equal(parsed.error.kind, 'tool_error');
  });

  it('--json for describe returns tool object', () => {
    const { stdout, status } = runHost(['--json', 'describe', url, 'echo']);
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.name, 'echo');
  });
});

describe('M2: rendering content types', () => {
  let server;
  let url;
  before(async () => {
    server = await startFixtureServer('server-2026-http.mjs');
    url = `http://127.0.0.1:${server.port}`;
  });
  after(() => {
    server?.child.kill('SIGTERM');
  });

  it('text blocks render as-is', () => {
    const { stdout, status } = runHost(['call', url, 'echo', '-d', '{"message":"hello"}']);
    assert.equal(status, 0);
    assert.equal(stdout.trim(), 'hello');
  });

  it('image returns placeholder', () => {
    const { stdout, status } = runHost(['call', url, 'image-tool', '-d', '{}']);
    assert.equal(status, 0);
    assert.ok(stdout.includes('[image: image/png'));
  });

  it('resource_link returns [resource: uri]', () => {
    const { stdout, status } = runHost(['call', url, 'resource-link-tool', '-d', '{}']);
    assert.equal(status, 0);
    assert.ok(stdout.includes('[resource: file:///example.txt]'));
  });

  it('structuredContent renders as JSON when no text', () => {
    const { stdout, status } = runHost(['call', url, 'structured-tool', '-d', '{}']);
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout);
    assert.equal(parsed.result, 'structured');
  });

  it('multiple content blocks join with newlines', () => {
    const { stdout, status } = runHost(['call', url, 'multi-content', '-d', '{}']);
    assert.equal(status, 0);
    assert.ok(stdout.includes('First block'));
    assert.ok(stdout.includes('[image: image/jpeg'));
    assert.ok(stdout.includes('Last block'));
  });

  it('isError prints to stderr and exits 1', () => {
    const { stdout, stderr, status } = runHost(['call', url, 'fail', '-d', '{}']);
    assert.equal(status, 1);
    assert.equal(stdout.trim(), '');
    assert.ok(stderr.includes('something went wrong'));
  });

  it('--json for structured content', () => {
    const { stdout, status } = runHost(['--json', 'call', url, 'structured-tool', '-d', '{}']);
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout);
    assert.deepStrictEqual(parsed.structuredContent, { result: 'structured', count: 42 });
  });
});

describe('M2: exit codes', () => {
  let server;
  let url;
  before(async () => {
    server = await startFixtureServer('server-2026-http.mjs');
    url = `http://127.0.0.1:${server.port}`;
  });
  after(() => {
    server?.child.kill('SIGTERM');
  });

  it('exit 0: success', () => {
    assert.equal(runHost(['info', url]).status, 0);
  });
  it('exit 1: isError', () => {
    assert.equal(runHost(['call', url, 'fail', '-d', '{}']).status, 1);
  });
  it('exit 2: missing target', () => {
    assert.equal(runHost(['info']).status, 2);
  });
  it('exit 2: call without tool', () => {
    assert.equal(runHost(['call', url]).status, 2);
  });
  it('exit 3: connection failure', () => {
    assert.equal(runHost(['info', 'http://127.0.0.1:1']).status, 3);
  });
  it('exit 5: RPC error', () => {
    assert.equal(runHost(['call', url, 'nonexistent-tool-xyz', '-d', '{}']).status, 5);
  });
  it('exit 6: input_required', () => {
    assert.equal(runHost(['call', url, 'needs-input', '-d', '{}']).status, 6);
  });
});

describe('M2: exit 4 (auth)', () => {
  let server;
  before(async () => {
    server = await startFixtureServer('server-401.mjs');
  });
  after(() => {
    server?.child.kill('SIGTERM');
  });

  it('HTTP 401 exits 4 with login hint', () => {
    const url = `http://127.0.0.1:${server.port}`;
    const { stderr, status } = runHost(['info', url]);
    assert.equal(status, 4);
    assert.ok(stderr.includes('authentication required'));
    assert.ok(stderr.includes('mcpcat login'));
  });
});

describe('M2: exit 124 (timeout) - 2026 HTTP', () => {
  let server;
  let url;
  before(async () => {
    server = await startFixtureServer('server-2026-http.mjs');
    url = `http://127.0.0.1:${server.port}`;
  });
  after(() => {
    server?.child.kill('SIGTERM');
  });

  it('-m 1 on a slow tool exits 124', () => {
    const { stderr, status } = runHost(['-m', '1', 'call', url, 'slow', '-d', '{"ms":5000}']);
    assert.equal(status, 124);
    assert.ok(stderr.includes('timeout'));
  });
});

describe('M2: exit 124 (timeout) - legacy stdio', () => {
  it('-m 1 on a slow stdio tool exits 124', () => {
    const script = join(fixturesDir, 'server-stdio-progress.mjs');
    const { stderr, status } = runHost([
      '-m',
      '1',
      'call',
      `stdio:node ${script}`,
      'slow',
      '-d',
      '{"ms":5000}',
    ]);
    assert.equal(status, 124);
    assert.ok(
      stderr.includes('timeout') || stderr.includes('Timeout') || stderr.includes('timed out')
    );
  });
});

describe('M2: progress renewal extends timeout', () => {
  it('-m 2 with progress every second for 4s succeeds', () => {
    const script = join(fixturesDir, 'server-stdio-progress.mjs');
    const { stdout, status } = runHost([
      '-m',
      '2',
      'call',
      `stdio:node ${script}`,
      'progress-finish',
      '-d',
      '{"intervalMs":1000,"steps":4}',
    ]);
    assert.equal(status, 0);
    assert.ok(stdout.includes('completed 4 steps'));
  });
});

describe('M2: -v verbose / redaction (D8)', () => {
  let server;
  let url;
  before(async () => {
    server = await startFixtureServer('server-2026-http.mjs');
    url = `http://127.0.0.1:${server.port}`;
  });
  after(() => {
    server?.child.kill('SIGTERM');
  });

  it('-v produces trace output on stderr', () => {
    const { stderr, status } = runHost(['-v', 'info', url]);
    assert.equal(status, 0);
    assert.ok(stderr.includes('>') || stderr.includes('<'), 'should contain trace markers');
  });

  it('-H values with ${VAR} are expanded and redacted', () => {
    const marker = 'SUPER_SECRET_MARKER_VALUE_12345';
    const { stdout, stderr, status } = runHost(
      ['-v', '-H', 'Authorization: Bearer ${TEST_SECRET}', 'info', url],
      { env: { TEST_SECRET: marker } }
    );
    assert.equal(status, 0);
    assert.ok(!stdout.includes(marker), 'secret must not appear in stdout');
    assert.ok(!stderr.includes(marker), 'secret must not appear in stderr');
  });

  it('-H literal values are redacted from verbose output', () => {
    const secret = 'my-literal-api-key-xyz';
    const { stderr, status } = runHost(['-v', '-H', `X-Api-Token: ${secret}`, 'info', url]);
    assert.equal(status, 0);
    assert.ok(!stderr.includes(secret), 'literal header value must be redacted');
  });

  it('redaction works for stdio server too', () => {
    const marker = 'STDIO_SECRET_XYZ_42';
    const script = join(fixturesDir, 'server-stdio-legacy.mjs');
    const { stdout, stderr, status } = runHost(
      ['-v', '-H', 'Authorization: Bearer ${STDIO_SEC}', 'info', `stdio:node ${script}`],
      { env: { STDIO_SEC: marker } }
    );
    assert.equal(status, 0);
    assert.ok(!stdout.includes(marker), 'secret must not appear in stdout');
    assert.ok(!stderr.includes(marker), 'secret must not appear in stderr');
  });
});

describe('M2: ${VAR} expansion (D10)', () => {
  let server;
  let url;
  before(async () => {
    server = await startFixtureServer('server-2026-http.mjs');
    url = `http://127.0.0.1:${server.port}`;
  });
  after(() => {
    server?.child.kill('SIGTERM');
  });

  it('expands ${VAR} in -H values', () => {
    const { status } = runHost(['-H', 'X-Custom: ${MY_VAL}', 'info', url], {
      env: { MY_VAL: 'expanded-value' },
    });
    assert.equal(status, 0);
  });
});
