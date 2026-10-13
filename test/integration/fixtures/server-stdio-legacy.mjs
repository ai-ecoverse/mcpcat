import * as readline from 'node:readline';

const SERVER_INFO = {
  name: 'test-stdio-legacy',
  version: '1.0.0',
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

const RESOURCES = [
  {
    uri: 'file:///notes.txt',
    name: 'notes',
    description: 'Some notes',
    mimeType: 'text/plain',
  },
];

const RESOURCE_TEMPLATES = [
  {
    uriTemplate: 'file:///items/{id}',
    name: 'items',
    description: 'An item by ID',
  },
];

const PROMPTS = [
  {
    name: 'hello',
    description: 'Say hello',
    arguments: [{ name: 'name', description: 'Who to greet', required: true }],
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
        capabilities: { tools: { listChanged: false }, resources: {}, prompts: {} },
        serverInfo: SERVER_INFO,
        instructions: 'A legacy stdio test server.',
      });
      break;
    case 'tools/list':
      response = jsonRpc(id, { tools: TOOLS });
      break;
    case 'resources/list':
      response = jsonRpc(id, { resources: RESOURCES });
      break;
    case 'resources/templates/list':
      response = jsonRpc(id, { resourceTemplates: RESOURCE_TEMPLATES });
      break;
    case 'resources/read': {
      const uri = params?.uri;
      if (uri === 'file:///notes.txt') {
        response = jsonRpc(id, {
          contents: [{ uri, mimeType: 'text/plain', text: 'These are notes' }],
        });
      } else {
        response = jsonRpcError(id, -32602, `Resource not found: ${uri}`);
      }
      break;
    }
    case 'prompts/list':
      response = jsonRpc(id, { prompts: PROMPTS });
      break;
    case 'prompts/get': {
      const pName = params?.name;
      const pArgs = params?.arguments ?? {};
      if (pName === 'hello') {
        response = jsonRpc(id, {
          messages: [
            { role: 'user', content: { type: 'text', text: `Hello, ${pArgs.name ?? 'World'}!` } },
          ],
        });
      } else {
        response = jsonRpcError(id, -32602, `Unknown prompt: ${pName}`);
      }
      break;
    }
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
