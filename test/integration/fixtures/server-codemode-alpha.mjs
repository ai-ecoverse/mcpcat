import * as readline from 'node:readline';

const SERVER_INFO = {
  name: 'fixture-alpha',
  version: '1.0.0',
  title: 'Fixture Alpha',
};

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
        protocolVersion: '2025-11-25',
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: 'Alpha server for testing code mode.',
      });
      break;
    case 'tools/list':
      response = jsonRpc(id, { tools: TOOLS });
      break;
    case 'tools/call': {
      const toolName = params?.name;
      const args = params?.arguments ?? {};
      if (toolName === 'greet') {
        response = jsonRpc(id, {
          content: [{ type: 'text', text: `Hello, ${args.name ?? 'world'}!` }],
        });
      } else if (toolName === 'add') {
        response = jsonRpc(id, {
          content: [{ type: 'text', text: String((args.a ?? 0) + (args.b ?? 0)) }],
          structuredContent: { result: (args.a ?? 0) + (args.b ?? 0) },
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

rl.on('close', () => process.exit(0));
