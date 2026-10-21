const enc = new TextEncoder();

function request(port, tool, args) {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
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

export default async function main(ctx) {
  const [, port, tool, pidFile, mode, argsJson, lateTool, goFile] = ctx.argv;
  const args = argsJson ? JSON.parse(argsJson) : {};
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
