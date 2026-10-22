import * as readline from 'node:readline';
import { createStrictServer, parseOptions } from './kernel-stdio-2026-strict.mjs';

const server = createStrictServer(parseOptions(process.argv));
const rl = readline.createInterface({ input: process.stdin, terminal: false });
rl.on('line', (line) => {
  if (!line.trim()) return;
  const { response } = server.handle(JSON.parse(line));
  if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
});
rl.on('close', () => process.exit(0));
