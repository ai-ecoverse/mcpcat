export default async function main(ctx) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const pidFile = ctx.env.PID_RECORD_FILE;

  const child = await ctx.spawn({
    argv: [ctx.env.GRANDCHILD ?? 'mcpcat-test-sleeper'],
    stdin: 'null',
    stdout: 'null',
    stderr: 'null',
  });

  if (pidFile) {
    let before = '';
    try {
      before = decoder.decode(await ctx.fs.readFile(pidFile));
    } catch {}
    await ctx.fs.writeFile(pidFile, `${before}server:${ctx.pid}\ngrandchild:${child.pid}\n`);
  }

  const result = (id, value) => JSON.stringify({ jsonrpc: '2.0', id, result: value });
  const error = (id, code, message) =>
    JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });

  let crash = false;
  function handleLine(line) {
    if (!line.trim()) return null;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return error(null, -32700, 'Parse error');
    }
    const { id, method, params } = parsed;
    if (method === 'notifications/initialized') return null;
    switch (method) {
      case 'initialize':
        return result(id, {
          protocolVersion: '2025-11-25',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'test-kernel-crash-pidtrack', version: '1.0.0' },
        });
      case 'tools/list':
        return result(id, {
          tools: [
            {
              name: 'crash',
              description: 'Exit, leaving the grandchild behind',
              inputSchema: { type: 'object' },
            },
          ],
        });
      case 'tools/call':
        if (params?.name === 'crash') crash = true;
        return result(id, { content: [{ type: 'text', text: 'bye' }] });
      default:
        return error(id, -32601, `Method not found: ${method}`);
    }
  }

  const reader = ctx.stdin.getReader();
  const writer = ctx.stdout.getWriter();
  let buffer = '';
  while (!crash) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl = buffer.indexOf('\n');
    while (nl >= 0 && !crash) {
      const response = handleLine(buffer.slice(0, nl));
      buffer = buffer.slice(nl + 1);
      if (response) await writer.write(encoder.encode(`${response}\n`));
      nl = buffer.indexOf('\n');
    }
  }
  return crash ? 1 : 0;
}
