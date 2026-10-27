const enc = new TextEncoder();
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function drain(conn, pace = 0) {
  const reader = conn.readable.getReader();
  const dec = new TextDecoder();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text;
    text = (text + dec.decode(value, { stream: true })).slice(-65536);
    if (pace) await pause(pace);
  }
}

function last(text) {
  for (const block of text.split('\n\n').reverse()) {
    try {
      return JSON.stringify(JSON.parse(/^data: (.*)$/m.exec(block)?.[1]));
    } catch {}
  }
  return '';
}

export default async function main(ctx) {
  const [, port, servePid, label, wake] = ctx.argv;
  const conn = await ctx.net.connect({ host: '127.0.0.1', port: Number(port) });
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 9,
    method: 'events/stream',
    params: { name: 'tick', arguments: { label } },
  });
  const head = [
    'POST /mcp HTTP/1.1',
    `host: 127.0.0.1:${port}`,
    'content-type: application/json',
    'accept: text/event-stream',
    'mcp-name: tick',
    `content-length: ${enc.encode(body).length}`,
    '',
    '',
  ].join('\r\n');
  await conn.writable.getWriter().write(enc.encode(head + body));
  const [mode, ms] = wake.split(':');
  const reading = mode === 'read' ? drain(conn, Number(ms ?? 0)) : undefined;
  await pause(1500);
  await ctx.kill(Number(servePid), 'SIGTERM');
  const text = await (reading ?? pause(Number(wake)).then(() => drain(conn)));
  await ctx.write(1, enc.encode(`${last(text)}\n`));
  return 0;
}
