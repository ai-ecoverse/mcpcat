export default async function main(ctx) {
  const [, port, tool, pidFile, mode] = ctx.argv;
  const body = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: tool, arguments: {} },
  });
  const conn = await ctx.net.connect({ host: '127.0.0.1', port: Number(port) });
  const writer = conn.writable.getWriter();
  const head = [
    'POST /mcp HTTP/1.1',
    `host: 127.0.0.1:${port}`,
    'content-type: application/json',
    'accept: application/json, text/event-stream',
    `content-length: ${new TextEncoder().encode(body).length}`,
    '',
    '',
  ].join('\r\n');
  await writer.write(new TextEncoder().encode(head + body));
  while (!(await ctx.fs.exists(pidFile))) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  if (mode === 'hold') {
    const reader = conn.readable.getReader();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
    return 0;
  }
  conn.close();
  return 0;
}
