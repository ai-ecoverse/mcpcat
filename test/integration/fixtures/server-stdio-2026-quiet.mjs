import * as readline from 'node:readline';

readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.method !== 'server/discover') return;
  const result = { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } };
  process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`);
});
