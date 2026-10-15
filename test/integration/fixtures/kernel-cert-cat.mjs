export default async function main(ctx) {
  try {
    const d = await ctx.fs.readFile(ctx.argv[1]);
    await ctx.write(1, typeof d === 'string' ? new TextEncoder().encode(d) : d);
    return 0;
  } catch (e) {
    await ctx.write(2, new TextEncoder().encode(`kernel-cert-cat: ${e.code || e.message}\n`));
    return 1;
  }
}
