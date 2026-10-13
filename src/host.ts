import { run } from './cli/main.ts';
import { createHostPlatform } from './platform/host.ts';

declare const MCPCAT_VERSION: string;

const platform = createHostPlatform();
const args = process.argv.slice(2);

try {
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});
  process.on('SIGPIPE', () => {});
} catch {}

const code = await run(platform, MCPCAT_VERSION, args);
process.exit(code);
