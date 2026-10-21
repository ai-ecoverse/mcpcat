import { createServer } from 'node:http';

const seen = [];

function rpc(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function rpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

const TOOLS = [
  { name: 'headers', description: 'returns the request headers', inputSchema: { type: 'object' } },
  {
    name: 'err',
    description: 'a JSON-RPC error quoting the headers',
    inputSchema: { type: 'object' },
  },
  {
    name: 'echo',
    description: 'echo',
    inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
  },
];

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    if (req.url === '/seen') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(seen));
      return;
    }
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    const quoted = JSON.stringify(req.headers);
    if (req.url.startsWith('/500')) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      res.end(`boom ${quoted}`);
      return;
    }
    if (req.url.startsWith('/403')) {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end(`denied ${quoted}`);
      return;
    }
    if (req.url.startsWith('/401')) {
      res.writeHead(401, { 'content-type': 'text/plain' });
      res.end(`bad credentials ${quoted}`);
      return;
    }
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    const { id, method, params } = msg;
    if (id === undefined) {
      res.writeHead(202);
      res.end();
      return;
    }
    let out;
    if (req.url.startsWith('/ask') && method === 'server/discover') {
      out = rpc(id, {
        supportedVersions: ['2026-07-28'],
        serverInfo: { name: 'cert-reflect', version: '1.0.0' },
        capabilities: { tools: {} },
      });
    } else if (req.url.startsWith('/ask') && method === 'tools/call') {
      const ask = {
        message: `need input ${quoted}`,
        schema: { type: 'object', properties: { answer: { type: 'string' } } },
      };
      out = params?.arguments?._meta?.inputResponses
        ? rpcError(id, -32000, `retry failed ${quoted}`)
        : rpc(id, {
            resultType: 'input_required',
            content: [{ type: 'text', text: quoted }],
            ...(params?.arguments?.bare ? {} : { inputRequest: ask }),
          });
    } else if (method === 'initialize') {
      out = rpc(id, {
        protocolVersion: '2025-11-25',
        capabilities: { tools: {} },
        serverInfo: { name: 'cert-reflect', version: '1.0.0' },
      });
    } else if (method === 'tools/list') {
      out = rpc(id, { tools: TOOLS });
    } else if (method === 'tools/call' && params?.name === 'headers') {
      out = rpc(id, { content: [{ type: 'text', text: quoted }] });
    } else if (method === 'tools/call' && params?.name === 'err') {
      out = rpcError(id, -32000, `bad ${quoted}`);
    } else if (method === 'tools/call' && params?.name === 'echo') {
      out = rpc(id, {
        content: [{ type: 'text', text: String(params?.arguments?.message ?? '') }],
      });
    } else if (method === 'ping') {
      out = rpc(id, {});
    } else {
      out = rpcError(id, -32601, 'not found');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(out);
  });
});

server.listen(0, '127.0.0.1', () => {
  process.stdout.write(`${JSON.stringify({ port: server.address().port })}\n`);
});
process.on('SIGTERM', () => process.exit(0));
