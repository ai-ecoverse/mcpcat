import * as readline from 'node:readline';
import { createSession } from './legacy-elicit-server.mjs';

const handle = createSession((m) => process.stdout.write(`${JSON.stringify(m)}\n`));
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (line.trim()) handle(JSON.parse(line));
});
rl.on('close', () => process.exit(0));
