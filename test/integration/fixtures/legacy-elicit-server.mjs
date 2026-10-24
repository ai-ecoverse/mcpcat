export function createSession(write, info = {}) {
  let next = 0;
  const waiting = new Map();
  const reply = (id, result) => write({ jsonrpc: '2.0', id, result });
  const text = (id, t) => reply(id, { content: [{ type: 'text', text: t }] });
  function ask(method, params) {
    next += 1;
    const id = `s${next}`;
    write({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve) => waiting.set(id, resolve));
  }
  async function call(id, name) {
    if (name === 'whoami') {
      const r = await ask('elicitation/create', {
        mode: 'form',
        message: `Who are you?\u001b[31m ${info.key ?? ''}`,
        requestedSchema: {
          type: 'object',
          properties: { name: { type: 'string' } },
          required: ['name'],
        },
      });
      return text(
        id,
        r.result
          ? `${r.result.action} ${JSON.stringify(r.result.content)}`
          : `error ${r.error.message}`
      );
    }
    if (name === 'confirm-url') {
      const r = await ask('elicitation/create', {
        mode: 'url',
        message: 'Confirm',
        url: 'https://example.com/confirm',
        elicitationId: 'e1',
      });
      return text(id, r.result ? `url ${r.result.action}` : `error ${r.error.message}`);
    }
    if (name === 'roots') {
      const r = await ask('roots/list', {});
      return text(id, r.result ? JSON.stringify(r.result.roots) : `error ${r.error.code}`);
    }
    if (name === 'sample') {
      const r = await ask('sampling/createMessage', {
        messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }],
        maxTokens: 10,
      });
      return text(id, r.error ? `sampling ${r.error.code} ${r.error.message}` : 'sampled');
    }
    return write({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool: ${name}` } });
  }
  return (msg) => {
    const { id, method, params } = msg;
    if (!method) {
      const resolve = waiting.get(id);
      waiting.delete(id);
      resolve?.(msg);
      return;
    }
    if (id === undefined) return;
    if (method === 'initialize') {
      return reply(id, {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'legacy-elicit', version: '1.0.0' },
        clientCapabilities: params?.capabilities,
      });
    }
    if (method === 'tools/list') {
      const inputSchema = { type: 'object', properties: {} };
      return reply(id, {
        tools: ['whoami', 'confirm-url', 'roots', 'sample'].map((name) => ({ name, inputSchema })),
      });
    }
    if (method === 'tools/call') return call(id, params?.name);
    return write({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
  };
}

export default async function main(ctx) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const reader = ctx.stdin.getReader();
  const writer = ctx.stdout.getWriter();
  const handle = createSession((m) => writer.write(encoder.encode(`${JSON.stringify(m)}\n`)));
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim()) handle(JSON.parse(line));
        nl = buffer.indexOf('\n');
      }
    }
  } finally {
    reader.releaseLock();
    writer.releaseLock();
  }
  return 0;
}
