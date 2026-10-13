export default async function main(ctx) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const SERVER_INFO = {
    name: 'test-kernel-stdio-slow',
    version: '1.0.0',
  };

  const TOOLS = [
    {
      name: 'slow',
      description: 'Sleeps for ms then returns',
      inputSchema: { type: 'object', properties: { ms: { type: 'integer' } } },
    },
  ];

  function jsonRpc(id, result) {
    return JSON.stringify({ jsonrpc: '2.0', id, result });
  }

  function jsonRpcError(id, code, message) {
    return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  }

  function handleLine(line) {
    if (!line.trim()) return null;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return jsonRpcError(null, -32700, 'Parse error');
    }

    const { id, method, params } = parsed;
    if (method === 'notifications/initialized') return null;
    if (method === 'notifications/cancelled') return null;

    switch (method) {
      case 'initialize':
        return jsonRpc(id, {
          protocolVersion: '2025-11-25',
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        });
      case 'tools/list':
        return jsonRpc(id, { tools: TOOLS });
      case 'tools/call': {
        const toolName = params?.name;
        const args = params?.arguments ?? {};
        if (toolName === 'slow') {
          const ms = args.ms ?? 30000;
          return new Promise((resolve) => {
            setTimeout(() => {
              resolve(jsonRpc(id, { content: [{ type: 'text', text: 'done' }] }));
            }, ms);
          });
        }
        return jsonRpcError(id, -32602, `Unknown tool: ${toolName}`);
      }
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
