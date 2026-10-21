#!/usr/bin/env node
import { appendFileSync } from 'node:fs';

if (process.argv[2] === '--mcp') {
  console.log(JSON.stringify({ commands: [{ name: 'hold', description: 'Hold stdin unread' }] }));
  process.exit(0);
}
if (process.argv[3]) appendFileSync(process.argv[3], `${process.pid}\n`);
setTimeout(() => {}, 60_000);
