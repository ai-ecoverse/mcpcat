import { writeSync } from 'node:fs';
import { installLeakProbe } from './leak-probe.mjs';

const report = installLeakProbe(globalThis);
process.on('exit', () => {
  writeSync(2, `leak-probe ${JSON.stringify(report())}\n`);
});
