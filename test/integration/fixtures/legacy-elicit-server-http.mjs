import { createServer } from 'node:http';
import { createSession } from './legacy-elicit-server.mjs';

let stream;
let handle;

const server = createServer((req, res) => {
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end();
    return;
  }
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const msg = JSON.parse(Buffer.concat(chunks).toString());
    if (msg.method === 'server/discover') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no' } })
      );
      return;
    }
    if (msg.method === 'initialize') {
      handle = createSession(
        (m) => {
          if (m.id !== undefined && m.method === undefined) {
            stream.end(`event: message\ndata: ${JSON.stringify(m)}\n\n`);
            return;
          }
          stream.write(`event: message\ndata: ${JSON.stringify(m)}\n\n`);
        },
        { key: req.headers['x-key'] }
      );
    }
    if (msg.id === undefined || !msg.method) {
      res.writeHead(202);
      res.end();
      if (handle) handle(msg);
      return;
    }
    stream = res;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Mcp-Session-Id': 'sess-1',
    });
    handle(msg);
  });
});

server.listen(0, '127.0.0.1', () => {
  console.log(JSON.stringify({ port: server.address().port }));
});

process.on('SIGTERM', () => {
  server.close();
  process.exit(0);
});
