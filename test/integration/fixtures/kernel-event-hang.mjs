export default async function main(ctx) {
  if (ctx.argv.includes('trap')) await ctx.signals.on('SIGTERM', () => {});
  const line = `hang ${ctx.env.MCPCAT_EVENT_ID} ${ctx.pid}\n`;
  await ctx.write(1, new TextEncoder().encode(line));
  await new Promise((resolve) => setTimeout(resolve, 30_000));
  return 0;
}
