import { createServer } from 'node:http';

const SERVER_INFO = {
  name: 'test-proxy-upstream',
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
  {
    name: 'headers',
    description: 'Returns the request headers as text',
    inputSchema: { type: 'object', properties: {} },
  },
];

let lastHeaders = {};

function jsonRpc(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function jsonRpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

function handleRequest(body, reqHeaders) {
  lastHeaders = { ...reqHeaders };
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
      if (toolName === 'echo') {
        return jsonRpc(id, {
          content: [{ type: 'text', text: args.message ?? '' }],
        });
      }
      if (toolName === 'headers') {
        return jsonRpc(id, {
          content: [{ type: 'text', text: JSON.stringify(lastHeaders) }],
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
    res.writeHead(405);
    res.end('Method not allowed');
    return;
  }

  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString();
    const response = handleRequest(body, req.headers);
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
