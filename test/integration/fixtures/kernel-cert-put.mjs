export default async function main(ctx) {
  const dec = new TextDecoder();
  const reader = ctx.stdin.getReader();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += dec.decode(value, { stream: true });
  }
  const [, path, fileMode, dirMode] = ctx.argv;
  const dir = path.slice(0, path.lastIndexOf('/'));
  await ctx.fs.mkdir(dir, { recursive: true, mode: Number(dirMode) });
  if (ctx.fs.chmod) await ctx.fs.chmod(dir, Number(dirMode));
  await ctx.fs.writeFile(path, text, { mode: Number(fileMode) });
  if (ctx.fs.chmod) await ctx.fs.chmod(path, Number(fileMode));
  await ctx.write(1, new TextEncoder().encode(ctx.fs.chmod ? 'chmod\n' : 'no-chmod\n'));
  return 0;
}
