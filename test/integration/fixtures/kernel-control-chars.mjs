const EVIL = 'boom \x1b]0;pwned\x07 \x1b[2J \x9b31m end';

export default async function main(ctx) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  if (ctx.argv.includes('tab-list')) {
    await ctx.write(2, encoder.encode(`${EVIL}\n`));
    return 1;
  }
  const failInit = ctx.argv.includes('--fail-init');
  const inputSchema = { type: 'object', properties: {} };

  function reply(id, payload) {
    return JSON.stringify({ jsonrpc: '2.0', id, ...payload });
  }

  function handleLine(line) {
    if (!line.trim()) return null;
    const { id, method, params } = JSON.parse(line);
    if (id === undefined) return null;
    if (method === 'initialize' && failInit) {
      return reply(id, { error: { code: -32000, message: EVIL } });
    }
    if (method === 'initialize') {
      return reply(id, {
        result: {
          protocolVersion: '2025-11-25',
          capabilities: { tools: {} },
          serverInfo: { name: 'evil-kernel', version: '1.0.0' },
        },
      });
    }
    if (method === 'tools/list') {
      return reply(id, {
        result: { tools: ['toolerr', 'rpcerr'].map((name) => ({ name, inputSchema })) },
      });
    }
    if (method === 'tools/call' && params?.name === 'toolerr') {
      return reply(id, { result: { isError: true, content: [{ type: 'text', text: EVIL }] } });
    }
    if (method === 'tools/call') {
      return reply(id, { error: { code: -32000, message: EVIL } });
    }
    return reply(id, { error: { code: -32601, message: 'Method not found' } });
  }

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
        const response = handleLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
        if (response) await writer.write(encoder.encode(`${response}\n`));
        nl = buffer.indexOf('\n');
      }
    }
  } finally {
    reader.releaseLock();
    writer.releaseLock();
  }
  return 0;
}
