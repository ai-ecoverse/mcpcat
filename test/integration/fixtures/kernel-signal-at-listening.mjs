export default async function main(ctx) {
  const sig = ctx.argv[1];
  const proc = await ctx.spawn({
    argv: ['mcpcat', ...ctx.argv.slice(2)],
    stdin: 'null',
    stdout: 'null',
    stderr: 'pipe',
  });
  const reader = proc.stderr.getReader();
  const decoder = new TextDecoder();
  let seen = '';
  let sent = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    seen += decoder.decode(value, { stream: true });
    if (!sent && /listening on /.test(seen)) {
      sent = true;
      ctx.kill(proc.pid, sig);
    }
  }
  const result = await proc.wait();
  await ctx.write(
    1,
    new TextEncoder().encode(`${JSON.stringify({ sent, status: result.status })}\n`)
  );
  return 0;
}
