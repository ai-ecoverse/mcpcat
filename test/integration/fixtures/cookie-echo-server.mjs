import { createServer } from 'node:http';

const rpc = (id, result) => JSON.stringify({ jsonrpc: '2.0', id, result });

function seen(headers) {
  const cookie = headers.cookie === undefined ? 'absent' : 'present';
  return `cookie ${cookie}, x-probe ${headers['x-probe'] ?? 'absent'}`;
}

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    const { id, method } = msg;
    let out;
    if (method === 'server/discover') {
      out = rpc(id, {
        supportedVersions: ['2026-07-28'],
        serverInfo: { name: 'cookie-echo', version: '1.0.0' },
        capabilities: { tools: {} },
      });
    } else if (method === 'tools/list') {
      out = rpc(id, {
        tools: [
          { name: 'seen', description: 'which headers arrived', inputSchema: { type: 'object' } },
        ],
      });
    } else if (method === 'tools/call') {
      out = rpc(id, { content: [{ type: 'text', text: seen(req.headers) }] });
    } else {
      out = JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32601, message: 'not found' } });
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(out);
  });
});

server.listen(0, '127.0.0.1', () => {
  console.log(JSON.stringify({ port: server.address().port }));
});

process.on('SIGTERM', () => {
  server.close();
  process.exit(0);
});
