const enc = new TextEncoder();

function request(port, tool, args, id = 1) {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name: tool, arguments: args },
  });
  const head = [
    'POST /mcp HTTP/1.1',
    `host: 127.0.0.1:${port}`,
    'content-type: application/json',
    'accept: application/json, text/event-stream',
    `content-length: ${enc.encode(body).length}`,
    '',
    '',
  ].join('\r\n');
  return enc.encode(head + body);
}

async function until(ctx, file) {
  while (!(await ctx.fs.exists(file))) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function drain(conn) {
  const reader = conn.readable.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) return;
  }
}

function complete(text) {
  let count = 0;
  let rest = text;
  for (;;) {
    const end = rest.indexOf('\r\n\r\n');
    if (end < 0) return count;
    const length = Number(/content-length:\s*(\d+)/i.exec(rest.slice(0, end))?.[1] ?? 0);
    if (rest.length < end + 4 + length) return count;
    count += 1;
    rest = rest.slice(end + 4 + length);
  }
}

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pipeline(ctx, port, tool, pidFile, args, secondTool) {
  const conn = await ctx.net.connect({ host: '127.0.0.1', port: Number(port) });
  const writer = conn.writable.getWriter();
  await writer.write(request(port, tool, {}));
  await until(ctx, pidFile);
  const second = request(port, secondTool, args, 2);
  const split = new TextDecoder().decode(second).indexOf('\r\n\r\n') + 4;
  const middle = split + Math.floor((second.length - split) / 2);
  await writer.write(second.slice(0, split));
  await pause(200);
  await writer.write(second.slice(split, middle));
  await pause(200);
  await writer.write(second.slice(middle));
  const reader = conn.readable.getReader();
  const dec = new TextDecoder();
  let received = '';
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ done: true }), 10_000);
  });
  while (complete(received) < 2) {
    const { done, value } = await Promise.race([reader.read(), deadline]);
    if (done) break;
    received += dec.decode(value, { stream: true });
  }
  clearTimeout(timer);
  conn.close();
  await ctx.write(1, enc.encode(received));
  return 0;
}

export default async function main(ctx) {
  const [, port, tool, pidFile, mode, argsJson, lateTool, goFile] = ctx.argv;
  const args = argsJson ? JSON.parse(argsJson) : {};
  if (mode === 'pipeline') return pipeline(ctx, port, tool, pidFile, args, lateTool);
  if (mode === 'late') {
    const idle = await ctx.net.connect({ host: '127.0.0.1', port: Number(port) });
    const conn = await ctx.net.connect({ host: '127.0.0.1', port: Number(port) });
    await conn.writable.getWriter().write(request(port, tool, args));
    await until(ctx, pidFile);
    await ctx.fs.writeFile(`${pidFile}.ready`, 'ready');
    await until(ctx, goFile);
    await idle.writable.getWriter().write(request(port, lateTool, {}));
    await Promise.all([drain(conn), drain(idle)]);
    return 0;
  }
  const conn = await ctx.net.connect({ host: '127.0.0.1', port: Number(port) });
  const writer = conn.writable.getWriter();
  await writer.write(request(port, tool, args));
  await until(ctx, pidFile);
  if (mode === 'hold') {
    await drain(conn);
    return 0;
  }
  if (mode === 'extra') await writer.write(enc.encode('POST /mcp HTTP/1.1\r\n'));
  conn.close();
  return 0;
}
