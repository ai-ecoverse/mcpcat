import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import * as readline from 'node:readline';

const EXT = 'io.modelcontextprotocol/events';
const SID = 'io.modelcontextprotocol/subscriptionId';
const STAMP = '2026-10-24T12:00:00Z';
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const change = flag('--change') ?? 'none';
const logFile = flag('--log');
const quiet = argv.includes('--quiet');
const noAck = argv.includes('--no-ack');
const at = Number(flag('--at') ?? 2);

const obj = (properties, required) => ({
  type: 'object',
  properties,
  ...(required ? { required } : {}),
});

let morph = {
  name: 'morph',
  description: 'Changes shape after a few events',
  delivery: ['push', 'poll', 'webhook'],
  inputSchema: obj({ label: { type: 'string' } }),
  payloadSchema: obj({ n: { type: 'integer' } }),
};
const other = { name: 'other', delivery: ['poll'], inputSchema: obj({}) };
let present = true;
let changed = false;
let n = 0;
const listeners = new Map();
const streams = new Map();

const log = (entry) => {
  if (logFile) appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
};
const reply = (id, result) => ({
  jsonrpc: '2.0',
  id,
  result: { resultType: 'complete', ...result },
});
const fail = (id, code, message, data) => ({
  jsonrpc: '2.0',
  id,
  error: { code, message, ...(data ? { data } : {}) },
});
const occurrence = (k) => ({
  eventId: `m-${k}`,
  name: 'morph',
  timestamp: STAMP,
  data: { n: k },
  cursor: `c${k}`,
});

function mutate() {
  if (changed) return;
  changed = true;
  if (change === 'payload') {
    morph = { ...morph, payloadSchema: obj({ n: { type: 'integer' }, extra: { type: 'string' } }) };
  } else if (change === 'delivery') {
    morph = { ...morph, delivery: ['poll'] };
  } else if (change === 'input') {
    morph = { ...morph, inputSchema: obj({ label: { type: 'integer' } }) };
  } else if (change === 'description') {
    morph = { ...morph, description: 'Still the same contract' };
  } else if (change === 'gone' || change === 'terminate') {
    present = false;
  }
  if (change === 'terminate') {
    for (const [id, s] of streams) {
      s.send({
        jsonrpc: '2.0',
        method: 'notifications/events/terminated',
        params: {
          error: { code: -32023, message: 'NotFound', data: { kind: 'event' } },
          _meta: { [SID]: id },
        },
      });
    }
    return;
  }
  for (const [id, sink] of listeners) {
    sink.send({
      jsonrpc: '2.0',
      method: 'notifications/events/list_changed',
      params: { _meta: { [SID]: id } },
    });
  }
}

function start(params) {
  const m = /^c(\d+)$/.exec(params?.cursor ?? '');
  return m ? Number(m[1]) : n;
}

function stream(id, params, sink) {
  const tag = (p) => ({ ...p, _meta: { [SID]: id } });
  const note = (method, p) => sink.send({ jsonrpc: '2.0', method, params: tag(p) });
  let k = start(params);
  note('notifications/events/active', { cursor: `c${k}`, truncated: false });
  const timer = setInterval(() => {
    k++;
    n = Math.max(n, k);
    note('notifications/events/event', occurrence(k));
    if (k >= at) mutate();
  }, 40);
  const stop = () => {
    clearInterval(timer);
    streams.delete(id);
  };
  streams.set(id, { send: sink.send, stop });
  sink.onClose(stop);
}

function poll(id, params) {
  if (!params?.cursor) return reply(id, { events: [], cursor: `c${n}`, nextPollMs: 1 });
  const k = start(params) + 1;
  n = Math.max(n, k);
  if (k >= at) setTimeout(mutate, 0);
  return reply(id, {
    events: [occurrence(k)].map(({ cursor: _c, ...e }) => e),
    cursor: `c${k}`,
    hasMore: false,
    nextPollMs: 1,
  });
}

function handle(msg, open) {
  const { id, method, params } = msg;
  if (method === 'notifications/cancelled') {
    streams.get(params?.requestId)?.stop();
    listeners.delete(params?.requestId);
    return null;
  }
  if (id === undefined) return null;
  log({ method, params: { ...params, _meta: undefined } });
  if (method === 'server/discover') {
    return reply(id, {
      supportedVersions: ['2026-07-28'],
      serverInfo: { name: 'morph-srv', version: '1.0.0' },
      capabilities: { extensions: { [EXT]: quiet ? {} : { listChanged: true } } },
    });
  }
  if (method === 'subscriptions/listen') {
    const sink = open(id);
    const asked = params?.notifications?.eventsListChanged === true;
    listeners.set(id, sink);
    sink.onClose(() => listeners.delete(id));
    sink.send({
      jsonrpc: '2.0',
      method: 'notifications/subscriptions/acknowledged',
      params: {
        _meta: { [SID]: id },
        notifications: asked && !noAck ? { eventsListChanged: true } : {},
      },
    });
    return undefined;
  }
  if (method === 'events/list') return reply(id, { events: present ? [morph, other] : [other] });
  if (params?.name !== 'morph' || !present) return fail(id, -32023, 'NotFound', { kind: 'event' });
  if (method === 'events/poll') return poll(id, params);
  if (method === 'events/unsubscribe') return reply(id, {});
  if (method === 'events/subscribe') {
    setTimeout(mutate, 200);
    return reply(id, {
      id: 'sub_0000000000000001',
      refreshBefore: new Date(Date.now() + 60_000).toISOString(),
      cursor: 'c0',
      truncated: false,
    });
  }
  if (method === 'events/stream') {
    if (!morph.delivery.includes('push')) {
      return fail(id, -32026, 'Unsupported', { feature: 'deliveryMode', value: 'push' });
    }
    stream(id, params, open(id));
    return undefined;
  }
  return fail(id, -32601, 'Method not found');
}

if (argv.includes('--http')) {
  const http = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const msg = JSON.parse(Buffer.concat(chunks).toString());
      const open = () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.flushHeaders();
        const closers = [];
        res.on('close', () => {
          for (const fn of closers) fn();
        });
        return {
          send: (m) => res.write(`data: ${JSON.stringify(m)}\n\n`),
          onClose: (fn) => closers.push(fn),
        };
      };
      const out = handle(msg, open);
      if (out === undefined) return;
      if (!out) {
        res.writeHead(202);
        res.end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  http.listen(0, '127.0.0.1', () => {
    console.log(JSON.stringify({ port: http.address().port }));
  });
  process.on('SIGTERM', () => {
    http.closeAllConnections();
    http.close();
    process.exit(0);
  });
} else {
  const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
  const open = () => ({ send, onClose() {} });
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    const out = line.trim() ? handle(JSON.parse(line), open) : null;
    if (out) send(out);
  });
  rl.on('close', () => process.exit(0));
}
