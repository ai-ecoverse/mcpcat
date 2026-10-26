export default async function main(ctx) {
  const [mode = 'tick', label = '', ms = '50'] = ctx.argv.slice(1);
  const enc = new TextEncoder();
  let timer;
  await new Promise((resolve) => {
    ctx.signals.on('SIGTERM', () => {
      clearInterval(timer);
      resolve();
    });
    if (mode === 'tick') {
      let n = 0;
      timer = setInterval(() => {
        ctx.write(1, enc.encode(`${JSON.stringify({ n: ++n, label })}\n`)).catch(() => {});
      }, Number(ms));
    }
  });
  return 0;
}
