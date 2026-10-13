import { createServer } from 'node:http';

const server = createServer((req, res) => {
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Unauthorized' }));
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  console.log(JSON.stringify({ port, protocol: '2026-07-28', transport: 'http' }));
});

process.on('SIGTERM', () => {
  server.close();
  process.exit(0);
});
