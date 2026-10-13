export default async function main(ctx) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();

  const TOOLS = [
    {
      name: 'greet',
      description: 'Greets a person by name',
      inputSchema: {
        type: 'object',
        properties: { name: { type: 'string', description: 'Name to greet' } },
        required: ['name'],
      },
    },
    {
      name: 'add',
      description: 'Adds two numbers',
      inputSchema: {
        type: 'object',
        properties: {
          a: { type: 'number', description: 'First number' },
          b: { type: 'number', description: 'Second number' },
        },
        required: ['a', 'b'],
      },
      outputSchema: { type: 'object', properties: { result: { type: 'number' } } },
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
    switch (method) {
      case 'initialize':
        return jsonRpc(id, {
          protocolVersion: '2025-11-25',
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'fixture-alpha', version: '1.0.0' },
          instructions: 'Alpha server for testing code mode.',
        });
      case 'tools/list':
        return jsonRpc(id, { tools: TOOLS });
      case 'tools/call': {
        const toolName = params?.name;
        const args = params?.arguments ?? {};
        if (toolName === 'greet') {
          return jsonRpc(id, {
            content: [{ type: 'text', text: `Hello, ${args.name ?? 'world'}!` }],
          });
        }
        if (toolName === 'add') {
          return jsonRpc(id, {
            content: [{ type: 'text', text: String((args.a ?? 0) + (args.b ?? 0)) }],
            structuredContent: { result: (args.a ?? 0) + (args.b ?? 0) },
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
        const response = handleLine(line);
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
