export default async function main(ctx) {
  ctx.signals.ignore('SIGTERM');
  ctx.signals.ignore('SIGHUP');
  const child = await ctx.spawn({
    argv: ctx.argv.slice(1),
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  });
  await child.wait();
  await new Promise(() => {});
  return 0;
}
