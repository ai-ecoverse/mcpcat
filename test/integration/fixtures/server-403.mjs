import { createServer } from 'node:http';

const server = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
  });
});

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address();
  console.log(JSON.stringify({ port }));
});

process.on('SIGTERM', () => {
  server.close();
  process.exit(0);
});
