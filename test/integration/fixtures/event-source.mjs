import { writeFileSync } from 'node:fs';

const [mode = 'tick', label = '', ms = '50', pidFile] = process.argv.slice(2);
if (pidFile) writeFileSync(pidFile, `${process.pid}\n`);
const out = (line) => process.stdout.write(`${line}\n`);
process.on('SIGTERM', () => process.exit(0));

if (mode === 'shape') {
  out(JSON.stringify({ eventId: 'up-1', timestamp: '2020-01-01T00:00:00Z', data: { x: 1 } }));
  out(JSON.stringify({ y: 2 }));
  out('hello');
  process.stdout.write('partial');
  setTimeout(() => process.exit(0), 50);
} else if (mode === 'crash') {
  out(JSON.stringify({ pid: process.pid }));
  process.stderr.write('source crashed\n');
  setTimeout(() => process.exit(3), 20);
} else if (mode === 'quiet') {
  setInterval(() => {}, 1000);
} else {
  let n = 0;
  setInterval(() => out(JSON.stringify({ n: ++n, label })), Number(ms));
}
