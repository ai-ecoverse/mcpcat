export default async function main(ctx) {
  const deadlineMs = 15_000;
  const proc = await ctx.spawn({
    argv: ['mcpcat', ...ctx.argv.slice(1)],
    stdin: 'null',
    stdout: 'inherit',
    stderr: 'pipe',
  });

  const out = ctx.stderr.getWriter();
  const reader = proc.stderr.getReader();
  const decoder = new TextDecoder();
  let seen = '';
  let signalled = false;

  const timer = setTimeout(async () => {
    if (signalled) return;
    await out.write(
      new TextEncoder().encode(`sigint-runner: no progress line within ${deadlineMs} ms\n`)
    );
    try {
      ctx.kill(proc.pid, 'SIGKILL');
    } catch {}
  }, deadlineMs);

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    await out.write(value);
    seen += decoder.decode(value, { stream: true });
    if (!signalled && /progress:/.test(seen)) {
      signalled = true;
      clearTimeout(timer);
      try {
        ctx.kill(proc.pid, 'SIGINT');
      } catch {}
    }
  }

  clearTimeout(timer);
  const result = await proc.wait();
  out.releaseLock();
  return signalled ? result.status : 125;
}
