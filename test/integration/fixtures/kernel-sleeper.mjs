export default async function main(ctx) {
  await new Promise((resolve) => {
    const handle = setTimeout(resolve, 300000);
    ctx.signals.on('SIGTERM', () => {
      clearTimeout(handle);
      resolve();
    });
  });
  return 0;
}
