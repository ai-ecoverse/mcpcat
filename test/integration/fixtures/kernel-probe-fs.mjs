export default async function main(ctx) {
  const [, op, path, mode] = ctx.argv;
  try {
    if (op === 'rm' && (await ctx.fs.exists(path))) await ctx.fs.rm(path);
    if (op === 'mkdir') await ctx.fs.mkdir(path);
    if (op === 'chmod') await ctx.fs.chmod(path, Number.parseInt(mode, 8));
    return 0;
  } catch (e) {
    await ctx.write(2, new TextEncoder().encode(`kernel-probe-fs: ${e.code || e.message}\n`));
    return 1;
  }
}
