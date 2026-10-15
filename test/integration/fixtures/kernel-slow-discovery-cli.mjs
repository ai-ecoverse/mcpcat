export default async function main(ctx) {
  const file = ctx.env.PID_RECORD_FILE;
  if (file) await ctx.fs.writeFile(file, `${ctx.pid}\n`);
  await new Promise((resolve) => setTimeout(resolve, 30_000));
  return 0;
}
