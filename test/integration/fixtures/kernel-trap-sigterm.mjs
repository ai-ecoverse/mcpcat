export default async function main(ctx) {
  ctx.signals.on('SIGTERM', () => {});
  const encoder = new TextEncoder();
  await ctx.write(1, encoder.encode(`pid:${ctx.pid}\n`));
  await new Promise((resolve) => setTimeout(resolve, 300000));
  return 0;
}
