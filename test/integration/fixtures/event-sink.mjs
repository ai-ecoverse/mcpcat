import { readFileSync } from 'node:fs';

const input = readFileSync(0, 'utf8');
const { MCPCAT_EVENT_ID: id, MCPCAT_EVENT_NAME: name, MCPCAT_EVENT_CURSOR: cursor } = process.env;
const n = JSON.parse(input).data.n;
process.stdout.write(`${id} ${name} ${cursor ?? '-'} ${n}\n`);
process.exit(Number(process.argv[2] ?? 0));
