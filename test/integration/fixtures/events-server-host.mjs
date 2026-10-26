import { createServer } from 'node:http';
import * as readline from 'node:readline';
import { createEventsServer } from './events-server.mjs';

const server = createEventsServer({ advertise: !process.argv.includes('--no-events') });

if (process.argv.includes('--http')) {
  const http = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const msg = JSON.parse(Buffer.concat(chunks).toString());
      let closers = [];
      const open = () => {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
        res.flushHeaders();
        res.on('close', () => {
          for (const fn of closers) fn();
          closers = [];
        });
        return {
          send: (m) => res.write(`data: ${JSON.stringify(m)}\n\n`),
          end: (m) => res.end(`data: ${JSON.stringify(m)}\n\n`),
          onClose: (fn) => closers.push(fn),
        };
      };
      const out = server.handle(msg, req.headers, open);
      if (out === undefined) return;
      if (!out) {
        res.writeHead(202);
        res.end();
        return;
      }
      res.writeHead(out.error?.code === -32020 ? 400 : 200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(out));
    });
  });
  http.listen(0, '127.0.0.1', () => {
    console.log(JSON.stringify({ port: http.address().port }));
  });
  process.on('SIGTERM', () => {
    http.closeAllConnections();
    http.close();
    process.exit(0);
  });
} else {
  const open = () => ({
    send: (m) => process.stdout.write(`${JSON.stringify(m)}\n`),
    end: (m) => process.stdout.write(`${JSON.stringify(m)}\n`),
    onClose() {},
  });
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    const out = line.trim() ? server.handle(JSON.parse(line), undefined, open) : null;
    if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
  });
  rl.on('close', () => process.exit(0));
}
