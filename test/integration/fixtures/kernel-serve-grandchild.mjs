export default async function main(ctx) {
  const child = await ctx.spawn({
    argv: ['mcpcat-test-sleeper'],
    stdin: 'null',
    stdout: 'pipe',
    stderr: 'null',
  });

  const encoder = new TextEncoder();
  await ctx.write(1, encoder.encode(`child:${child.pid}\n`));

  await new Promise((resolve) => {
    const handle = setTimeout(resolve, 300000);
    ctx.signals.on('SIGTERM', () => {
      clearTimeout(handle);
      resolve();
    });
  });

  await ctx.write(1, encoder.encode('done\n'));
  return 0;
}
