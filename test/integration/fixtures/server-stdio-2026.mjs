import * as readline from 'node:readline';

const SERVER_INFO = {
  name: 'test-stdio-2026',
  version: '1.0.0',
  title: 'Stdio Test Server (2026-07-28)',
};

const TOOLS = [
  {
    name: 'echo',
    description: 'Echoes the input back',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      required: ['message'],
    },
  },
];

function jsonRpc(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function jsonRpcError(id, code, message, data) {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  });
}

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', (line) => {
  if (!line.trim()) return;
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch {
    process.stdout.write(`${jsonRpcError(null, -32700, 'Parse error')}\n`);
    return;
  }

  const { id, method, params } = parsed;

  if (method === 'notifications/initialized') return;

  let response;
  switch (method) {
    case 'initialize':
      response = jsonRpc(id, {
        protocolVersion: '2026-07-28',
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: 'A stdio test server.',
      });
      break;
    case 'tools/list':
      response = jsonRpc(id, { tools: TOOLS });
      break;
    case 'tools/call': {
      const toolName = params?.name;
      const args = params?.arguments ?? {};
      if (toolName === 'echo') {
        response = jsonRpc(id, {
          content: [{ type: 'text', text: args.message ?? '' }],
        });
      } else {
        response = jsonRpcError(id, -32602, `Unknown tool: ${toolName}`);
      }
      break;
    }
    default:
      response = jsonRpcError(id, -32601, `Method not found: ${method}`);
  }

  process.stdout.write(`${response}\n`);
});

rl.on('close', () => {
  process.exit(0);
});
