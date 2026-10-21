export default async function main(ctx) {
  if (ctx.argv[1]) await ctx.fs.writeFile(ctx.argv[1], `${ctx.pid}\n`);
  for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT']) ctx.signals.on(sig, () => {});
  await new Promise((resolve) => setTimeout(resolve, 60_000));
  return 0;
}
