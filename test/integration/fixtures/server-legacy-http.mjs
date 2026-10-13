import { createServer } from 'node:http';

const SERVER_INFO = {
  name: 'test-legacy',
  version: '1.0.0',
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
];

let sessionCounter = 0;
const sessions = new Set();
const deletedSessions = [];

function jsonRpc(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function jsonRpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

function sseFrame(data) {
  return `event: message\ndata: ${data}\n\n`;
}

function handleRequest(body, sessionId) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { response: jsonRpcError(null, -32700, 'Parse error') };
  }

  const { id, method, params } = parsed;

  switch (method) {
    case 'server/discover':
      return { response: jsonRpcError(id, -32601, 'Method not found') };

    case 'initialize': {
      const sid = `session-${++sessionCounter}`;
      sessions.add(sid);
      return {
        response: jsonRpc(id, {
          protocolVersion: '2025-11-25',
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: 'A legacy test server.',
        }),
        sessionId: sid,
      };
    }

    case 'notifications/initialized':
      return { response: null };

    case 'tools/list':
      return { response: jsonRpc(id, { tools: TOOLS }) };

    case 'tools/call': {
      const toolName = params?.name;
      const args = params?.arguments ?? {};
      if (toolName === 'echo') {
        return {
          response: jsonRpc(id, {
            content: [{ type: 'text', text: args.message ?? '' }],
          }),
        };
      }
      if (toolName === 'add') {
        const sum = (args.a ?? 0) + (args.b ?? 0);
        return {
          response: jsonRpc(id, {
            content: [{ type: 'text', text: String(sum) }],
          }),
        };
      }
      return { response: jsonRpcError(id, -32602, `Unknown tool: ${toolName}`) };
    }

    default:
      return { response: jsonRpcError(id, -32601, `Method not found: ${method}`) };
  }
}

const useSse = process.argv.includes('--sse');

const server = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/_test/deletes') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(deletedSessions));
    return;
  }

  if (req.method === 'DELETE') {
    const sid = req.headers['mcp-session-id'];
    if (sid) {
      sessions.delete(sid);
      deletedSessions.push(sid);
    }
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Method not allowed' }));
    return;
  }

  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(chunks).toString();
    const incomingSession = req.headers['mcp-session-id'];
    const { response, sessionId } = handleRequest(body, incomingSession);

    if (response === null) {
      res.writeHead(204);
      res.end();
      return;
    }

    const responseHeaders = {};
    if (sessionId) responseHeaders['Mcp-Session-Id'] = sessionId;

    if (useSse) {
      responseHeaders['Content-Type'] = 'text/event-stream';
      responseHeaders['Cache-Control'] = 'no-cache';
      res.writeHead(200, responseHeaders);
      res.end(sseFrame(response));
    } else {
      responseHeaders['Content-Type'] = 'application/json';
      res.writeHead(200, responseHeaders);
      res.end(response);
    }
  });
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  console.log(JSON.stringify({ port, protocol: '2025-11-25', transport: 'http', sse: useSse }));
});

process.on('SIGTERM', () => {
  server.close();
  process.exit(0);
});
