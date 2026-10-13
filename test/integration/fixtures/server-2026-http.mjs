import { createServer } from 'node:http';

const SERVER_INFO = {
  name: 'test-2026',
  version: '1.0.0',
  title: 'Test Server (2026-07-28)',
};

const TOOLS = [
  {
    name: 'echo',
    description: 'Echoes the input back',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string', description: 'Message to echo' } },
      required: ['message'],
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
  },
  {
    name: 'fail',
    description: 'Always returns an error',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'needs-input',
    description: 'Returns input_required resultType',
    inputSchema: { type: 'object', properties: {} },
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

function handleRequest(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return jsonRpcError(null, -32700, 'Parse error');
  }

  const { id, method, params } = parsed;

  switch (method) {
    case 'server/discover':
      return jsonRpc(id, {
        supportedVersions: ['2026-07-28'],
        serverInfo: SERVER_INFO,
        capabilities: { tools: { listChanged: false } },
        instructions: 'A test server for integration tests.',
      });

    case 'tools/list':
      return jsonRpc(id, { tools: TOOLS });

    case 'tools/call': {
      const toolName = params?.name;
      const args = params?.arguments ?? {};
      if (toolName === 'echo') {
        return jsonRpc(id, {
          content: [{ type: 'text', text: args.message ?? '' }],
        });
      }
      if (toolName === 'add') {
        const sum = (args.a ?? 0) + (args.b ?? 0);
        return jsonRpc(id, {
          content: [{ type: 'text', text: String(sum) }],
        });
      }
      if (toolName === 'fail') {
        return jsonRpc(id, {
          content: [{ type: 'text', text: 'something went wrong' }],
          isError: true,
        });
      }
      if (toolName === 'needs-input') {
        return jsonRpc(id, {
          resultType: 'input_required',
          content: [{ type: 'text', text: 'Please provide additional input' }],
          inputRequest: {
            schema: { type: 'object', properties: { answer: { type: 'string' } } },
          },
        });
      }
      return jsonRpcError(id, -32602, `Unknown tool: ${toolName}`);
    }

    default:
      return jsonRpcError(id, -32601, `Method not found: ${method}`);
  }
}

const server = createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  if (!req.headers['mcp-method']) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing required Mcp-Method header' }));
    return;
  }

  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString();
    const response = handleRequest(body);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(response);
  });
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  console.log(JSON.stringify({ port, protocol: '2026-07-28', transport: 'http' }));
});

process.on('SIGTERM', () => {
  server.close();
  process.exit(0);
});
