const EXT = 'io.modelcontextprotocol/events';
const SID = 'io.modelcontextprotocol/subscriptionId';
const STAMP = '2026-10-24T12:00:00Z';

const obj = (properties, required) => ({
  type: 'object',
  properties,
  ...(required ? { required } : {}),
});

const EVENTS = [
  {
    name: 'tick',
    description: 'A counter that ticks',
    delivery: ['push', 'poll'],
    inputSchema: obj({ label: { type: 'string' }, every: { type: 'integer' } }),
    payloadSchema: obj({ n: { type: 'integer' }, label: { type: 'string' } }),
  },
  {
    name: 'mail.received',
    description: 'Mail from a sender',
    delivery: ['poll'],
    inputSchema: obj({ from: { type: 'string' } }, ['from']),
    payloadSchema: obj({ from: { type: 'string' }, n: { type: 'integer' } }),
  },
  {
    name: 'flaky',
    description: 'Goes quiet after one event',
    delivery: ['push'],
    inputSchema: obj({ run: { type: 'string' } }, ['run']),
  },
  {
    name: 'closer',
    description: 'Closes the stream after each event',
    delivery: ['push'],
    inputSchema: obj({ run: { type: 'string' } }, ['run']),
  },
  { name: 'revoked', delivery: ['push'], inputSchema: obj({}) },
  { name: 'broken', delivery: ['push', 'poll'], inputSchema: obj({}) },
  { name: 'hook', delivery: ['webhook'], inputSchema: obj({}) },
  { name: 'tricky', delivery: ['push'], inputSchema: obj({}) },
  {
    name: 'nocursor',
    description: 'Events without a cursor after an active one',
    delivery: ['push'],
    inputSchema: obj({ run: { type: 'string' } }, ['run']),
  },
  { name: 'leaky', delivery: ['push'], inputSchema: obj({}) },
  {
    name: 'chatty',
    description: 'Stops heartbeating but keeps sending other notifications',
    delivery: ['push'],
    inputSchema: obj({ run: { type: 'string' } }, ['run']),
  },
];

const PAGE = 3;

function tickEvent(n, label, cursor = `c${n}`) {
  return {
    eventId: `tick-${n}`,
    name: 'tick',
    timestamp: STAMP,
    data: { n, ...(label !== undefined ? { label } : {}) },
    cursor,
  };
}

function startOf(params) {
  const cursor = params?.cursor ?? null;
  if (cursor === null) return { start: 0, truncated: false };
  if (cursor === 'stale') return { start: 100, truncated: true };
  if (typeof params?.maxAgeMs === 'number' && params.maxAgeMs < 1000) {
    return { start: 50, truncated: true };
  }
  const m = /^c(\d+)$/.exec(cursor);
  return m ? { start: Number(m[1]), truncated: false } : { start: 0, truncated: true };
}

export function createEventsServer({ advertise = true } = {}) {
  const runs = new Map();
  const live = new Map();
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

  function run(key) {
    if (!runs.has(key)) runs.set(key, { streams: 0 });
    return runs.get(key);
  }

  function poll(id, params) {
    const name = params?.name;
    if (name === 'broken') return fail(id, -32023, 'NotFound', { kind: 'event' });
    if (name === 'mail.received') {
      const { start } = startOf(params);
      if ((params?.cursor ?? null) === null)
        return reply(id, { events: [], cursor: 'c0', nextPollMs: 1 });
      const n = start + 1;
      const event = {
        eventId: `mail-${n}`,
        name,
        timestamp: STAMP,
        data: { from: params.arguments?.from, n },
      };
      return reply(id, { events: [event], cursor: `c${n}`, hasMore: false, nextPollMs: 1 });
    }
    if (name !== 'tick') {
      return fail(id, -32026, 'Unsupported', { feature: 'deliveryMode', value: 'poll' });
    }
    const { start, truncated } = startOf(params);
    if ((params?.cursor ?? null) === null || truncated) {
      return reply(id, { events: [], cursor: `c${start}`, truncated, nextPollMs: 1 });
    }
    const label = params.arguments?.label;
    const events = [tickEvent(start + 1, label, null), tickEvent(start + 2, label, null)].map(
      ({ cursor: _c, ...e }) => e
    );
    return reply(id, {
      events,
      cursor: `c${start + 2}`,
      truncated: false,
      hasMore: start % 4 === 0,
      nextPollMs: 1,
    });
  }

  function stream(id, params, sink, headers) {
    const name = params?.name;
    const tag = (p) => ({ ...p, _meta: { ...p._meta, [SID]: id } });
    const note = (method, p) => sink.send({ jsonrpc: '2.0', method, params: tag(p) });
    const timers = [];
    const every = (ms, fn) => timers.push(setInterval(fn, ms));
    const later = (ms, fn) => timers.push(setTimeout(fn, ms));
    const stop = () => {
      for (const t of timers) {
        clearInterval(t);
        clearTimeout(t);
      }
      live.delete(id);
    };
    live.set(id, stop);
    sink.onClose(stop);
    if (name === 'tick') {
      const { start, truncated } = startOf(params);
      let n = start;
      const label = params.arguments?.label;
      note('notifications/events/active', { cursor: `c${n}`, truncated });
      every(params.arguments?.every ?? 30, () => {
        n++;
        note('notifications/events/event', tickEvent(n, label));
      });
      every(100, () => note('notifications/events/heartbeat', { cursor: `c${n}` }));
      return;
    }
    if (name === 'flaky') {
      const state = run(`flaky:${params.arguments?.run}`);
      state.streams++;
      const cursor = params.cursor ?? null;
      note('notifications/events/active', { cursor: cursor ?? 'c0', truncated: false });
      if (state.streams === 1) {
        later(10, () =>
          note('notifications/events/event', {
            eventId: 'flaky-1',
            name,
            timestamp: STAMP,
            data: { stream: 1 },
            cursor: 'c1',
          })
        );
        return;
      }
      later(10, () =>
        note('notifications/events/event', {
          eventId: `flaky-${state.streams}`,
          name,
          timestamp: STAMP,
          data: { stream: state.streams, resumedFrom: cursor },
          cursor: `c${state.streams}`,
        })
      );
      every(50, () => note('notifications/events/heartbeat', { cursor: `c${state.streams}` }));
      return;
    }
    if (name === 'closer') {
      const state = run(`closer:${params.arguments?.run}`);
      state.streams++;
      const n = state.streams;
      note('notifications/events/active', { cursor: params.cursor ?? 'c0', truncated: false });
      later(10, () => {
        note('notifications/events/event', {
          eventId: `closer-${n}`,
          name,
          timestamp: STAMP,
          data: { stream: n, resumedFrom: params.cursor ?? null },
          cursor: `c${n}`,
        });
        later(10, () => {
          stop();
          sink.end({
            jsonrpc: '2.0',
            id,
            result: { resultType: 'complete', _meta: { [SID]: id } },
          });
        });
      });
      return;
    }
    if (name === 'revoked') {
      note('notifications/events/active', { cursor: null, truncated: false });
      later(10, () =>
        note('notifications/events/terminated', {
          error: { code: -32024, message: 'Forbidden', data: { reason: 'Access revoked' } },
        })
      );
      return;
    }
    if (name === 'nocursor') {
      const state = run(`nocursor:${params.arguments?.run}`);
      state.streams++;
      const n = state.streams;
      note('notifications/events/active', { cursor: params.cursor ?? 'c7', truncated: false });
      later(10, () =>
        note('notifications/events/event', {
          eventId: `nocursor-${n}`,
          name,
          timestamp: STAMP,
          data: { stream: n, resumedFrom: params.cursor ?? null },
        })
      );
      return;
    }
    if (name === 'leaky') {
      note('notifications/events/active', { cursor: null, truncated: false });
      later(10, () => {
        note('notifications/events/error', {
          error: { code: -32603, message: `upstream rejected ${headers?.['x-token'] ?? 'none'}` },
        });
        note('notifications/events/event', { eventId: 'l1', name, timestamp: STAMP, data: {} });
      });
      return;
    }
    if (name === 'chatty') {
      const state = run(`chatty:${params.arguments?.run}`);
      state.streams++;
      const n = state.streams;
      note('notifications/events/active', { cursor: params.cursor ?? 'c0', truncated: false });
      later(10, () =>
        note('notifications/events/event', {
          eventId: `chatty-${n}`,
          name,
          timestamp: STAMP,
          data: { stream: n },
          cursor: `c${n}`,
        })
      );
      every(50, () => {
        sink.send({
          jsonrpc: '2.0',
          method: 'notifications/message',
          params: { level: 'info', data: 'noise' },
        });
        sink.send({
          jsonrpc: '2.0',
          method: 'notifications/events/heartbeat',
          params: { cursor: 'c99', _meta: { [SID]: `other-${id}` } },
        });
        note('notifications/events/error', { error: { code: -32603, message: 'still here' } });
        note('notifications/events/unknown', {});
      });
      later(2000, () => {
        stop();
        sink.end({ jsonrpc: '2.0', id, result: { resultType: 'complete', _meta: { [SID]: id } } });
      });
      return;
    }
    if (name === 'tricky') {
      note('notifications/events/active', { cursor: null, truncated: false });
      const base = { name, timestamp: STAMP };
      later(10, () => {
        note('notifications/events/error', {
          error: { code: -32603, message: 'UpstreamError', data: { reason: 'flaky upstream' } },
        });
        note('notifications/events/event', {
          ...base,
          eventId: 'dup',
          data: { text: 'red \u001b[31m and \u009b csi' },
          cursor: null,
        });
        note('notifications/events/event', { ...base, eventId: 'dup', data: { again: true } });
        note('notifications/events/event', {
          ...base,
          eventId: 'tricky-2',
          data: { ok: true },
          _meta: { 'example.com/trace': 't1' },
        });
      });
    }
  }

  function handle(msg, headers, open) {
    const { id, method, params } = msg;
    if (method === 'notifications/cancelled') {
      live.get(params?.requestId)?.();
      return null;
    }
    if (id === undefined) return null;
    const caps = params?._meta?.['io.modelcontextprotocol/clientCapabilities'];
    const events = !!caps?.extensions?.[EXT];
    if (method === 'server/discover') {
      return reply(id, {
        supportedVersions: ['2026-07-28'],
        serverInfo: { name: 'events-srv', version: '1.0.0' },
        capabilities: { tools: {}, ...(advertise ? { extensions: { [EXT]: {} } } : {}) },
      });
    }
    if (method === 'tools/list') {
      return reply(id, {
        tools: [
          { name: events ? 'caps-events' : 'caps-none', inputSchema: obj({}) },
          { name: 'echo', inputSchema: obj({ experimental: { type: 'string' } }) },
        ],
      });
    }
    if (method === 'tools/call') {
      return reply(id, { content: [{ type: 'text', text: JSON.stringify(params.arguments) }] });
    }
    if (!method.startsWith('events/') || !advertise) return fail(id, -32601, 'Method not found');
    if (!events) return fail(id, -32021, 'Missing required client capability');
    if (method === 'events/list') {
      const from = params?.cursor === 'p2' ? PAGE : 0;
      const page = EVENTS.slice(from, from === 0 ? PAGE : undefined);
      return reply(id, { events: page, ...(from === 0 ? { nextCursor: 'p2' } : {}) });
    }
    if (headers && headers['mcp-name'] !== params?.name) {
      return fail(id, -32020, 'Mcp-Name mismatch');
    }
    if (!EVENTS.some((e) => e.name === params?.name)) {
      return fail(id, -32023, 'NotFound', { kind: 'event' });
    }
    if (method === 'events/poll') return poll(id, params);
    if (method === 'events/stream') {
      if (params.name === 'broken') return fail(id, -32023, 'NotFound', { kind: 'event' });
      stream(id, params, open(id), headers);
      return undefined;
    }
    return fail(id, -32601, 'Method not found');
  }

  return { handle };
}

export default async function main(ctx) {
  const server = createEventsServer({ advertise: !ctx.argv.includes('--no-events') });
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const reader = ctx.stdin.getReader();
  const writer = ctx.stdout.getWriter();
  let chain = Promise.resolve();
  const send = (msg) => {
    chain = chain
      .then(() => writer.write(encoder.encode(`${JSON.stringify(msg)}\n`)))
      .catch(() => {});
  };
  const open = () => ({ send, end: send, onClose() {} });
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const out = line.trim() ? server.handle(JSON.parse(line), undefined, open) : null;
        if (out) send(out);
        nl = buffer.indexOf('\n');
      }
    }
  } finally {
    reader.releaseLock();
  }
  await chain;
  writer.releaseLock();
  return 0;
}
