#!/usr/bin/env node
import { spawn } from 'node:child_process';

const child = spawn('sleep', ['300'], { stdio: 'ignore' });
process.stdout.write(`child:${child.pid}\n`);
setTimeout(() => {
  process.stdout.write('done\n');
  process.exit(0);
}, 300_000);
