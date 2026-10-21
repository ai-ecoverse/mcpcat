export default async function main(ctx) {
  if (ctx.argv[1] === '--mcp') {
    const descriptor = { commands: [{ name: 'hold', description: 'Hold stdin unread' }] };
    await ctx.write(1, new TextEncoder().encode(`${JSON.stringify(descriptor)}\n`));
    return 0;
  }
  await new Promise((resolve) => {
    const handle = setTimeout(resolve, 60_000);
    ctx.signals.on('SIGTERM', () => {
      clearTimeout(handle);
      resolve();
    });
    if (ctx.argv[2]) ctx.fs.writeFile(ctx.argv[2], `${ctx.pid}\n`);
  });
  return 0;
}
