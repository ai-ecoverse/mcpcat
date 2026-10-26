const enc = new TextEncoder();
const dec = new TextDecoder();
const SID = 'io.modelcontextprotocol/subscriptionId';

function chunk(text) {
  const bytes = enc.encode(text);
  return `${bytes.length.toString(16)}\r\n${text}\r\n`;
}

function sse(message) {
  const frame = `data: ${JSON.stringify(message)}\n\n`;
  const half = Math.floor(frame.length / 2);
  return chunk(frame.slice(0, half)) + chunk(frame.slice(half));
}

async function readRequest(reader) {
  let text = '';
  for (;;) {
    const end = text.indexOf('\r\n\r\n');
    if (end >= 0) {
      const length = Number(/content-length:\s*(\d+)/i.exec(text.slice(0, end))?.[1] ?? 0);
      if (text.length >= end + 4 + length) return JSON.parse(text.slice(end + 4, end + 4 + length));
    }
    const { done, value } = await reader.read();
    if (done) return undefined;
    text += dec.decode(value, { stream: true });
  }
}

async function serve(conn) {
  const reader = conn.readable.getReader();
  const writer = conn.writable.getWriter();
  const msg = await readRequest(reader);
  if (!msg) return conn.close();
  const json = (result) => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: msg.id,
      result: { resultType: 'complete', ...result },
    });
    return `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${enc.encode(body).length}\r\nconnection: close\r\n\r\n${body}`;
  };
  if (msg.method === 'server/discover') {
    await writer.write(
      enc.encode(
        json({
          supportedVersions: ['2026-07-28'],
          serverInfo: { name: 'chunked', version: '1' },
          capabilities: { extensions: { 'io.modelcontextprotocol/events': {} } },
        })
      )
    );
  } else if (msg.method === 'events/list') {
    await writer.write(enc.encode(json({ events: [{ name: 'tick', delivery: ['push'] }] })));
  } else {
    const note = (method, params) =>
      sse({
        jsonrpc: '2.0',
        method: `notifications/events/${method}`,
        params: { ...params, _meta: { [SID]: msg.id } },
      });
    await writer.write(
      enc.encode(
        'HTTP/1.1 200 OK\r\ncontent-type: text/event-stream\r\ntransfer-encoding: chunked\r\nconnection: close\r\n\r\n' +
          note('active', { cursor: 'c0', truncated: false })
      )
    );
    for (let n = 1; n <= 3; n++) {
      const event = {
        eventId: `e${n}`,
        name: 'tick',
        timestamp: 't',
        data: { n },
        cursor: `c${n}`,
      };
      try {
        await writer.write(enc.encode(note('event', event)));
      } catch {
        break;
      }
      await new Promise((r) => setTimeout(r, 20));
    }
    await writer.write(enc.encode('0\r\n\r\n')).catch(() => {});
  }
  try {
    await writer.close();
  } catch {}
  conn.close();
}

export default async function main(ctx) {
  const listener = await ctx.net.listen({ port: 0, host: '127.0.0.1' });
  await ctx.write(1, enc.encode(`${JSON.stringify({ port: listener.port })}\n`));
  let stop;
  const stopped = new Promise((r) => {
    stop = r;
  });
  ctx.signals.on('SIGTERM', () => {
    listener.close();
    stop();
  });
  void (async () => {
    for (;;) {
      let conn;
      try {
        conn = await listener.accept();
      } catch {
        return;
      }
      serve(conn).catch(() => {});
    }
  })();
  await stopped;
  return 0;
}
