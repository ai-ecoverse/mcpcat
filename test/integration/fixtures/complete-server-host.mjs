import { createServer } from 'node:http';
import * as readline from 'node:readline';
import { createHandler } from './complete-server.mjs';

const handle = createHandler(process.argv.includes('--legacy'));

if (process.argv.includes('--http')) {
  const server = createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405);
      res.end();
      return;
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const out = handle(JSON.parse(Buffer.concat(chunks).toString()));
      if (!out) {
        res.writeHead(202);
        res.end();
        return;
      }
      const status =
        out.error?.code === -32601 && out.error.message === 'Method not found' ? 400 : 200;
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  server.listen(0, '127.0.0.1', () => {
    console.log(JSON.stringify({ port: server.address().port }));
  });
  process.on('SIGTERM', () => {
    server.close();
    process.exit(0);
  });
} else {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    const out = line.trim() ? handle(JSON.parse(line)) : null;
    if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
  });
  rl.on('close', () => process.exit(0));
}
