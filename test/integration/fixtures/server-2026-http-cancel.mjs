import { createServer } from 'node:http';

const SERVER_INFO = {
  name: 'test-2026-cancel',
  version: '1.0.0',
  title: 'Test Server for cancel tracking (2026-07-28)',
};

const TOOLS = [
  {
    name: 'slow-cancel',
    description: 'Sleeps forever until cancelled; records abort',
    inputSchema: { type: 'object', properties: { ms: { type: 'integer' } } },
  },
];

const aborted = [];

function jsonRpc(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function jsonRpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

function handleDiscover(id) {
  return jsonRpc(id, {
    supportedVersions: ['2026-07-28'],
    serverInfo: SERVER_INFO,
    capabilities: { tools: { listChanged: false } },
  });
}

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/__aborted') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(aborted));
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  const mcpMethod = req.headers['mcp-method'];
  if (!mcpMethod) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing Mcp-Method header' }));
    return;
  }

  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString();
    let parsed;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(jsonRpcError(null, -32700, 'Parse error'));
      return;
    }

    const { id, method, params } = parsed;

    if (method === 'server/discover') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(handleDiscover(id));
      return;
    }

    if (method === 'tools/list') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(jsonRpc(id, { tools: TOOLS }));
      return;
    }

    if (method === 'tools/call' && params?.name === 'slow-cancel') {
      const timer = setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(jsonRpc(id, { content: [{ type: 'text', text: 'done' }] }));
      }, 30000);

      req.socket.on('close', () => {
        clearTimeout(timer);
        aborted.push({ requestId: id, method: 'tools/call', tool: params.name });
      });
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(jsonRpcError(id, -32601, `Method not found: ${method}`));
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
