import * as readline from 'node:readline';
import { createHandler } from './stdio-elicit-server.mjs';

const handle = createHandler();
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  const out = handle(line);
  if (out) process.stdout.write(`${JSON.stringify(out)}\n`);
});
rl.on('close', () => process.exit(0));
