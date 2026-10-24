const NAMES = ['ada', 'alan', 'alonzo', 'bob', '\u001b]0;evil\u0007ann', 'line\nbreak\r'];
const IDS = ['1', '10', '100', '2'];

export function createHandler(legacy) {
  const reply = (id, result) => ({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  let asking;
  return (msg) => {
    const { id, method, params } = msg;
    if (!method && id === 'ask-1' && asking !== undefined) {
      const action = msg.result?.action ?? 'error';
      const out = reply(asking, {
        completion: { values: [`${action} ${JSON.stringify(msg.result?.content)}`] },
      });
      asking = undefined;
      return out;
    }
    if (id === undefined) return null;
    if (method === 'server/discover') {
      if (legacy) return fail(id, -32601, 'Method not found');
      return reply(id, {
        supportedVersions: ['2026-07-28'],
        serverInfo: { name: 'complete-srv', version: '1.0.0' },
        capabilities: { completions: {}, prompts: {} },
      });
    }
    if (method === 'initialize') {
      return reply(id, {
        protocolVersion: '2025-11-25',
        capabilities: { completions: {}, prompts: {} },
        serverInfo: { name: 'complete-srv', version: '1.0.0' },
      });
    }
    if (method === 'completion/complete') {
      const { ref, argument } = params ?? {};
      if (legacy && ref?.name === 'ask') {
        asking = id;
        return {
          jsonrpc: '2.0',
          id: 'ask-1',
          method: 'elicitation/create',
          params: {
            mode: 'form',
            message: 'Which?',
            requestedSchema: { type: 'object', properties: { pick: { type: 'string' } } },
          },
        };
      }
      if (ref?.name === 'empty') return reply(id, { completion: { hasMore: true } });
      if (ref?.type === 'ref/prompt' && ref.name === 'greet' && argument?.name === 'name') {
        const values = NAMES.filter((n) => n.startsWith(argument.value));
        return reply(id, { completion: { values, total: values.length, hasMore: false } });
      }
      if (
        ref?.type === 'ref/resource' &&
        ref.uri === 'file:///items/{id}' &&
        argument?.name === 'id'
      ) {
        const values = IDS.filter((n) => n.startsWith(argument.value)).slice(0, 2);
        return reply(id, { completion: { values, total: 3, hasMore: true } });
      }
      return fail(id, -32602, `no completions for ${JSON.stringify(ref)}`);
    }
    return fail(id, -32601, 'Method not found');
  };
}

export default async function main(ctx) {
  const handle = createHandler(ctx.argv?.includes('--legacy') ?? false);
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
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const out = line.trim() ? handle(JSON.parse(line)) : null;
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
