#!/usr/bin/env node
import { appendFileSync } from 'node:fs';

if (process.argv[2]) appendFileSync(process.argv[2], `${process.pid}\n`);
process.on('SIGTERM', () => {});
setTimeout(() => {}, 60_000);
