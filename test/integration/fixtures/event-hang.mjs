if (process.argv.includes('trap')) process.on('SIGTERM', () => {});
process.stdout.write(`hang ${process.env.MCPCAT_EVENT_ID} ${process.pid}\n`);
setTimeout(() => {}, 30_000);
