import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mcpcatArgs } from './helpers/bin.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const fixturesDir = join(root, 'test/integration/fixtures');

function runHost(args, opts = {}) {
  const { cmd, args: cmdArgs } = mcpcatArgs(args);
  const r = spawnSync(cmd, cmdArgs, {
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

describe('M10: resources (2026 HTTP)', () => {
  let server;
  let url;
  before(async () => {
    server = await startFixtureServer('server-2026-http.mjs');
    url = `http://127.0.0.1:${server.port}`;
  });
  after(() => {
    server?.child.kill('SIGTERM');
  });

  it('resources lists resources and templates', () => {
    const { stdout, status } = runHost(['resources', url]);
    assert.equal(status, 0);
    assert.ok(stdout.includes('file:///readme.txt'));
    assert.ok(stdout.includes('readme'));
    assert.ok(stdout.includes('Templates:'));
    assert.ok(stdout.includes('file:///docs/{name}'));
  });

  it('resources --json returns JSON', () => {
    const { stdout, status } = runHost(['resources', url, '--json']);
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout);
    assert.ok(Array.isArray(parsed.resources));
    assert.ok(Array.isArray(parsed.resourceTemplates));
    assert.equal(parsed.resources.length, 2);
    assert.equal(parsed.resourceTemplates.length, 1);
  });

  it('read returns text content', () => {
    const { stdout, status } = runHost(['read', url, 'file:///readme.txt']);
    assert.equal(status, 0);
    assert.ok(stdout.includes('Hello from readme'));
  });

  it('read --json returns full result', () => {
    const { stdout, status } = runHost(['read', url, 'file:///readme.txt', '--json']);
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout);
    assert.ok(parsed.contents);
    assert.equal(parsed.contents[0].text, 'Hello from readme');
  });

  it('read blob resource outputs base64 without -o', () => {
    const { stdout, status } = runHost(['read', url, 'file:///logo.png']);
    assert.equal(status, 0);
    assert.ok(stdout.includes('iVBORw0KGgo='));
  });

  it('read blob resource writes to -o file', () => {
    const tmp = join(tmpdir(), `mcpcat-test-blob-${Date.now()}.png`);
    try {
      const { stdout, status } = runHost(['read', url, 'file:///logo.png', '-o', tmp]);
      assert.equal(status, 0);
      assert.ok(stdout.includes(tmp));
    } finally {
      try {
        unlinkSync(tmp);
      } catch {}
    }
  });

  it('read requires a URI', () => {
    const { stderr, status } = runHost(['read', url]);
    assert.equal(status, 2);
    assert.ok(stderr.includes('requires a URI'));
  });
});

describe('M10: prompts (2026 HTTP)', () => {
  let server;
  let url;
  before(async () => {
    server = await startFixtureServer('server-2026-http.mjs');
    url = `http://127.0.0.1:${server.port}`;
  });
  after(() => {
    server?.child.kill('SIGTERM');
  });

  it('prompts lists available prompts', () => {
    const { stdout, status } = runHost(['prompts', url]);
    assert.equal(status, 0);
    assert.ok(stdout.includes('greet'));
    assert.ok(stdout.includes('summarize'));
  });

  it('prompts --json returns JSON', () => {
    const { stdout, status } = runHost(['prompts', url, '--json']);
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout);
    assert.ok(Array.isArray(parsed.prompts));
    assert.equal(parsed.prompts.length, 2);
  });

  it('prompt renders messages', () => {
    const { stdout, status } = runHost(['prompt', url, 'greet', '-d', '{"name":"Alice"}']);
    assert.equal(status, 0);
    assert.ok(stdout.includes('[user]'));
    assert.ok(stdout.includes('Alice'));
  });

  it('prompt --json returns full result', () => {
    const { stdout, status } = runHost(['prompt', url, 'greet', '-d', '{"name":"Bob"}', '--json']);
    assert.equal(status, 0);
    const parsed = JSON.parse(stdout);
    assert.ok(parsed.messages);
    assert.ok(parsed.messages[0].content.text.includes('Bob'));
  });

  it('prompt requires a name', () => {
    const { stderr, status } = runHost(['prompt', url]);
    assert.equal(status, 2);
    assert.ok(stderr.includes('requires a name'));
  });
});

describe('M10: resources (stdio legacy)', () => {
  it('resources lists resources over stdio', () => {
    const cmd = `stdio:node ${join(fixturesDir, 'server-stdio-legacy.mjs')}`;
    const { stdout, status } = runHost(['resources', cmd]);
    assert.equal(status, 0);
    assert.ok(stdout.includes('file:///notes.txt'));
  });

  it('read returns text over stdio', () => {
    const cmd = `stdio:node ${join(fixturesDir, 'server-stdio-legacy.mjs')}`;
    const { stdout, status } = runHost(['read', cmd, 'file:///notes.txt']);
    assert.equal(status, 0);
    assert.ok(stdout.includes('These are notes'));
  });
});

describe('M10: prompts (stdio legacy)', () => {
  it('prompts lists prompts over stdio', () => {
    const cmd = `stdio:node ${join(fixturesDir, 'server-stdio-legacy.mjs')}`;
    const { stdout, status } = runHost(['prompts', cmd]);
    assert.equal(status, 0);
    assert.ok(stdout.includes('hello'));
  });

  it('prompt renders messages over stdio', () => {
    const cmd = `stdio:node ${join(fixturesDir, 'server-stdio-legacy.mjs')}`;
    const { stdout, status } = runHost(['prompt', cmd, 'hello', '-d', '{"name":"World"}']);
    assert.equal(status, 0);
    assert.ok(stdout.includes('Hello, World!'));
  });
});

describe('M10: elicitation (2026 HTTP)', () => {
  let server;
  let url;
  before(async () => {
    server = await startFixtureServer('server-2026-http.mjs');
    url = `http://127.0.0.1:${server.port}`;
  });
  after(() => {
    server?.child.kill('SIGTERM');
  });

  it('input_required without TTY exits 6 with JSON on stderr', () => {
    const { stderr, status } = runHost(['call', url, 'needs-input']);
    assert.equal(status, 6);
    assert.ok(stderr.includes('needs-input'));
    assert.ok(stderr.includes('input_required'));
  });

  it('--respond supplies answers on rerun', () => {
    const tmp = join(tmpdir(), `mcpcat-respond-${Date.now()}.json`);
    writeFileSync(tmp, JSON.stringify({ answer: 'forty-two' }));
    try {
      const { stdout, status } = runHost(['call', url, 'needs-input', '--respond', `@${tmp}`]);
      assert.equal(status, 0);
      assert.ok(stdout.includes('forty-two'));
    } finally {
      try {
        unlinkSync(tmp);
      } catch {}
    }
  });
});

describe('M10: info shows resource and prompt counts', () => {
  let server;
  let url;
  before(async () => {
    server = await startFixtureServer('server-2026-http.mjs');
    url = `http://127.0.0.1:${server.port}`;
  });
  after(() => {
    server?.child.kill('SIGTERM');
  });

  it('info shows capabilities including resources and prompts', () => {
    const { stdout, status } = runHost(['info', url]);
    assert.equal(status, 0);
    assert.ok(stdout.includes('resources'));
    assert.ok(stdout.includes('prompts'));
  });
});
