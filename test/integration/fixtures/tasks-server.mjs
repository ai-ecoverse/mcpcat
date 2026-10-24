const EXT = 'io.modelcontextprotocol/tasks';
const STAMP = {
  createdAt: '2026-07-28T00:00:00Z',
  lastUpdatedAt: '2026-07-28T00:01:00Z',
  ttlMs: 60000,
};

function task(taskId) {
  const kind = taskId.split('-')[0];
  const base = { resultType: 'complete', taskId, ...STAMP };
  if (taskId.startsWith('-')) {
    return {
      ...base,
      status: 'completed',
      result: { content: [{ type: 'text', text: 'dashed ok' }] },
    };
  }
  if (kind === 'done') {
    return {
      ...base,
      status: 'completed',
      result: { content: [{ type: 'text', text: 'built ok' }] },
    };
  }
  if (kind === 'error') {
    return {
      ...base,
      status: 'completed',
      result: { content: [{ type: 'text', text: 'bad input' }], isError: true },
    };
  }
  if (kind === 'work') return { ...base, status: 'working', statusMessage: 'compiling' };
  if (kind === 'fail') {
    return {
      ...base,
      status: 'failed',
      statusMessage: 'failed',
      error: { code: -32603, message: 'boom' },
    };
  }
  if (kind === 'cancel') return { ...base, status: 'cancelled' };
  if (kind === 'input') {
    return {
      ...base,
      status: 'input_required',
      inputRequests: {
        name: {
          method: 'elicitation/create',
          params: {
            mode: 'form',
            message: 'Name?',
            requestedSchema: { type: 'object', properties: {} },
          },
        },
      },
    };
  }
  return undefined;
}

export function createHandler() {
  const reply = (id, result) => ({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
  return (msg, headers) => {
    const { id, method, params } = msg;
    if (id === undefined) return null;
    const caps = params?._meta?.['io.modelcontextprotocol/clientCapabilities'];
    const tasks = !!caps?.extensions?.[EXT];
    if (method === 'server/discover') {
      return reply(id, {
        supportedVersions: ['2026-07-28'],
        serverInfo: { name: 'tasks-srv', version: '1.0.0' },
        capabilities: { tools: {}, extensions: { [EXT]: {} } },
      });
    }
    if (method === 'tools/list') {
      return reply(id, {
        tools: [{ name: 'build', inputSchema: { type: 'object', properties: {} } }],
      });
    }
    if (method === 'tools/call') {
      if (!tasks)
        return reply(id, { resultType: 'complete', content: [{ type: 'text', text: 'sync' }] });
      return reply(id, {
        resultType: 'task',
        taskId: params?.arguments?.id ?? 'done-1',
        status: 'working',
        ...STAMP,
        pollIntervalMs: 1000,
      });
    }
    if (method === 'tasks/get' || method === 'tasks/cancel') {
      if (!tasks) return fail(id, -32021, 'Missing required client capability');
      if (headers && headers['mcp-name'] !== params?.taskId)
        return fail(id, -32020, 'Mcp-Name mismatch');
      const t = task(String(params?.taskId));
      if (!t) return fail(id, -32602, 'Failed to retrieve task: Task not found');
      return reply(id, method === 'tasks/get' ? t : { resultType: 'complete' });
    }
    return fail(id, -32601, 'Method not found');
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
