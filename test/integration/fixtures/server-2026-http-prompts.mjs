import { createServer } from 'node:http';

const SERVER_INFO = {
  name: 'test-prompts',
  version: '1.0.0',
  title: 'Prompts Test Server',
};

const TOOLS = [];

const PROMPTS = [
  {
    name: 'summarize',
    description: 'Summarize a topic',
    arguments: [
      { name: 'topic', description: 'Topic to summarize', required: true },
      { name: 'style', description: 'Style of summary', required: false },
    ],
  },
  {
    name: 'greet',
    description: 'Simple greeting',
    arguments: [],
  },
];

function jsonRpc(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function jsonRpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
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
        capabilities: { tools: {}, prompts: { listChanged: false } },
      });

    case 'tools/list':
      return jsonRpc(id, { tools: TOOLS });

    case 'prompts/list':
      return jsonRpc(id, { prompts: PROMPTS });

    case 'prompts/get': {
      const name = params?.name;
      const args = params?.arguments ?? {};
      if (name === 'summarize') {
        const topic = args.topic ?? 'unknown';
        const style = args.style ?? 'brief';
        return jsonRpc(id, {
          description: `Summary of ${topic}`,
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: `Please summarize ${topic} in a ${style} style.`,
              },
            },
          ],
        });
      }
      if (name === 'greet') {
        return jsonRpc(id, {
          messages: [{ role: 'user', content: { type: 'text', text: 'Hello!' } }],
        });
      }
      return jsonRpcError(id, -32602, `Unknown prompt: ${name}`);
    }

    default:
      return jsonRpcError(id, -32601, `Method not found: ${method}`);
  }
}

const server = createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end();
    return;
  }

  if (!req.headers['mcp-method']) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing Mcp-Method' }));
    return;
  }

  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', async () => {
    const body = Buffer.concat(chunks).toString();
    const response = await handleRequest(body);
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
