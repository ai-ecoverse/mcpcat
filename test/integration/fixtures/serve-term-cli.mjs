#!/usr/bin/env node
import { appendFileSync } from 'node:fs';

if (process.argv[2]) appendFileSync(process.argv[2], `${process.pid}\n`);
setTimeout(() => {}, 60_000);
