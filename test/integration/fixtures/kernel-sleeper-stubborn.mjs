export default async function main(ctx) {
  for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT']) ctx.signals.on(sig, () => {});
  await new Promise((resolve) => setTimeout(resolve, 300000));
  return 0;
}
