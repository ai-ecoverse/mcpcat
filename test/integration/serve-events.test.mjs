import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:https';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { mcpcatArgs } from './helpers/bin.mjs';
import { attachKernel, createNodeKernel } from './helpers/kernel.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const fixtures = join(here, 'fixtures');
const source = join(fixtures, 'event-source.mjs');
const X = ['--experimental', 'events'];
const SID = 'io.modelcontextprotocol/subscriptionId';
const hasOpenssl = spawnSync('openssl', ['version']).status === 0;

const home = mkdtempSync(join(tmpdir(), 'mcpcat-serve-events-'));
const env = {
  ...process.env,
  NODE_NO_WARNINGS: '1',
  HOME: home,
  PI_CODING_AGENT_DIR: join(home, 'agent'),
};
const children = [];
after(() => {
  for (const c of children) c.kill('SIGKILL');
  rmSync(home, { recursive: true, force: true });
});

let files = 0;
const tmp = (name) => join(home, `${++files}-${name}`);
const ev = (spec) => ['--event', spec];
const tickSpec = (ms = 50, pid = '') => `tick: node ${source} tick {label} ${ms} ${pid}`.trim();

function collect(child) {
  return new Promise((resolve) => {
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('exit', (status) =>
      resolve({
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        status,
      })
    );
  });
}

function run(args, extra = {}) {
  const { cmd, args: a } = mcpcatArgs(args);
  return collect(
    spawn(cmd, a, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, ...extra }, cwd: home })
  );
}

async function startServe(args, extra = {}) {
  const { cmd, args: a } = mcpcatArgs(['serve', ...X, '--http', '0', ...args]);
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
async function rpc(serve, method, params = {}, opts = {}) {
  const headers = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    ...(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}),
    ...(typeof params.name === 'string' && opts.name !== false ? { 'mcp-name': params.name } : {}),
    ...opts.headers,
  };
  const res = await fetch(serve.url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: ++ids, method, params }),
  });
  return { status: res.status, body: await res.json() };
}

async function openSse(serve, params, opts = {}) {
  const controller = new AbortController();
  const res = await fetch(serve.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      'mcp-name': params.name,
      ...(opts.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}),
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'events/stream', params }),
    signal: controller.signal,
  });
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  const frames = [];
  const next = async () => {
    for (;;) {
      const end = buf.indexOf('\n\n');
      if (end >= 0) {
        const block = buf.slice(0, end);
        buf = buf.slice(end + 2);
        const data = block
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trim())
          .join('\n');
        if (data) {
          const frame = JSON.parse(data);
          frames.push(frame);
          return frame;
        }
        continue;
      }
      const { done, value } = await reader.read();
      if (done) return undefined;
      buf += dec.decode(value, { stream: true });
    }
  };
  return { status: res.status, next, frames, close: () => controller.abort() };
}

const lines = (text) =>
  text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

function exitOf(child) {
  return new Promise((resolve) => child.once('exit', (code, signal) => resolve(signal ?? code)));
}

function lastFrame(text) {
  const blocks = text.split('\n\n').reverse();
  for (const block of blocks) {
    try {
      return JSON.parse(/^data: (.*)$/m.exec(block)?.[1]);
    } catch {}
  }
  return undefined;
}

async function stalledStream(serve, params) {
  const socket = connect(serve.port, '127.0.0.1');
  await new Promise((r) => socket.once('connect', r));
  const body = JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'events/stream', params });
  socket.write(
    `POST /mcp HTTP/1.1\r\nhost: 127.0.0.1:${serve.port}\r\ncontent-type: application/json\r\naccept: text/event-stream\r\nmcp-name: ${params.name}\r\ncontent-length: ${body.length}\r\n\r\n${body}`
  );
  socket.pause();
  let text = '';
  socket.on('data', (d) => {
    text = (text + d.toString()).slice(-65536);
  });
  socket.on('error', () => {});
  const closed = new Promise((r) => socket.once('close', r));
  return { socket, closed, last: () => lastFrame(text) };
}

function alive(pidFile) {
  if (!existsSync(pidFile)) return false;
  const pid = Number(readFileSync(pidFile, 'utf8'));
  if (!(pid > 0)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await sleep(25);
  }
  return false;
}

function clientChecks(label, target) {
  it(`${label}: --list-events shows the served event types`, async () => {
    const r = await run([target(), ...X, '--list-events', '--json']);
    assert.equal(r.status, 0, r.stderr);
    const [tick, shape] = JSON.parse(r.stdout).events;
    assert.equal(tick.name, 'tick');
    assert.deepEqual(tick.delivery, ['push', 'poll']);
    assert.deepEqual(tick.inputSchema.required, ['label']);
    assert.equal(tick.inputSchema.additionalProperties, false);
    assert.equal(shape.name, 'shape');
    assert.deepEqual(shape.inputSchema.required, []);
  });

  it(`${label}: push delivers the source's lines as events with cursors`, async () => {
    const r = await run([target(), ...X, '--count', '3', '--subscribe', 'tick', '--label', 'a']);
    assert.equal(r.status, 0, r.stderr);
    const events = lines(r.stdout);
    assert.deepEqual(
      events.map((e) => [e.name, e.data.n, e.data.label]),
      [
        ['tick', 1, 'a'],
        ['tick', 2, 'a'],
        ['tick', 3, 'a'],
      ]
    );
    assert.match(events[2].cursor, /^[0-9a-f]{12}\.3$/);
    assert.equal(events[2].eventId, events[2].cursor);
  });

  it(`${label}: poll delivers them too`, async () => {
    const r = await run([
      target(),
      ...X,
      '--delivery',
      'poll',
      '--count',
      '2',
      '--subscribe',
      'tick',
      '--label',
      'p',
    ]);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(
      lines(r.stdout).map((e) => [e.data.n, e.cursor]),
      [
        [1, undefined],
        [2, undefined],
      ]
    );
  });

  it(`${label}: JSON objects, envelopes and text lines become events`, async () => {
    const r = await run([target(), ...X, '--count', '4', '--subscribe', 'shape']);
    assert.equal(r.status, 0, r.stderr);
    const events = lines(r.stdout);
    assert.deepEqual(events[0].data, { x: 1 });
    assert.equal(events[0].eventId, 'up-1');
    assert.equal(events[0].timestamp, '2020-01-01T00:00:00Z');
    assert.deepEqual(events[1].data, { y: 2 });
    assert.deepEqual(events[2].data, { line: 'hello' });
    assert.deepEqual(events[3].data, { line: 'partial' });
  });
}

describe('host: serve --event', () => {
  const serveArgs = [
    ...X,
    '--event-poll',
    '0.05',
    ...ev(tickSpec()),
    ...ev(`shape: node ${source} shape`),
    ...ev(`crash: node ${source} crash`),
    ...ev(`quiet: node ${source} quiet`),
  ];
  let http;

  before(async () => {
    http = await startServe(['--no-auth', ...serveArgs.slice(2), '--event-heartbeat', '0.1']);
  });

  clientChecks('stdio', () => {
    const { cmd, args } = mcpcatArgs(['serve', ...serveArgs]);
    return `stdio:${[cmd, ...args].map((a) => `'${a}'`).join(' ')}`;
  });
  clientChecks('http', () => http.url);

  it('server/discover declares the events extension', async () => {
    const r = await rpc(http, 'server/discover', {
      _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' },
    });
    assert.deepEqual(r.body.result.capabilities.extensions, {
      'io.modelcontextprotocol/events': {},
    });
  });

  it('a source that exits is restarted and its events keep counting', async () => {
    const s = await openSse(http, { name: 'crash', arguments: {} });
    assert.equal((await s.next()).method, 'notifications/events/active');
    const nextEvent = async () => {
      let frame = await s.next();
      while (frame.method !== 'notifications/events/event') frame = await s.next();
      return frame;
    };
    const first = await nextEvent();
    const second = await nextEvent();
    s.close();
    assert.equal(first.params.cursor.split('.')[1], '1');
    assert.equal(second.params.cursor.split('.')[1], '2');
    assert.notEqual(first.params.data.pid, second.params.data.pid);
    assert.match(http.stderr(), /event source crash exited 3; restarting in 0\.5s/);
    assert.match(http.stderr(), /source crashed/);
  });

  it('a quiet stream gets heartbeats with the cursor, tagged with the request id', async () => {
    const s = await openSse(http, { name: 'quiet' });
    const active = await s.next();
    const beat = await s.next();
    s.close();
    assert.equal(active.params.truncated, false);
    assert.equal(beat.method, 'notifications/events/heartbeat');
    assert.equal(beat.params.cursor, active.params.cursor);
    assert.equal(beat.params._meta[SID], 7);
  });

  it('one source runs per distinct arguments, only while someone subscribes', async () => {
    const pid = tmp('pid');
    const serve = await startServe(['--no-auth', ...ev(tickSpec(50, pid))]);
    const a = await openSse(serve, { name: 'tick', arguments: { label: 'x' } });
    await a.next();
    const b = await openSse(serve, { name: 'tick', arguments: { label: 'x' } });
    await b.next();
    assert.ok(await until(() => alive(pid)));
    const firstPid = readFileSync(pid, 'utf8');
    a.close();
    await sleep(200);
    assert.equal(readFileSync(pid, 'utf8'), firstPid);
    assert.ok(alive(pid));
    b.close();
    assert.ok(await until(() => !alive(pid)), 'source stopped');
    serve.child.kill('SIGTERM');
  });

  it('a poll lease keeps the source and its buffer, so --cursor-file resumes', async () => {
    const file = tmp('cursor.json');
    const base = [http.url, ...X, '--delivery', 'poll', '--cursor-file', file];
    const a = await run([...base, '--count', '2', '--subscribe', 'tick', '--label', 'lease']);
    assert.equal(a.status, 0, a.stderr);
    const b = await run([...base, '--count', '2', '--subscribe', 'tick', '--label', 'lease']);
    assert.equal(b.status, 0, b.stderr);
    assert.deepEqual(
      [...lines(a.stdout), ...lines(b.stdout)].map((e) => e.data.n),
      [1, 2, 3, 4]
    );
    assert.doesNotMatch(b.stderr, /truncated/);
  });

  it('a stale cursor is truncated and resumes from what the buffer has', async () => {
    const r = await rpc(http, 'events/poll', { name: 'shape', arguments: {}, cursor: 'nope.9' });
    assert.equal(r.body.result.truncated, true);
    const s = await openSse(http, { name: 'shape', cursor: 'bad' });
    const active = await s.next();
    s.close();
    assert.equal(active.params.truncated, true);
  });

  it('events/poll bootstraps, pages with maxEvents and suggests nextPollMs', async () => {
    const p = { name: 'tick', arguments: { label: 'page' } };
    const boot = await rpc(http, 'events/poll', { ...p, cursor: null });
    assert.deepEqual(boot.body.result.events, []);
    assert.equal(boot.body.result.nextPollMs, 50);
    const ahead = `${boot.body.result.cursor.split('.')[0]}.3`;
    assert.ok(
      await until(async () => {
        const r = await rpc(http, 'events/poll', { ...p, cursor: ahead });
        return r.body.result.truncated === false;
      })
    );
    const page = await rpc(http, 'events/poll', {
      ...p,
      cursor: boot.body.result.cursor,
      maxEvents: 2,
    });
    assert.equal(page.body.result.events.length, 2);
    assert.equal(page.body.result.hasMore, true);
    assert.equal(page.body.result.resultType, 'complete');
  });

  for (const [params, code, message] of [
    [{}, -32602, /name is required/],
    [{ name: 'nope' }, -32023, /unknown event/],
    [{ name: 'tick' }, -32602, /missing argument: label/],
    [{ name: 'tick', arguments: { label: 1 } }, -32602, /must be a string/],
    [{ name: 'tick', arguments: { label: 'a', more: 'b' } }, -32602, /unknown argument: more/],
    [{ name: 'tick', arguments: [] }, -32602, /must be an object/],
    [{ name: 'shape', cursor: 3 }, -32602, /cursor must be/],
    [{ name: 'shape', cursor: 'x', maxAgeMs: -1 }, -32602, /maxAgeMs/],
    [{ name: 'shape', maxEvents: 0 }, -32602, /maxEvents/],
  ]) {
    it(`events/poll ${JSON.stringify(params)} answers ${code}`, async () => {
      const r = await rpc(http, 'events/poll', params);
      assert.equal(r.body.error.code, code);
      assert.match(r.body.error.message, message);
    });
  }

  it('events/stream errors are JSON-RPC errors, not streams', async () => {
    const r = await rpc(http, 'events/stream', { name: 'nope' });
    assert.equal(r.body.error.code, -32023);
    assert.deepEqual(r.body.error.data, { kind: 'event' });
  });

  it('a missing or wrong Mcp-Name is a 400 HeaderMismatch', async () => {
    const missing = await rpc(http, 'events/poll', { name: 'shape' }, { name: false });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.error.code, -32020);
    const wrong = await rpc(
      http,
      'events/poll',
      { name: 'shape' },
      { headers: { 'mcp-name': 'tick' } }
    );
    assert.equal(wrong.status, 400);
    const encoded = await rpc(
      http,
      'events/poll',
      { name: 'shape' },
      { headers: { 'mcp-name': `=?base64?${btoa('shape')}?=` } }
    );
    assert.equal(encoded.status, 200);
  });

  it('events/subscribe without --webhook-allow is Unsupported', async () => {
    const r = await rpc(http, 'events/subscribe', { name: 'shape' });
    assert.equal(r.body.error.code, -32026);
    assert.deepEqual(r.body.error.data, { feature: 'deliveryMode', value: 'webhook' });
  });

  it('an unknown events method is Method not found', async () => {
    const r = await rpc(http, 'events/nope');
    assert.equal(r.body.error.code, -32601);
  });

  for (const [signal, status] of [
    ['SIGTERM', 143],
    ['SIGINT', 130],
    ['SIGHUP', 129],
  ]) {
    it(`${signal} sends a reading subscriber the final stream result, stops the sources and exits ${status}`, async () => {
      const pid = tmp('pid');
      const serve = await startServe(['--no-auth', ...ev(tickSpec(50, pid))]);
      const exited = exitOf(serve.child);
      const s = await openSse(serve, { name: 'tick', arguments: { label: 'z' } });
      await s.next();
      assert.ok(await until(() => alive(pid)));
      serve.child.kill(signal);
      let frame = await s.next();
      while (frame?.method) frame = await s.next();
      assert.deepEqual(frame.result, { resultType: 'complete', _meta: { [SID]: 7 } });
      assert.equal(await s.next(), undefined);
      const code = await Promise.race([exited, sleep(5000).then(() => 'running')]);
      assert.equal(code, status, serve.stderr());
      assert.ok(await until(() => !alive(pid)), 'source stopped');
    });
  }

  for (const [label, wake] of [
    ['never reads again', undefined],
    ['reads again 200 ms later, so it gets the final result', 200],
  ]) {
    it(`SIGTERM with a push subscriber that stopped reading and ${label}: serve closes it and exits 143 (#513)`, async () => {
      const pid = tmp('pid');
      const serve = await startServe(['--no-auth', '--event-buffer', '5', ...ev(tickSpec(1, pid))]);
      const exited = exitOf(serve.child);
      const s = await stalledStream(serve, {
        name: 'tick',
        arguments: { label: 'x'.repeat(16384) },
      });
      assert.ok(await until(() => alive(pid)));
      await sleep(1500);
      const started = Date.now();
      serve.child.kill('SIGTERM');
      if (wake !== undefined) setTimeout(() => s.socket.resume(), wake);
      const code = await Promise.race([exited, sleep(5000).then(() => 'running')]);
      const elapsed = Date.now() - started;
      assert.equal(code, 143, serve.stderr());
      assert.ok(elapsed < 4000, `serve took ${elapsed} ms to exit`);
      assert.ok(await until(() => !alive(pid)), 'source stopped');
      s.socket.resume();
      assert.ok(await Promise.race([s.closed.then(() => true), sleep(3000)]), 'socket closed');
      if (wake !== undefined) {
        assert.deepEqual(s.last()?.result, { resultType: 'complete', _meta: { [SID]: 9 } });
      }
    });
  }

  it('stdio: stdin EOF stops the sources', async () => {
    const pid = tmp('pid');
    const { cmd, args } = mcpcatArgs(['serve', ...X, ...ev(tickSpec(50, pid))]);
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
    children.push(child);
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'events/stream', params: { name: 'tick', arguments: { label: 'e' } } })}\n`
    );
    assert.ok(await until(() => alive(pid)));
    child.stdin.end();
    const r = await collect(child);
    assert.equal(r.status, 0);
    assert.ok(await until(() => !alive(pid)));
    const frames = lines(r.stdout);
    assert.equal(frames[0].method, 'notifications/events/active');
    assert.equal(frames[0].params._meta[SID], 1);
  });

  it('stdio: notifications/cancelled ends a stream', async () => {
    const pid = tmp('pid');
    const { cmd, args } = mcpcatArgs(['serve', ...X, ...ev(tickSpec(50, pid))]);
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
    children.push(child);
    const send = (m) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...m })}\n`);
    send({ id: 1, method: 'events/stream', params: { name: 'tick', arguments: { label: 'c' } } });
    assert.ok(await until(() => alive(pid)));
    send({ method: 'notifications/cancelled', params: { requestId: 1 } });
    assert.ok(await until(() => !alive(pid)), 'source stopped after cancel');
    send({ id: 2, method: 'events/poll', params: { name: 'nope' } });
    child.stdin.end();
    const r = await collect(child);
    assert.equal(lines(r.stdout).at(-1).error.code, -32023);
  });

  for (const [signal, status] of [
    ['SIGTERM', 143],
    ['SIGINT', 130],
  ]) {
    it(`stdio: ${signal} with stdin open stops serve and its sources (exit ${status})`, async () => {
      const pid = tmp('pid');
      const { cmd, args } = mcpcatArgs(['serve', ...X, ...ev(tickSpec(50, pid))]);
      const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
      children.push(child);
      const done = collect(child);
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'events/stream', params: { name: 'tick', arguments: { label: 's' } } })}\n`
      );
      assert.ok(await until(() => alive(pid)));
      child.kill(signal);
      const exited = await Promise.race([done, sleep(5000).then(() => undefined)]);
      assert.ok(exited, `serve still running after ${signal}`);
      assert.equal(exited.status, status);
      assert.ok(await until(() => !alive(pid)), 'source stopped');
    });
  }

  it('stdio: SIGTERM with stdin open stops a serve without events too', async () => {
    const { cmd, args } = mcpcatArgs(['serve', '--tool', 'echo: echo {msg}']);
    const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env });
    children.push(child);
    const done = collect(child);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' })}\n`);
    await new Promise((r) => child.stdout.once('data', r));
    child.kill('SIGTERM');
    const exited = await Promise.race([done, sleep(5000).then(() => undefined)]);
    assert.ok(exited, 'serve still running after SIGTERM');
    assert.equal(exited.status, 143);
  });

  it('a stalled push subscriber gets a truncated gap, not an unbounded backlog', async () => {
    const count = 4000;
    const serve = await startServe([
      '--no-auth',
      '--event-buffer',
      '5',
      ...ev(`flood: node ${source} flood ${count} 4096`),
    ]);
    const socket = connect(serve.port, '127.0.0.1');
    await new Promise((r) => socket.once('connect', r));
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 9,
      method: 'events/stream',
      params: { name: 'flood' },
    });
    socket.write(
      `POST /mcp HTTP/1.1\r\nhost: 127.0.0.1:${serve.port}\r\ncontent-type: application/json\r\naccept: text/event-stream\r\nmcp-name: flood\r\ncontent-length: ${body.length}\r\n\r\n${body}`
    );
    socket.pause();
    await sleep(2500);
    let text = '';
    const frames = [];
    await new Promise((resolve) => {
      socket.on('data', (d) => {
        text += d.toString();
        let end = text.indexOf('\n\n');
        while (end >= 0) {
          const block = text.slice(0, end);
          text = text.slice(end + 2);
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (data) {
            const frame = JSON.parse(data);
            frames.push(frame);
            if (frame.params?.data?.n === count) resolve();
          }
          end = text.indexOf('\n\n');
        }
      });
      socket.resume();
    });
    socket.destroy();
    serve.child.kill('SIGTERM');
    const actives = frames.filter((f) => f.method === 'notifications/events/active');
    const events = frames.filter((f) => f.method === 'notifications/events/event');
    assert.ok(actives.length >= 2, 'a truncated active marks the gap');
    assert.equal(actives[1].params.truncated, true);
    assert.ok(
      events.length < count,
      `${events.length} of ${count} events were held for the subscriber`
    );
  });

  for (const [args, message] of [
    [['serve', ...ev('tick: x')], /--event and --webhook-allow need --experimental events/],
    [['serve', '--webhook-allow', 'https://a/'], /need --experimental events/],
    [
      ['serve', ...X, '--webhook-allow', 'https://a/'],
      /--webhook-allow needs at least one --event/,
    ],
    [
      ['serve', ...X, ...ev('tick: x'), '--webhook-allow', 'http://a/'],
      /needs an https URL prefix/,
    ],
    [['serve', ...X, ...ev('tick: x'), '--webhook-allow', 'https://a/hooks'], /ending in \//],
    [['serve', ...X, ...ev('bad name: x')], /invalid --event spec/],
    [['serve', ...X, ...ev('tick:')], /invalid --event spec/],
    [['serve', ...X, ...ev('t: x'), ...ev('t: y')], /duplicate --event name: t/],
    [
      ['serve', ...X, ...ev('t: x'), '--event-buffer', '0'],
      /--event-buffer needs a positive integer/,
    ],
    [['serve', ...X, ...ev('t: x'), '--event-heartbeat', 'x'], /--event-heartbeat needs/],
    [['serve', ...X, ...ev('t: x'), '--proxy', 'stdio:x'], /does not combine with --proxy/],
  ]) {
    it(`serve ${args.slice(1).join(' ')} exits 2`, async () => {
      const r = await run(args);
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, message);
    });
  }

  it('serve --help describes --event and --webhook-allow', async () => {
    const r = await run(['serve', '--help']);
    assert.match(r.stdout, /^ {2}--event '<name>: <cmd>' {4}Serve an event type/m);
    assert.match(r.stdout, /^ {2}--webhook-allow <prefix> {3}/m);
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

function receiver(tls) {
  const deliveries = [];
  const plan = new Map();
  const server = createServer(tls, (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      deliveries.push({ path: req.url, headers: req.headers, raw, body: JSON.parse(raw) });
      const queue = plan.get(req.url) ?? [];
      const step = queue.shift() ?? 200;
      const { status, delayMs } = typeof step === 'number' ? { status: step, delayMs: 0 } : step;
      setTimeout(() => {
        res.writeHead(status);
        res.end();
      }, delayMs);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: (path) => `https://127.0.0.1:${server.address().port}${path}`,
        deliveries,
        at: (path) => deliveries.filter((d) => d.path === path),
        plan: (path, statuses) => plan.set(path, [...statuses]),
        close: () => server.close(),
      })
    );
  });
}

const newSecret = () => `whsec_${randomBytes(32).toString('base64')}`;

function verifies(delivery, secret) {
  const key = Buffer.from(secret.slice(6), 'base64');
  const { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': sig } = delivery.headers;
  const want = `v1,${createHmac('sha256', key).update(`${id}.${ts}.${delivery.raw}`).digest('base64')}`;
  return sig.split(' ').includes(want);
}

describe('host: serve --event --webhook-allow', { skip: !hasOpenssl && 'needs openssl' }, () => {
  let tls;
  let hook;
  let serve;
  const bearer = 'serve-events-token';
  let pid;

  before(async () => {
    tls = makeCert(mkdtempSync(join(home, 'tls-')));
    hook = await receiver(tls);
    pid = tmp('pid');
    serve = await startServe(
      [
        '--bearer',
        '${SERVE_TOKEN}',
        ...ev(tickSpec(50, pid)),
        ...ev(`shape: node ${source} shape`),
        '--webhook-allow',
        hook.url('/ok/'),
        '--webhook-ttl',
        '30',
      ],
      { SERVE_TOKEN: bearer, NODE_EXTRA_CA_CERTS: tls.path }
    );
  });

  after(() => hook?.close());

  const sub = (path, extra = {}) => ({
    name: 'tick',
    arguments: { label: path },
    delivery: {
      mode: 'webhook',
      url: hook.url(`/ok/${path}`),
      secret: extra.secret ?? newSecret(),
    },
    ...extra,
  });
  const call = (method, params) => rpc(serve, method, params, { bearer });

  it('lists webhook as a delivery mode', async () => {
    const r = await call('events/list', {});
    assert.deepEqual(r.body.result.events[0].delivery, ['push', 'poll', 'webhook']);
  });

  it('delivers signed events with the subscription id and a cursor, and refreshes', async () => {
    const params = sub('a', { ttlMs: 60_000 });
    const r = await call('events/subscribe', params);
    const { id, refreshBefore, cursor, truncated } = r.body.result;
    assert.match(id, /^sub_[0-9a-f]{16}$/);
    assert.equal(truncated, false);
    assert.match(cursor, /\.0$/);
    const left = Date.parse(refreshBefore) - Date.now();
    assert.ok(left > 25_000 && left <= 30_000, `granted ${left}`);
    assert.ok(await until(() => hook.at('/ok/a').length >= 3));
    const [first] = hook.at('/ok/a');
    assert.ok(verifies(first, params.delivery.secret));
    assert.equal(first.headers['x-mcp-subscription-id'], id);
    assert.equal(first.headers['content-type'], 'application/json');
    assert.equal(first.headers['webhook-id'], first.body.eventId);
    assert.ok(Math.abs(Number(first.headers['webhook-timestamp']) - Date.now() / 1000) < 10);
    assert.deepEqual(first.body.data, { n: 1, label: 'a' });
    assert.match(first.body.cursor, /\.1$/);
    const again = await call('events/subscribe', params);
    assert.equal(again.body.result.id, id);
    assert.equal(again.body.result.deliveryStatus.active, true);
    assert.equal(again.body.result.deliveryStatus.lastError, null);
    assert.ok(again.body.result.deliveryStatus.lastDeliveryAt);
    assert.equal((await call('events/unsubscribe', params)).body.result.resultType, 'complete');
    const count = hook.at('/ok/a').length;
    await sleep(300);
    assert.ok(hook.at('/ok/a').length <= count + 1);
    const gone = await call('events/unsubscribe', params);
    assert.equal(gone.body.error.code, -32023);
    assert.deepEqual(gone.body.error.data, { kind: 'subscription' });
  });

  it('a rotated secret is signed alongside the old one', async () => {
    const params = sub('rot');
    await call('events/subscribe', params);
    const fresh = newSecret();
    await call('events/subscribe', { ...params, delivery: { ...params.delivery, secret: fresh } });
    const seen = hook.at('/ok/rot').length;
    assert.ok(await until(() => hook.at('/ok/rot').length > seen + 1));
    const last = hook.at('/ok/rot').at(-1);
    assert.ok(verifies(last, fresh));
    assert.ok(verifies(last, params.delivery.secret));
    assert.equal(last.headers['webhook-signature'].split(' ').length, 2);
    await call('events/unsubscribe', params);
  });

  it('retries a failed delivery and records the error, but drops a 410', async () => {
    hook.plan('/ok/retry', [500]);
    const params = { ...sub('retry'), name: 'shape', arguments: {} };
    await call('events/subscribe', params);
    assert.ok(await until(() => hook.at('/ok/retry').length >= 5));
    const ids = hook.at('/ok/retry').map((d) => d.body.eventId);
    assert.equal(ids[0], 'up-1');
    assert.equal(ids[1], 'up-1');
    assert.notEqual(hook.at('/ok/retry')[0].headers['webhook-signature'], undefined);
    await call('events/unsubscribe', params);
    hook.plan('/ok/gone', [410]);
    const gone = { ...sub('gone'), name: 'shape', arguments: {} };
    await call('events/subscribe', gone);
    assert.ok(await until(() => hook.at('/ok/gone').length >= 4));
    assert.notEqual(hook.at('/ok/gone')[0].body.eventId, hook.at('/ok/gone')[1].body.eventId);
    await call('events/unsubscribe', gone);
  });

  it('an endpoint that falls behind gets a gap notice, not an unbounded queue', async () => {
    const slow = await startServe(
      [
        '--bearer',
        '${SERVE_TOKEN}',
        '--event-buffer',
        '5',
        ...ev(`burst: node ${source} burst 50`),
        '--webhook-allow',
        hook.url('/ok/'),
      ],
      { SERVE_TOKEN: bearer, NODE_EXTRA_CA_CERTS: tls.path }
    );
    hook.plan('/ok/slow', [{ status: 200, delayMs: 1500 }]);
    const secret = newSecret();
    const params = {
      name: 'burst',
      arguments: {},
      delivery: { url: hook.url('/ok/slow'), secret },
    };
    const r = await rpc(slow, 'events/subscribe', params, { bearer });
    assert.match(r.body.result.id, /^sub_/);
    assert.ok(await until(() => hook.at('/ok/slow').some((d) => d.body.data?.n === 50), 10_000));
    const bodies = hook.at('/ok/slow').map((d) => d.body);
    const gap = hook.at('/ok/slow').find((d) => d.body.type === 'gap');
    assert.ok(gap, 'a gap envelope was posted');
    assert.match(gap.headers['webhook-id'], /^msg_gap_[0-9a-f]{16}$/);
    assert.ok(verifies(gap, secret));
    assert.match(gap.body.cursor, /\.\d+$/);
    assert.ok(bodies.length < 50, `${bodies.length} deliveries`);
    slow.child.kill('SIGTERM');
  });

  it('a subscription that is not refreshed expires, and its source stops', async () => {
    const params = sub('ttl', { ttlMs: 1000 });
    const r = await call('events/subscribe', params);
    assert.ok(Date.parse(r.body.result.refreshBefore) - Date.now() <= 1000);
    assert.ok(await until(() => alive(pid)));
    await sleep(1300);
    const count = hook.at('/ok/ttl').length;
    await sleep(300);
    assert.equal(hook.at('/ok/ttl').length, count);
    assert.ok(await until(() => !alive(pid)), 'source stopped');
    const fresh = await call('events/subscribe', params);
    assert.equal(fresh.body.result.deliveryStatus, undefined);
    await call('events/unsubscribe', params);
  });

  for (const [label, mutate, code, message] of [
    [
      'a URL that leaves the allowed path',
      (p) => ({ ...p, delivery: { ...p.delivery, url: hook.url('/ok/../other') } }),
      -32027,
      /--webhook-allow/,
    ],
    [
      'an http URL',
      (p) => ({ ...p, delivery: { ...p.delivery, url: 'http://127.0.0.1/ok/x' } }),
      -32602,
      /https URL/,
    ],
    [
      'a URL outside --webhook-allow',
      (p) => ({ ...p, delivery: { ...p.delivery, url: hook.url('/other') } }),
      -32027,
      /--webhook-allow/,
    ],
    [
      'a short secret',
      (p) => ({ ...p, delivery: { ...p.delivery, secret: 'whsec_c2hvcnQ=' } }),
      -32602,
      /whsec_/,
    ],
    [
      'a secret without whsec_',
      (p) => ({ ...p, delivery: { ...p.delivery, secret: 'abc' } }),
      -32602,
      /whsec_/,
    ],
    ['no delivery', ({ delivery: _d, ...p }) => p, -32602, /delivery is required/],
    [
      'another mode',
      (p) => ({ ...p, delivery: { ...p.delivery, mode: 'push' } }),
      -32602,
      /mode must be webhook/,
    ],
    ['a bad ttlMs', (p) => ({ ...p, ttlMs: 'x' }), -32602, /ttlMs/],
  ]) {
    it(`events/subscribe with ${label} answers ${code}`, async () => {
      const r = await call('events/subscribe', mutate(sub('bad')));
      assert.equal(r.body.error.code, code, JSON.stringify(r.body));
      assert.match(r.body.error.message, message);
    });
  }

  it('webhook delivery needs an authenticated client', async () => {
    const open = await startServe([
      '--no-auth',
      ...ev(tickSpec()),
      '--webhook-allow',
      hook.url('/ok/'),
    ]);
    const r = await rpc(open, 'events/subscribe', sub('anon'));
    assert.equal(r.body.error.code, -32024);
    open.child.kill('SIGTERM');
  });

  it('stdio serves webhook delivery to its own client', async () => {
    const { cmd, args } = mcpcatArgs([
      'serve',
      ...X,
      ...ev(`shape: node ${source} shape`),
      '--webhook-allow',
      hook.url('/ok/'),
    ]);
    const child = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...env, NODE_EXTRA_CA_CERTS: tls.path },
    });
    children.push(child);
    const params = { ...sub('stdio'), name: 'shape', arguments: {} };
    child.stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'events/subscribe', params })}\n`
    );
    assert.ok(await until(() => hook.at('/ok/stdio').length >= 4));
    assert.ok(verifies(hook.at('/ok/stdio')[0], params.delivery.secret));
    child.stdin.end();
    const r = await collect(child);
    assert.match(lines(r.stdout)[0].result.id, /^sub_/);
  });
});

describe('kernel: serve --event', () => {
  let kernel;
  let client;
  let serve;
  let address;

  async function install(name, command, module, data) {
    await kernel.writeFile(`/node_modules/${name}/${module}`, data);
    await kernel.writeFile(
      `/node_modules/${name}/package.json`,
      JSON.stringify({
        name,
        version: pkg.version,
        type: 'module',
        slicc: { commands: { [command]: { abi: 'js', module } } },
      })
    );
  }

  before(async () => {
    kernel = await createNodeKernel({});
    await install(
      '@ai-ecoverse/mcpcat',
      'mcpcat',
      'dist/kernel/mcpcat.mjs',
      readFileSync(join(root, 'dist/kernel/mcpcat.mjs'))
    );
    await kernel.writeFile(
      '/node_modules/@ai-ecoverse/mcpcat/dist/quickjs.wasm',
      readFileSync(join(root, 'dist/quickjs.wasm'))
    );
    await install(
      '@ai-ecoverse/mcpcat-test-chunked-events',
      'chunked-events',
      'dist/server.mjs',
      readFileSync(join(fixtures, 'kernel-chunked-events.mjs'))
    );
    await install(
      '@ai-ecoverse/mcpcat-test-event-source',
      'event-src',
      'dist/src.mjs',
      readFileSync(join(fixtures, 'kernel-event-source.mjs'))
    );
    await install(
      '@ai-ecoverse/mcpcat-test-event-stall',
      'event-stall',
      'dist/stall.mjs',
      readFileSync(join(fixtures, 'kernel-event-stall.mjs'))
    );
    client = await attachKernel(await kernel.connect());
    serve = await startKernelServe(ev('tick: event-src tick {label} 50'));
    address = serve.address;
  });

  after(async () => {
    serve?.sp.signal('SIGTERM');
    await serve?.sp.exited;
    client?.close();
    kernel?.terminate();
  });

  async function startKernelServe(args) {
    const dec = new TextDecoder();
    let out = '';
    let err = '';
    let ready;
    const line = new Promise((r) => {
      ready = r;
    });
    const check = () => {
      if (out.includes('\n') && err.includes('listening')) ready(out.split('\n')[0]);
    };
    const sp = await client.spawn(
      ['mcpcat', 'serve', ...X, '--http', '0', '--no-auth', '--json', ...args],
      {
        stdin: 'pipe',
        onStdout(c) {
          out += dec.decode(c, { stream: true });
          check();
        },
        onStderr(c) {
          err += dec.decode(c, { stream: true });
          check();
        },
      }
    );
    const parsed = JSON.parse(await line);
    return { sp, address: parsed, port: new URL(parsed.loopbackUrl).port, stderr: () => err };
  }

  const krun = (args) =>
    kernel.run(['mcpcat', ...args], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { PI_CODING_AGENT_DIR: '/etc/mcpcat-serve-events' },
    });

  it('a kernel client reads a chunked event stream from a kernel server', async () => {
    const dec = new TextDecoder();
    let out = '';
    let ready;
    const line = new Promise((r) => {
      ready = r;
    });
    const server = client.spawn(['chunked-events'], {
      stdin: 'pipe',
      onStdout(c) {
        out += dec.decode(c, { stream: true });
        if (out.includes('\n')) ready(JSON.parse(out.split('\n')[0]));
      },
    });
    const { port } = await line;
    const r = await krun([
      `http://${port}.kernel.localhost/mcp`,
      ...X,
      '--heartbeat-timeout',
      '2',
      '--count',
      '3',
      '--subscribe',
      'tick',
    ]);
    const sp = await server;
    sp.signal('SIGTERM');
    await sp.exited;
    assert.equal(r.status, 0, String(r.stderr));
    assert.deepEqual(
      lines(String(r.stdout)).map((e) => e.data.n),
      [1, 2, 3]
    );
  });

  for (const [label, target] of [
    ['stdio', () => `stdio:mcpcat serve ${X.join(' ')} --event 'tick: event-src tick {label} 50'`],
    ['http', () => address.url],
  ]) {
    for (const delivery of ['push', 'poll']) {
      it(`${label}: ${delivery} delivers the source's lines`, async () => {
        const r = await krun([
          target(),
          ...X,
          '--delivery',
          delivery,
          '--count',
          '2',
          '--subscribe',
          'tick',
          '--label',
          'k',
        ]);
        assert.equal(r.status, 0, String(r.stderr));
        assert.deepEqual(
          lines(String(r.stdout)).map((e) => [e.data.n, e.data.label]),
          [
            [1, 'k'],
            [2, 'k'],
          ]
        );
      });
    }
  }

  for (const [label, wake, final] of [
    ['reads all along gets the final result', 'read', true],
    ['stopped reading and reads again 300 ms later gets the final result', '300', true],
    ['stopped reading and comes back after serve is gone', '4000', false],
  ]) {
    it(`http: SIGTERM with a push subscriber that ${label}, and serve exits 143 (#513)`, async () => {
      const name = `stall-${wake}-${'x'.repeat(4096)}`;
      const k = await startKernelServe([
        '--event-buffer',
        '5',
        ...ev('tick: event-src tick {label} 1'),
      ]);
      const started = Date.now();
      const subscriber = kernel.run(['event-stall', k.port, String(k.sp.pid), name, wake], {
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const status = await Promise.race([k.sp.exited, sleep(6000).then(() => 'running')]);
      const elapsed = Date.now() - started;
      const r = await subscriber;
      assert.equal(status, 143, k.stderr());
      assert.ok(elapsed < 4500, `serve took ${elapsed} ms to exit`);
      assert.equal(r.status, 0, String(r.stderr));
      const frame = JSON.parse(String(r.stdout).trim() || 'null');
      assert.equal(frame?.result?.resultType === 'complete', final, String(r.stdout).slice(0, 300));
      assert.ok(
        await until(async () => !(await client.ps()).some((p) => p.argv.includes(name))),
        'source stopped'
      );
    });
  }
});
