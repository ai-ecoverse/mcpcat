export default async function main(ctx) {
  await new Promise((resolve) => {
    const handle = setTimeout(resolve, Number(ctx.argv[2] ?? 60_000));
    ctx.signals.on('SIGTERM', () => {
      clearTimeout(handle);
      resolve();
    });
    if (ctx.argv[1]) ctx.fs.writeFile(ctx.argv[1], `${ctx.pid}\n`);
  });
  return 0;
}
