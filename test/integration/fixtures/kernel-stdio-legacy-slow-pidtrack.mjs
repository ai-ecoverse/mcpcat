export default async function main(ctx) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const pidFile = ctx.env.PID_RECORD_FILE;

  const child = await ctx.spawn({
    argv: ['mcpcat-test-sleeper'],
    stdin: 'null',
    stdout: 'null',
    stderr: 'null',
  });

  if (pidFile) {
    await ctx.fs.writeFile(pidFile, `server:${ctx.pid}\ngrandchild:${child.pid}\n`);
  }

  function jsonRpc(id, result) {
    return JSON.stringify({ jsonrpc: '2.0', id, result });
  }

  function jsonRpcError(id, code, message) {
    return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  }

  async function handleLine(line) {
    if (!line.trim()) return null;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return jsonRpcError(null, -32700, 'Parse error');
    }
    const { id, method, params } = parsed;
    if (method === 'notifications/initialized') return null;
    switch (method) {
      case 'initialize':
        return jsonRpc(id, {
          protocolVersion: '2025-11-25',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'test-kernel-legacy-slow', version: '1.0.0' },
        });
      case 'tools/list':
        return jsonRpc(id, {
          tools: [
            {
              name: 'slow',
              description: 'Responds after 60 seconds',
              inputSchema: { type: 'object', properties: {} },
            },
          ],
        });
      case 'tools/call':
        await new Promise((r) => setTimeout(r, 60000));
        return jsonRpc(id, {
          content: [{ type: 'text', text: 'done' }],
        });
      default:
        return jsonRpcError(id, -32601, `Method not found: ${method}`);
    }
  }

  const reader = ctx.stdin.getReader();
  const writer = ctx.stdout.getWriter();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nlIdx = buffer.indexOf('\n');
      while (nlIdx >= 0) {
        const line = buffer.slice(0, nlIdx);
        buffer = buffer.slice(nlIdx + 1);
        const response = await handleLine(line);
        if (response) {
          await writer.write(encoder.encode(response + '\n'));
        }
        nlIdx = buffer.indexOf('\n');
      }
    }
  } finally {
    reader.releaseLock();
    writer.releaseLock();
  }

  return 0;
}
