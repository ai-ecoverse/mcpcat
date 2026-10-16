#!/usr/bin/env node
import { appendFileSync } from 'node:fs';

if (process.env.PID_RECORD_FILE) appendFileSync(process.env.PID_RECORD_FILE, `${process.pid}\n`);
setTimeout(() => {}, 30_000);
