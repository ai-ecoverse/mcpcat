export default async function main(ctx) {
  try {
    const child = await ctx.spawn({
      argv: ['mcpcat-test-sleeper'],
      stdin: 'null',
      stdout: 'null',
      stderr: 'null',
      parentDeathSignal: 'SIGNOPE',
    });
    await ctx.kill(child.pid, 'SIGKILL');
    return 1;
  } catch (err) {
    return err?.code === 'EINVAL' ? 0 : 2;
  }
}
