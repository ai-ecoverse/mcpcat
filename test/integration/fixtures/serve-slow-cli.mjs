#!/usr/bin/env node
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);

if (args[0] === '--mcp') {
  console.log(
    JSON.stringify({
      commands: [
        {
          name: 'slow',
          description: 'Run slowly with a grandchild',
          positionals: [],
          flags: [],
        },
      ],
    })
  );
  process.exit(0);
}

if (args[0] === '--help') {
  console.log('Usage: slow-cli <command>\n\nCommands:\n  slow  Run slowly');
  process.exit(0);
}

if (args[0] === 'slow') {
  const grandchild = spawn('sleep', ['300'], { stdio: 'ignore', detached: false });
  process.stderr.write(`grandchild:${grandchild.pid}\n`);
  setTimeout(() => {
    process.exit(0);
  }, 300_000);
} else {
  process.exit(1);
}
