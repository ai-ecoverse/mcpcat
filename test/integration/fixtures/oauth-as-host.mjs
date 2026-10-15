import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createHandler } from './kernel-oauth-as.mjs';

const seed = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const handle = createHandler(seed, (line) => process.stderr.write(`${line}\n`));

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => {
    body += c;
  });
  req.on('end', () => {
    const out = handle({
      method: req.method,
      path: new URL(req.url, 'http://x').pathname,
      headers: req.headers,
      body,
    });
    res.writeHead(out.status, out.headers);
    res.end(out.body);
  });
});

server.listen(0, '127.0.0.1', () => {
  console.log(JSON.stringify({ port: server.address().port }));
});

process.on('SIGTERM', () => {
  server.close();
  process.exit(0);
});
