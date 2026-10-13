export default async function main(ctx) {
  const delayMs = parseInt(ctx.argv[1] || '2500', 10);
  const mcpcatArgs = ctx.argv.slice(2);

  const proc = await ctx.spawn({
    argv: ['mcpcat', ...mcpcatArgs],
    stdin: 'null',
    stdout: 'inherit',
    stderr: 'inherit',
  });

  setTimeout(() => {
    try {
      ctx.kill(proc.pid, 'SIGINT');
    } catch {}
  }, delayMs);

  const result = await proc.wait();
  return result.status;
}
