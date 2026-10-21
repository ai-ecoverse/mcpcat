export function createHandler() {
  let calls = 0;
  const inputSchema = { type: 'object', properties: {} };
  const reply = (id, result) => ({ jsonrpc: '2.0', id, result });
  return (line) => {
    if (!line.trim()) return null;
    const { id, method, params } = JSON.parse(line);
    if (id === undefined) return null;
    if (method === 'server/discover') {
      return reply(id, {
        supportedVersions: ['2026-07-28'],
        serverInfo: { name: 'stdio-elicit', version: '1.0.0' },
        capabilities: { tools: {} },
      });
    }
    if (method === 'tools/list') {
      return reply(id, {
        tools: [
          { name: 'whoami', inputSchema },
          { name: 'confirm-url', inputSchema },
        ],
      });
    }
    if (method === 'tools/call') {
      calls += 1;
      if (calls > 1) {
        const answers = params?.arguments?._meta?.inputResponses ?? params?._inputResponses;
        return reply(id, {
          content: [{ type: 'text', text: `call ${calls} answers ${JSON.stringify(answers)}` }],
        });
      }
      const inputRequest =
        params?.name === 'confirm-url'
          ? { url: 'https://example.com/confirm' }
          : {
              message: 'Who are you?',
              schema: {
                type: 'object',
                properties: { name: { type: 'string' } },
                required: ['name'],
              },
            };
      return reply(id, {
        resultType: 'input_required',
        content: [{ type: 'text', text: 'input needed' }],
        inputRequest,
      });
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } };
  };
}

export default async function main(ctx) {
  const handle = createHandler();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const reader = ctx.stdin.getReader();
  const writer = ctx.stdout.getWriter();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        const out = handle(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        if (out) await writer.write(encoder.encode(`${JSON.stringify(out)}\n`));
        nl = buffer.indexOf('\n');
      }
    }
  } finally {
    reader.releaseLock();
    writer.releaseLock();
  }
  return 0;
}
