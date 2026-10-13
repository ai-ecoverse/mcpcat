#!/usr/bin/env node
if (process.argv.includes('--mcp')) {
  process.stdout.write(
    JSON.stringify({
      name: 'trap_sigterm',
      commands: [{ name: 'trap', description: 'Trap SIGTERM and hang' }],
    }) + '\n'
  );
  process.exit(0);
}
if (process.argv.includes('--help')) {
  process.stdout.write('trap_sigterm\n\n  trap  Trap SIGTERM and hang\n');
  process.exit(0);
}
process.on('SIGTERM', () => {});
process.stdout.write(`pid:${process.pid}\n`);
setTimeout(() => process.exit(0), 300_000);
