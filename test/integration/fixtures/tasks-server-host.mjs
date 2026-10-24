import { createServer } from 'node:http';
import * as readline from 'node:readline';
import { createHandler } from './tasks-server.mjs';

const handle = createHandler();

if (process.argv.includes('--http')) {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const out = handle(JSON.parse(Buffer.concat(chunks).toString()), req.headers);
      if (!out) {
        res.writeHead(202);
        res.end();
        return;
      }
      res.writeHead(out.error?.code === -32020 ? 400 : 200, { 'Content-Type': 'application/json' });
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
