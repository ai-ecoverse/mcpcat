import { createServer } from 'node:http';

const SERVER_INFO = {
  name: 'test-header-echo',
  version: '1.0.0',
  title: 'Header Echo Server',
};

const TOOLS = [
  {
    name: 'echo-auth',
    description: 'Echoes the Authorization header value',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'fail-with-auth',
    description: 'Returns an error containing the Authorization header',
    inputSchema: { type: 'object', properties: {} },
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
    name: 'verbose-tool',
    description: 'A tool with verbose and v params',
    inputSchema: {
      type: 'object',
      properties: {
        verbose: { type: 'boolean', description: 'Verbose output' },
        v: { type: 'boolean', description: 'Short verbose' },
        message: { type: 'string', description: 'A message' },
      },
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

function handleRequest(body, authHeader) {
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
      });

    case 'tools/list':
      return jsonRpc(id, { tools: TOOLS });

    case 'tools/call': {
      const toolName = params?.name;
      const args = params?.arguments ?? {};
      if (toolName === 'echo-auth') {
        return jsonRpc(id, {
          content: [{ type: 'text', text: authHeader || '(no auth)' }],
        });
      }
      if (toolName === 'fail-with-auth') {
        return jsonRpcError(id, -32000, `Server error: auth was ${authHeader || '(none)'}`, {
          detail: `reflected: ${authHeader}`,
        });
      }
      if (toolName === 'add') {
        const sum = (args.a ?? 0) + (args.b ?? 0);
        return jsonRpc(id, {
          content: [{ type: 'text', text: String(sum) }],
        });
      }
      if (toolName === 'verbose-tool') {
        const text = JSON.stringify({ verbose: args.verbose, v: args.v, message: args.message });
        return jsonRpc(id, { content: [{ type: 'text', text }] });
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
    res.end(JSON.stringify({ error: 'Missing Mcp-Method' }));
    return;
  }

  const authHeader = req.headers['authorization'] || '';

  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', async () => {
    const body = Buffer.concat(chunks).toString();

    if (req.url === '/error-500') {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end(`Internal server error: auth=${authHeader}`);
      return;
    }

    const response = await handleRequest(body, authHeader);
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
