import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { mcpcatArgs } from './helpers/bin.mjs';
import { waitUntil } from './helpers/wait.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = join(here, 'fixtures');
const morphFixture = join(fixtures, 'events-morph-server.mjs');
const source = join(fixtures, 'event-source.mjs');
const X = ['--experimental', 'events'];
const SID = 'io.modelcontextprotocol/subscriptionId';
const hasOpenssl = spawnSync('openssl', ['version']).status === 0;
const hasPgrep = spawnSync('pgrep', ['-V']).error === undefined;

const home = mkdtempSync(join(tmpdir(), 'mcpcat-list-changed-'));
const env = {
  ...process.env,
  NODE_NO_WARNINGS: '1',
  HOME: home,
  PI_CODING_AGENT_DIR: join(home, 'agent'),
};
const children = [];
const servers = [];
after(() => {
  for (const c of children) c.kill('SIGKILL');
  for (const s of servers) {
    s.closeAllConnections();
    s.close();
  }
  rmSync(home, { recursive: true, force: true });
});

let files = 0;
const tmp = (name) => join(home, `${++files}-${name}`);

const lines = (text) =>
  text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

function client(args, extra = {}) {
  const { cmd, args: a } = mcpcatArgs(args);
  const child = spawn(cmd, a, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, ...extra },
    cwd: home,
  });
  children.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => {
    stdout += d.toString();
  });
  child.stderr.on('data', (d) => {
    stderr += d.toString();
  });
  const done = new Promise((resolve) =>
    child.on('exit', (status) => resolve({ stdout, stderr, status }))
  );
  return { child, done, stdout: () => stdout, stderr: () => stderr };
}

const run = (args, extra) => client(args, extra).done;

function logOf(path) {
  return existsSync(path) ? lines(readFileSync(path, 'utf8')) : [];
}

async function startMorph(extra) {
  const child = spawn(process.execPath, [morphFixture, '--http', ...extra], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  children.push(child);
  const port = await new Promise((resolve) => {
    child.stdout.once('data', (d) => resolve(JSON.parse(d.toString()).port));
  });
  return `http://127.0.0.1:${port}/mcp`;
}

function morphChecks(label, target) {
  it(`${label}: opens subscriptions/listen with eventsListChanged, and a payload change resubscribes from the last cursor`, async () => {
    const log = tmp('log');
    const r = await run([
      await target(['--change', 'payload', '--log', log]),
      ...X,
      '--count',
      '5',
      '--subscribe',
      'morph',
    ]);
    assert.equal(r.status, 0, r.stderr);
    const events = lines(r.stdout);
    assert.deepEqual(
      events.map((e) => e.eventId),
      ['m-1', 'm-2', 'm-3', 'm-4', 'm-5']
    );
    const notices = r.stderr.match(
      /changed its payload schema; resubscribing from the last cursor/g
    );
    assert.equal(notices?.length, 1, r.stderr);
    const entries = logOf(log);
    const listen = entries.filter((e) => e.method === 'subscriptions/listen');
    assert.equal(listen.length, 1);
    assert.deepEqual(listen[0].params.notifications, { eventsListChanged: true });
    const streams = entries.filter((e) => e.method === 'events/stream');
    assert.equal(streams.length, 2);
    assert.equal(streams[0].params.cursor, null);
    const resumed = Number(streams[1].params.cursor.slice(1));
    assert.ok(resumed >= 2 && resumed < 5, streams[1].params.cursor);
    assert.ok(entries.filter((e) => e.method === 'events/list').length >= 2);
  });

  it(`${label}: a delivery change that drops push switches to poll from the last cursor`, async () => {
    const log = tmp('log');
    const r = await run([
      await target(['--change', 'delivery', '--log', log]),
      ...X,
      '--count',
      '4',
      '--subscribe',
      'morph',
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(
      lines(r.stdout).map((e) => e.eventId),
      ['m-1', 'm-2', 'm-3', 'm-4']
    );
    assert.match(r.stderr, /event 'morph' changed its delivery modes; resubscribing/);
    const polls = logOf(log).filter((e) => e.method === 'events/poll');
    assert.ok(polls.length >= 1);
    assert.match(polls[0].params.cursor, /^c[2-3]$/);
  });

  it(`${label}: an event type that goes away ends the subscription with exit 5`, async () => {
    const r = await run([await target(['--change', 'gone']), ...X, '--subscribe', 'morph']);
    assert.equal(r.status, 5, r.stderr);
    assert.match(
      r.stderr,
      /mcpcat: event 'morph' is no longer offered by the server; the subscription has ended/
    );
  });

  it(`${label}: an inputSchema the arguments no longer satisfy exits 2`, async () => {
    const r = await run([
      await target(['--change', 'input']),
      ...X,
      '--subscribe',
      'morph',
      '--label',
      'hi',
    ]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(
      r.stderr,
      /event 'morph' changed its inputSchema and the subscription's arguments no longer validate \(argument label is not integer\)/
    );
  });

  it(`${label}: a change that does not matter to the subscription is quiet`, async () => {
    const log = tmp('log');
    const r = await run([
      await target(['--change', 'description', '--log', log]),
      ...X,
      '--count',
      '5',
      '--subscribe',
      'morph',
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(lines(r.stdout).length, 5);
    assert.equal(r.stderr, '');
    assert.equal(logOf(log).filter((e) => e.method === 'events/stream').length, 1);
  });

  it(`${label}: without listChanged nothing is opened, and a NotFound termination re-lists`, async () => {
    const log = tmp('log');
    const r = await run([
      await target(['--change', 'terminate', '--quiet', '--log', log]),
      ...X,
      '--subscribe',
      'morph',
    ]);
    assert.equal(r.status, 5, r.stderr);
    assert.match(r.stderr, /event 'morph' is no longer offered by the server/);
    const methods = logOf(log).map((e) => e.method);
    assert.ok(!methods.includes('subscriptions/listen'), methods.join(' '));
    assert.equal(methods.filter((m) => m === 'events/list').length, 2);
  });

  it(`${label}: an acknowledgement without eventsListChanged is named and the subscription goes on`, async () => {
    const r = await run([await target(['--no-ack']), ...X, '--count', '3', '--subscribe', 'morph']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(lines(r.stdout).length, 3);
    assert.match(
      r.stderr,
      /the server advertises listChanged but did not acknowledge eventsListChanged; event type changes will go unnoticed/
    );
  });

  it(`${label}: --list-events opens no subscriptions/listen`, async () => {
    const log = tmp('log');
    const r = await run([await target(['--log', log]), ...X, '--list-events']);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(
      logOf(log).map((e) => e.method),
      ['server/discover', 'events/list']
    );
  });

  it(`${label}: the webhook keeper refreshes at once after a payload change`, async () => {
    const log = tmp('log');
    const r = client([
      await target(['--change', 'payload', '--log', log]),
      ...X,
      '--webhook-url',
      'https://hooks.example.com/x',
      '--subscribe',
      'morph',
    ]);
    await waitUntil(
      () => logOf(log).filter((e) => e.method === 'events/subscribe').length >= 2,
      'a second events/subscribe',
      10_000
    );
    r.child.kill('SIGINT');
    const out = await r.done;
    assert.equal(out.status, 130, out.stderr);
    const subs = logOf(log).filter((e) => e.method === 'events/subscribe');
    assert.equal(subs[1].params.cursor, 'c0');
    assert.match(out.stderr, /changed its payload schema; resubscribing from the last cursor/);
    assert.ok(logOf(log).some((e) => e.method === 'events/unsubscribe'));
  });

  it(`${label}: the webhook keeper ends with exit 5 when its event type goes away`, async () => {
    const log = tmp('log');
    const r = await run([
      await target(['--change', 'gone', '--log', log]),
      ...X,
      '--webhook-url',
      'https://hooks.example.com/x',
      '--subscribe',
      'morph',
    ]);
    assert.equal(r.status, 5, r.stderr);
    assert.match(r.stderr, /event 'morph' is no longer offered by the server/);
    assert.ok(!logOf(log).some((e) => e.method === 'events/unsubscribe'));
  });

  it(`${label}: the webhook keeper exits 2 when webhook delivery goes away`, async () => {
    const r = await run([
      await target(['--change', 'delivery']),
      ...X,
      '--webhook-url',
      'https://hooks.example.com/x',
      '--subscribe',
      'morph',
    ]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /event 'morph' does not offer webhook delivery \(offers: poll\)/);
  });
}

describe('client: notifications/events/list_changed', () => {
  morphChecks('http', (extra) => startMorph(extra));
  morphChecks(
    'stdio',
    async (extra) =>
      `stdio:${[process.execPath, morphFixture, ...extra].map((a) => `'${a}'`).join(' ')}`
  );
});

async function startServe(args, extra = {}) {
  const { cmd, args: a } = mcpcatArgs(['serve', ...X, '--http', '0', '--no-auth', ...args]);
  const child = spawn(cmd, a, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, ...extra },
    cwd: home,
  });
  children.push(child);
  let stderr = '';
  const port = await new Promise((resolve, reject) => {
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      const m = /listening on http:\/\/[^:]+:(\d+)\/mcp/.exec(stderr);
      if (m) resolve(Number(m[1]));
    });
    child.on('exit', (code) => reject(new Error(`serve exited ${code}: ${stderr}`)));
  });
  return { child, port, url: `http://127.0.0.1:${port}/mcp`, stderr: () => stderr };
}

let ids = 0;
async function rpc(url, method, params = {}) {
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...(typeof params.name === 'string' ? { 'mcp-name': params.name } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++ids, method, params }),
  });
  return res.json();
}

async function sse(url, method, params) {
  const controller = new AbortController();
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      ...(typeof params.name === 'string' ? { 'mcp-name': params.name } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++ids, method, params }),
    signal: controller.signal,
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const next = async () => {
    for (;;) {
      const end = buf.indexOf('\n\n');
      if (end >= 0) {
        const block = buf.slice(0, end);
        buf = buf.slice(end + 2);
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (data) return JSON.parse(data);
        continue;
      }
      const { done, value } = await reader.read();
      if (done) return undefined;
      buf += dec.decode(value, { stream: true });
    }
  };
  const until = async (method) => {
    for (;;) {
      const frame = await next();
      if (!frame || frame.method === method || (method === 'result' && frame.result)) return frame;
    }
  };
  return { next, until, close: () => controller.abort() };
}

const tick = (extra = '') => `tick: node ${source} tick {label} 50 ${extra}`.trim();

describe('serve: --event-file and SIGHUP', () => {
  it('declares listChanged, acknowledges eventsListChanged and sends list_changed on SIGHUP', async () => {
    const file = tmp('events');
    writeFileSync(file, `# served events\n${tick()}\n\nshape: node ${source} quiet\n`);
    const serve = await startServe(['--event-file', file]);
    const discover = await rpc(serve.url, 'server/discover', {
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
    });
    assert.deepEqual(discover.result.capabilities.extensions, {
      'io.modelcontextprotocol/events': { listChanged: true },
    });
    const listen = await sse(serve.url, 'subscriptions/listen', {
      notifications: { eventsListChanged: true, toolsListChanged: true },
    });
    const ack = await listen.next();
    assert.equal(ack.method, 'notifications/subscriptions/acknowledged');
    assert.deepEqual(ack.params.notifications, { eventsListChanged: true });
    const stream = await sse(serve.url, 'events/stream', {
      name: 'shape',
      arguments: {},
      cursor: null,
    });
    assert.equal((await stream.next()).method, 'notifications/events/active');
    writeFileSync(file, `${tick()}\nnew: node ${source} quiet\n`);
    serve.child.kill('SIGHUP');
    const changed = await listen.next();
    assert.equal(changed.method, 'notifications/events/list_changed');
    assert.equal(changed.params._meta[SID], ack.params._meta[SID]);
    const ended = await stream.until('notifications/events/terminated');
    assert.deepEqual(ended.params.error, {
      code: -32023,
      message: 'event shape was removed',
      data: { kind: 'event' },
    });
    const list = await rpc(serve.url, 'events/list', {});
    assert.deepEqual(
      list.result.events.map((e) => e.name),
      ['tick', 'new']
    );
    await waitUntil(
      () => /SIGHUP: reloaded .*: added new; removed shape/.test(serve.stderr()),
      'log'
    );
    listen.close();
    serve.child.kill('SIGTERM');
  });

  it('a placeholder change terminates its streams with Unsupported schema_changed', async () => {
    const file = tmp('events');
    writeFileSync(file, `${tick()}\n`);
    const serve = await startServe(['--event-file', file]);
    const stream = await sse(serve.url, 'events/stream', {
      name: 'tick',
      arguments: { label: 'a' },
      cursor: null,
    });
    assert.equal((await stream.until('notifications/events/event')).params.data.label, 'a');
    writeFileSync(file, `tick: node ${source} tick {label} {every}\n`);
    serve.child.kill('SIGHUP');
    const ended = await stream.until('notifications/events/terminated');
    assert.deepEqual(ended.params.error.data, { feature: 'inputSchema', reason: 'schema_changed' });
    serve.child.kill('SIGTERM');
  });

  it('an unreadable or invalid file on SIGHUP keeps the event types', async () => {
    const file = tmp('events');
    writeFileSync(file, `${tick()}\n`);
    const serve = await startServe(['--event-file', file]);
    writeFileSync(file, 'bad name: x\n');
    serve.child.kill('SIGHUP');
    await waitUntil(
      () => /SIGHUP: invalid --event spec: bad name: x; the event types stay/.test(serve.stderr()),
      'the reload error'
    );
    rmSync(file);
    serve.child.kill('SIGHUP');
    await waitUntil(
      () => /SIGHUP: cannot read --event-file .*; the event types stay/.test(serve.stderr()),
      'the read error'
    );
    const list = await rpc(serve.url, 'events/list', {});
    assert.deepEqual(
      list.result.events.map((e) => e.name),
      ['tick']
    );
    assert.equal(serve.child.exitCode, null);
    serve.child.kill('SIGTERM');
  });

  it('without --event-file, SIGHUP still stops serve and listChanged is false', async () => {
    const serve = await startServe(['--event', tick()]);
    const discover = await rpc(serve.url, 'server/discover', {});
    assert.deepEqual(discover.result.capabilities.extensions, {
      'io.modelcontextprotocol/events': { listChanged: false },
    });
    const listen = await rpc(serve.url, 'subscriptions/listen', {
      notifications: { eventsListChanged: true },
    });
    assert.equal(listen.error.code, -32601);
    const exited = new Promise((r) => serve.child.once('exit', (code) => r(code)));
    serve.child.kill('SIGHUP');
    assert.equal(await exited, 129);
  });

  it('a missing --event-file at start exits 2, and --event-file needs --experimental events', async () => {
    const r = await run(['serve', ...X, '--event-file', join(home, 'missing')]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /cannot read --event-file .*missing/);
    const g = await run(['serve', '--event-file', join(home, 'missing')]);
    assert.equal(g.status, 2, g.stderr);
    assert.match(g.stderr, /--event-file and --webhook-allow need --experimental events/);
  });

  it('stdio: acknowledges listen and sends list_changed with its id on SIGHUP', async () => {
    const file = tmp('events');
    writeFileSync(file, `${tick()}\n`);
    const { cmd, args } = mcpcatArgs(['serve', ...X, '--event-file', file]);
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env, cwd: home });
    children.push(child);
    let out = '';
    child.stdout.on('data', (d) => {
      out += d.toString();
    });
    const frames = () => lines(out);
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 'L', method: 'subscriptions/listen', params: { notifications: { eventsListChanged: true } } })}\n`
    );
    await waitUntil(() => frames().length >= 1, 'the acknowledgement');
    assert.deepEqual(frames()[0].params, {
      _meta: { [SID]: 'L' },
      notifications: { eventsListChanged: true },
    });
    writeFileSync(file, `${tick()}\nmore: node ${source} quiet\n`);
    child.kill('SIGHUP');
    await waitUntil(() => frames().length >= 2, 'list_changed');
    assert.deepEqual(frames()[1], {
      jsonrpc: '2.0',
      method: 'notifications/events/list_changed',
      params: { _meta: { [SID]: 'L' } },
    });
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'L' } })}\n`
    );
    await sleep(100);
    writeFileSync(file, `${tick()}\n`);
    child.kill('SIGHUP');
    await sleep(300);
    assert.equal(frames().length, 2);
    child.stdin.end();
  });

  it('http client: a removed event ends the subscription with exit 5', async () => {
    const file = tmp('events');
    writeFileSync(file, `${tick()}\n`);
    const serve = await startServe(['--event-file', file]);
    const c = client([serve.url, ...X, '--subscribe', 'tick', '--label', 'a']);
    await waitUntil(() => lines(c.stdout()).length >= 2, 'two events');
    writeFileSync(file, `other: node ${source} quiet\n`);
    serve.child.kill('SIGHUP');
    const r = await c.done;
    assert.equal(r.status, 5, r.stderr);
    assert.match(
      r.stderr,
      /event 'tick' is no longer offered by the server; the subscription has ended/
    );
    serve.child.kill('SIGTERM');
  });

  it('http client: a new placeholder exits 2', async () => {
    const file = tmp('events');
    writeFileSync(file, `${tick()}\n`);
    const serve = await startServe(['--event-file', file]);
    const c = client([serve.url, ...X, '--subscribe', 'tick', '--label', 'a']);
    await waitUntil(() => lines(c.stdout()).length >= 2, 'two events');
    writeFileSync(file, `tick: node ${source} tick {label} {every}\n`);
    serve.child.kill('SIGHUP');
    const r = await c.done;
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /no longer validate \(missing required argument every\)/);
    serve.child.kill('SIGTERM');
  });

  it('http client: a new command for the same arguments keeps the subscription', async () => {
    const file = tmp('events');
    const pid = tmp('pid');
    writeFileSync(file, `${tick()}\n`);
    const serve = await startServe(['--event-file', file]);
    const c = client([serve.url, ...X, '--count', '6', '--subscribe', 'tick', '--label', 'a']);
    await waitUntil(() => lines(c.stdout()).length >= 2, 'two events');
    writeFileSync(file, `${tick(pid)}\n`);
    serve.child.kill('SIGHUP');
    const r = await c.done;
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stderr, '');
    const seqs = lines(r.stdout).map((e) => Number(e.cursor.split('.')[1]));
    assert.deepEqual(seqs, [1, 2, 3, 4, 5, 6]);
    assert.ok(existsSync(pid), 'the new command ran');
    serve.child.kill('SIGTERM');
  });

  it('stdio client: a removed event ends the subscription with exit 5', {
    skip: !hasPgrep && 'needs pgrep',
  }, async () => {
    const file = tmp('events');
    writeFileSync(file, `${tick()}\n`);
    const { cmd, args } = mcpcatArgs(['serve', ...X, '--event-file', file]);
    const target = `stdio:${[cmd, ...args].map((a) => `'${a}'`).join(' ')}`;
    const c = client([target, ...X, '--subscribe', 'tick', '--label', 'a']);
    await waitUntil(() => lines(c.stdout()).length >= 2, 'two events');
    const pids = execFileSync('pgrep', ['-f', `event-file ${file}`])
      .toString()
      .trim()
      .split('\n');
    writeFileSync(file, `other: node ${source} quiet\n`);
    for (const p of pids) process.kill(Number(p), 'SIGHUP');
    const r = await c.done;
    assert.equal(r.status, 5, r.stderr);
    assert.match(r.stderr, /event 'tick' is no longer offered by the server/);
  });
});

function makeCert(dir) {
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-keyout',
      join(dir, 'key.pem'),
      '-out',
      join(dir, 'cert.pem'),
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ],
    { stdio: 'ignore' }
  );
  return {
    key: readFileSync(join(dir, 'key.pem')),
    cert: readFileSync(join(dir, 'cert.pem')),
    path: join(dir, 'cert.pem'),
  };
}

describe('serve: webhook subscriptions on SIGHUP', { skip: !hasOpenssl && 'needs openssl' }, () => {
  it('a removed event sends a terminated envelope and drops the subscription', async () => {
    const tls = makeCert(mkdtempSync(join(home, 'tls-')));
    const deliveries = [];
    const server = createServer(tls, (req, res) => {
      const chunks = [];
      req.on('data', (d) => chunks.push(d));
      req.on('end', () => {
        deliveries.push({
          headers: req.headers,
          body: JSON.parse(Buffer.concat(chunks).toString()),
        });
        res.writeHead(200);
        res.end();
      });
    });
    servers.push(server);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = `https://127.0.0.1:${server.address().port}/`;
    const file = tmp('events');
    writeFileSync(file, `${tick()}\n`);
    const bearer = 'list-changed-token';
    const { cmd, args } = mcpcatArgs([
      'serve',
      ...X,
      '--http',
      '0',
      '--bearer',
      '${LIST_CHANGED_TOKEN}',
      '--event-file',
      file,
      '--webhook-allow',
      base,
    ]);
    const child = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...env, NODE_EXTRA_CA_CERTS: tls.path, LIST_CHANGED_TOKEN: bearer },
      cwd: home,
    });
    children.push(child);
    let stderr = '';
    const port = await new Promise((resolve, reject) => {
      child.stderr.on('data', (d) => {
        stderr += d.toString();
        const m = /listening on http:\/\/[^:]+:(\d+)\/mcp/.exec(stderr);
        if (m) resolve(Number(m[1]));
      });
      child.on('exit', (code) => reject(new Error(`serve exited ${code}: ${stderr}`)));
    });
    const params = {
      name: 'tick',
      arguments: { label: 'w' },
      delivery: {
        mode: 'webhook',
        url: `${base}w`,
        secret: `whsec_${Buffer.alloc(32, 7).toString('base64')}`,
      },
    };
    const call = async (method, p) => {
      const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          authorization: `Bearer ${bearer}`,
          'mcp-name': p.name,
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++ids, method, params: p }),
      });
      return res.json();
    };
    const sub = await call('events/subscribe', params);
    assert.match(sub.result.id, /^sub_/);
    await waitUntil(() => deliveries.length >= 2, 'two deliveries');
    writeFileSync(file, `other: node ${source} quiet\n`);
    child.kill('SIGHUP');
    await waitUntil(() => deliveries.some((d) => d.body.type === 'terminated'), 'terminated');
    const ended = deliveries.find((d) => d.body.type === 'terminated');
    assert.match(ended.headers['webhook-id'], /^msg_terminated_[0-9a-f]{32}$/);
    assert.equal(ended.headers['x-mcp-subscription-id'], sub.result.id);
    assert.deepEqual(ended.body.error.data, { kind: 'event' });
    const count = deliveries.length;
    await sleep(300);
    assert.equal(deliveries.length, count);
    const again = await call('events/unsubscribe', params);
    assert.equal(again.error.code, -32023);
    child.kill('SIGTERM');
  });
});
