import { createServer } from 'node:http';
import { createStrictServer, parseOptions } from './kernel-stdio-2026-strict.mjs';

const server = createStrictServer(parseOptions(process.argv));
const sse = process.argv.includes('--sse');
const notify = process.argv.includes('--notify');

const http = createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/_test/log') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(server.log));
    return;
  }
  if (req.method === 'DELETE') {
    res.writeHead(200);
    res.end();
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end();
    return;
  }
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    let msg;
    try {
      msg = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } }));
      return;
    }
    const { status, response, sessionId } = server.handle(msg, req.headers);
    const headers = sessionId ? { 'Mcp-Session-Id': sessionId } : {};
    if (!response) {
      res.writeHead(202, headers);
      res.end();
      return;
    }
    if (sse && status === 200) {
      const note = {
        jsonrpc: '2.0',
        method: 'notifications/message',
        params: { level: 'info', data: 'working' },
      };
      res.writeHead(200, { 'Content-Type': 'text/event-stream', ...headers });
      if (notify) res.write(`event: message\ndata: ${JSON.stringify(note)}\n\n`);
      res.end(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
      return;
    }
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(JSON.stringify(response));
  });
});

http.listen(0, '127.0.0.1', () => {
  console.log(JSON.stringify({ port: http.address().port }));
});

process.on('SIGTERM', () => {
  http.close();
  process.exit(0);
});
