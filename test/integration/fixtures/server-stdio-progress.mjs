import * as readline from 'node:readline';

const SERVER_INFO = {
  name: 'test-stdio-progress',
  version: '1.0.0',
};

const TOOLS = [
  {
    name: 'progress-wait',
    description: 'Emits progress then waits for cancel',
    inputSchema: { type: 'object', properties: { count: { type: 'integer' } } },
  },
  {
    name: 'progress-finish',
    description: 'Emits progress every second and finishes',
    inputSchema: {
      type: 'object',
      properties: { intervalMs: { type: 'integer' }, steps: { type: 'integer' } },
    },
  },
  {
    name: 'slow',
    description: 'Sleeps for ms then returns',
    inputSchema: { type: 'object', properties: { ms: { type: 'integer' } } },
  },
];

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function jsonRpc(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

const cancels = [];
const pendingCalls = new Map();

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  if (!line.trim()) return;
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    send(jsonRpcError(null, -32700, 'Parse error'));
    return;
  }

  const { id, method, params } = parsed;

  if (method === 'notifications/initialized') return;

  if (method === 'notifications/cancelled') {
    const reqId = params?.requestId;
    cancels.push(reqId);
    const pending = pendingCalls.get(reqId);
    if (pending) {
      clearTimeout(pending.timer);
      pendingCalls.delete(reqId);
      send(jsonRpc(reqId, { content: [{ type: 'text', text: 'cancelled' }], isError: true }));
    }
    return;
  }

  if (method === 'initialize') {
    send(
      jsonRpc(id, {
        protocolVersion: '2025-11-25',
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
      })
    );
    return;
  }

  if (method === 'tools/list') {
    send(jsonRpc(id, { tools: TOOLS }));
    return;
  }

  if (method === 'tools/call') {
    const toolName = params?.name;
    const args = params?.arguments ?? {};
    const progressToken = params?._meta?.progressToken;

    if (toolName === 'progress-wait') {
      const count = args.count ?? 3;
      let step = 0;
      const iv = setInterval(() => {
        step++;
        if (progressToken !== undefined) {
          send({
            jsonrpc: '2.0',
            method: 'notifications/progress',
            params: { progressToken, progress: step, total: count, message: `step ${step}` },
          });
        }
        if (step >= count) {
          clearInterval(iv);
          pendingCalls.set(id, {
            timer: setTimeout(() => {
              pendingCalls.delete(id);
              send(
                jsonRpc(id, { content: [{ type: 'text', text: `done after ${count} progress` }] })
              );
            }, 30000),
          });
        }
      }, 200);
      return;
    }

    if (toolName === 'progress-finish') {
      const intervalMs = args.intervalMs ?? 1000;
      const steps = args.steps ?? 4;
      let step = 0;
      const iv = setInterval(() => {
        step++;
        if (progressToken !== undefined) {
          send({
            jsonrpc: '2.0',
            method: 'notifications/progress',
            params: { progressToken, progress: step, total: steps, message: `step ${step}` },
          });
        }
        if (step >= steps) {
          clearInterval(iv);
          send(jsonRpc(id, { content: [{ type: 'text', text: `completed ${steps} steps` }] }));
        }
      }, intervalMs);
      return;
    }

    if (toolName === 'slow') {
      const ms = args.ms ?? 5000;
      const timer = setTimeout(() => {
        pendingCalls.delete(id);
        send(jsonRpc(id, { content: [{ type: 'text', text: 'done' }] }));
      }, ms);
      pendingCalls.set(id, { timer });
      return;
    }

    send(jsonRpcError(id, -32602, `Unknown tool: ${toolName}`));
    return;
  }

  send(jsonRpcError(id, -32601, `Method not found: ${method}`));
});

rl.on('close', () => {
  process.exit(0);
});
