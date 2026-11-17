import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mcpcatArgs } from './helpers/bin.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const fake = join(root, 'test/integration/fixtures/fake-eval-attach.sh');
const home = join(tmpdir(), `mcpcat-annotations-${process.pid}-${Date.now()}`);
mkdirSync(home, { recursive: true });
const children = [];
let n = 0;

after(() => {
  for (const c of children) {
    try {
      c.kill('SIGKILL');
    } catch {}
  }
  rmSync(home, { recursive: true, force: true });
});

function scratch() {
  const dir = join(home, `case-${++n}`);
  mkdirSync(join(dir, 'tmp'), { recursive: true });
  return dir;
}

function env(dir, extra = {}) {
  return {
    ...process.env,
    NODE_NO_WARNINGS: '1',
    HOME: home,
    TMPDIR: join(dir, 'tmp'),
    FAKE_ATTACH_LOG: join(dir, 'log.jsonl'),
    ...extra,
  };
}

function readLog(dir) {
  const file = join(dir, 'log.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function run(args, environment) {
  const { cmd, args: cmdArgs } = mcpcatArgs(args);
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      cmdArgs,
      { encoding: 'utf8', timeout: 20_000, env: environment },
      (err, stdout, stderr) => resolve({ status: err ? (err.code ?? 1) : 0, stdout, stderr })
    );
    child.stdin.end();
  });
}

const ANNOTATION = {
  id: 'a1',
  kind: 'element',
  url: 'http://localhost:4789/',
  target: { name: 'Q3 Revenue', selector: 'article#card-revenue', tag: 'article' },
  metadata: { metricId: 'rev-q3' },
  comment: 'Roomier cards',
  controls: [
    {
      label: 'Card padding (pixels)',
      reference: '--card-padding',
      type: 'range',
      previous: 16,
      value: 24,
    },
  ],
};

async function serve(dir, extra = [], environment = {}) {
  const { cmd, args } = mcpcatArgs([
    '--experimental',
    'annotations',
    'serve',
    '--annotations',
    '--http',
    '0',
    '--no-auth',
    '--playwright-cli',
    fake,
    ...extra,
  ]);
  const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env: env(dir, environment) });
  children.push(child);
  let stderr = '';
  const port = await new Promise((resolve, reject) => {
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      const match = stderr.match(/listening on http:\/\/[^:]+:(\d+)\/mcp/);
      if (match) resolve(Number(match[1]));
    });
    child.on('exit', (code) => reject(new Error(`serve exited ${code}: ${stderr}`)));
  });
  let id = 0;
  const call = async (method, params) => {
    const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2025-11-25',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
    });
    const text = await res.text();
    const line = text.startsWith('{')
      ? text
      : text
          .split('\n')
          .find((l) => l.startsWith('data: '))
          ?.slice(6);
    return JSON.parse(line);
  };
  const tool = async (name, args = {}) => {
    const reply = await call('tools/call', { name, arguments: args });
    const text = reply.result?.content?.[0]?.text ?? '';
    const body = text.slice(text.indexOf('\n') + 1, text.lastIndexOf('\n'));
    return { reply, text, json: body.startsWith('{') ? JSON.parse(body) : undefined };
  };
  return { child, port, call, tool, stderr: () => stderr };
}

function stopped(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) resolve(child.exitCode);
    else child.on('exit', (code, signal) => resolve(code ?? signal));
  });
}

describe('serve --annotations', () => {
  it('needs --experimental annotations', async () => {
    const dir = scratch();
    const r = await run(['serve', '--annotations', '--playwright-cli', fake], env(dir));
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--annotations needs --experimental annotations/);
  });

  it('does not combine with --webmcp', async () => {
    const dir = scratch();
    const r = await run(
      [
        '--experimental',
        'annotations',
        'serve',
        '--annotations',
        '--webmcp',
        '--playwright-cli',
        fake,
      ],
      env(dir)
    );
    assert.equal(r.status, 2);
    assert.match(r.stderr, /does not combine/);
  });

  it('refuses a playwright-cli without eval-attach', async () => {
    const dir = scratch();
    const r = await run(
      ['--experimental', 'annotations', 'serve', '--annotations', '--playwright-cli', fake],
      env(dir, { FAKE_ATTACH_VERSION: '1.50.1' })
    );
    assert.equal(r.status, 2);
    assert.match(r.stderr, /needs playwright-cli 1\.51\.0 or newer/);
  });

  it('refuses mixed scopes', async () => {
    const dir = scratch();
    const r = await run(
      [
        '--experimental',
        'annotations',
        'serve',
        '--annotations',
        '--tab',
        'TAB1',
        '--annotations-host',
        'localhost',
        '--playwright-cli',
        fake,
      ],
      env(dir)
    );
    assert.equal(r.status, 2);
    assert.match(r.stderr, /choose one of --tab, --annotations-host or --annotations-match/);
  });

  it('attaches the page API in the main world and the editor in the isolated world', async () => {
    const dir = scratch();
    const s = await serve(dir, [
      '--annotations-host',
      'localhost',
      '--annotations-host',
      '*.example.com',
    ]);
    const listed = await s.call('tools/list', {});
    assert.deepEqual(
      listed.result.tools.map((t) => t.name),
      [
        'annotations_wait',
        'annotations_list',
        'annotations_take',
        'annotation_mode',
        'annotation_request',
      ]
    );
    const attaches = readLog(dir).filter((e) => e.command === 'eval-attach');
    assert.deepEqual(attaches.map((e) => e.world).sort(), ['isolated', 'main']);
    for (const entry of attaches) {
      assert.ok(entry.argv.includes('--host'));
      assert.deepEqual(
        entry.argv.filter((_, i) => entry.argv[i - 1] === '--host'),
        ['localhost', '*.example.com']
      );
      assert.notEqual(entry.session, undefined);
      assert.ok(entry.bytes > 1000);
    }
    assert.notEqual(attaches[0].session, attaches[1].session);
    const files = attaches.map((e) => e.file);
    for (const f of files) assert.ok(existsSync(f), f);
    assert.match(
      s.stderr(),
      /document\.oai\.annotation attached to hosts localhost, \*\.example\.com/
    );
    s.child.stdin.end();
    s.child.kill('SIGTERM');
    await stopped(s.child);
    for (const f of files) assert.equal(existsSync(f), false, `${f} removed on shutdown`);
    assert.deepEqual(
      readLog(dir)
        .filter((e) => e.command === 'stopped')
        .map((e) => e.world)
        .sort(),
      ['isolated', 'main']
    );
  });

  it('defaults to the current tab', async () => {
    const dir = scratch();
    const s = await serve(dir);
    const attach = readLog(dir).find((e) => e.command === 'eval-attach');
    assert.equal(attach.argv[attach.argv.indexOf('--tab') + 1], 'TAB1');
    s.child.kill('SIGTERM');
    await stopped(s.child);
  });

  it('lists saved annotations and waits for the user to send them', async () => {
    const dir = scratch();
    const messages = [
      { type: 'mode', active: true },
      { type: 'annotation', annotation: ANNOTATION },
      { type: 'annotation', annotation: { ...ANNOTATION, id: 'a2', comment: 'second' } },
      { type: 'annotation', annotation: { id: 'bad', kind: 'nope' } },
      {
        type: 'annotation',
        annotation: { ...ANNOTATION, id: 'huge', comment: 'x'.repeat(70_000) },
      },
    ];
    const s = await serve(dir, ['--tab', 'TAB1'], {
      FAKE_ATTACH_MESSAGES: JSON.stringify(messages),
    });
    await new Promise((r) => setTimeout(r, 300));
    const listed = await s.tool('annotations_list');
    assert.match(listed.text, /^<<untrusted-page-content id=[0-9a-f]+>>/);
    assert.equal(listed.reply.result._meta?.['io.mcpcat/untrusted'] ?? true, true);
    assert.equal(listed.json.mode, true);
    assert.deepEqual(
      listed.json.annotations.map((a) => [a.id, a.status]),
      [
        ['a1', 'saved'],
        ['a2', 'saved'],
      ]
    );
    assert.deepEqual(listed.json.documents, [
      { tab: 'TAB1', url: 'http://localhost:4789/', loaderId: 'L1' },
    ]);
    const empty = await s.tool('annotations_wait', { timeout_seconds: 0.2 });
    assert.equal(empty.json.timedOut, true);
    const taken = await s.tool('annotations_take');
    assert.equal(taken.json.annotations.length, 2);
    assert.equal((await s.tool('annotations_list')).json.annotations.length, 0);
    s.child.kill('SIGTERM');
    await stopped(s.child);
  });

  it('returns a sent batch from annotations_wait', async () => {
    const dir = scratch();
    const messages = [
      { type: 'annotation', annotation: ANNOTATION },
      { type: 'annotation', annotation: { ...ANNOTATION, id: 'a2' } },
      { type: 'discard', ids: ['a2'] },
      { type: 'submit', ids: ['a1'] },
      { type: 'mode', active: false },
    ];
    const s = await serve(dir, [], {
      FAKE_ATTACH_MESSAGES: JSON.stringify(messages),
      FAKE_ATTACH_DELAY: '800',
    });
    const waited = await s.tool('annotations_wait', { timeout_seconds: 10 });
    assert.deepEqual(
      waited.json.annotations.map((a) => [a.id, a.status, a.comment, a.controls[0].value]),
      [['a1', 'sent', 'Roomier cards', 24]]
    );
    assert.equal((await s.tool('annotations_list')).json.annotations.length, 0);
    s.child.kill('SIGTERM');
    await stopped(s.child);
  });

  it('installs the page API early with playwright-cli 1.52.0 and the editor late', async () => {
    const dir = scratch();
    const s = await serve(dir, ['--tab', 'TAB1'], { FAKE_ATTACH_VERSION: '1.52.0' });
    const attaches = readLog(dir).filter((e) => e.command === 'eval-attach');
    const byWorld = Object.fromEntries(attaches.map((e) => [e.world, e.argv.includes('--early')]));
    assert.deepEqual(byWorld, { main: true, isolated: false });
    assert.doesNotMatch(s.stderr(), /misses it/);
    s.child.kill('SIGTERM');
    await stopped(s.child);
  });

  it('reports a document the page API missed early', async () => {
    const dir = scratch();
    const s = await serve(dir, ['--tab', 'TAB1'], {
      FAKE_ATTACH_VERSION: '1.52.0',
      FAKE_ATTACH_LATE: '1',
    });
    const deadline = Date.now() + 5000;
    while (!/ran its first script before the page API/.test(s.stderr()) && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 50));
    assert.match(
      s.stderr(),
      /tab TAB1 ran its first script before the page API could be installed early; reload the tab to retry/
    );
    s.child.kill('SIGTERM');
    await stopped(s.child);
  });

  it('says the page API is late with playwright-cli 1.51.x', async () => {
    const dir = scratch();
    const s = await serve(dir, ['--tab', 'TAB1']);
    assert.ok(readLog(dir).every((e) => !e.argv.includes('--early')));
    assert.match(
      s.stderr(),
      /installs it after page scripts start.*1\.52\.0 or newer installs it first/
    );
    s.child.kill('SIGTERM');
    await stopped(s.child);
  });

  it('runs annotation_mode and annotation_request as eval in the attached tab', async () => {
    const dir = scratch();
    const s = await serve(dir, ['--annotations-match', 'http://localhost:4789/*']);
    await new Promise((r) => setTimeout(r, 200));
    const mode = await s.tool('annotation_mode', { active: true });
    assert.deepEqual(mode.json, { accepted: true });
    const request = await s.tool('annotation_request', {
      selector: '#delivery-summary',
      comment: 'Explain this delivery estimate.',
    });
    assert.deepEqual(request.json, { accepted: true });
    const evals = readLog(dir).filter((e) => e.command === 'eval');
    assert.equal(evals.length, 2);
    for (const e of evals) assert.equal(e.tab, 'TAB1');
    assert.match(evals[0].expression, /a\.toggle\(true\)/);
    assert.match(evals[1].expression, /document\.querySelector\("#delivery-summary"\)/);
    assert.match(evals[1].expression, /"initialComment":"Explain this delivery estimate\."/);
    const bad = await s.tool('annotation_request', { selector: '' });
    assert.equal(bad.reply.result.isError, true);
    const attach = readLog(dir).find((e) => e.command === 'eval-attach');
    assert.equal(attach.argv[attach.argv.indexOf('--match') + 1], 'http://localhost:4789/*');
    s.child.kill('SIGTERM');
    await stopped(s.child);
  });

  it('exits 3 when eval-attach refuses', async () => {
    const dir = scratch();
    const r = await run(
      [
        '--experimental',
        'annotations',
        'serve',
        '--annotations',
        '--tab',
        'TAB1',
        '--call-timeout',
        '2',
        '--playwright-cli',
        fake,
      ],
      env(dir, { FAKE_ATTACH_REFUSE: 'isolated' })
    );
    assert.equal(r.status, 3);
    assert.match(r.stderr, /eval-attach refused/);
    assert.match(r.stderr, /did not report ready/);
  });
});
