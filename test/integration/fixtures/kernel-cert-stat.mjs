export default async function main(ctx) {
  const lines = [];
  for (const path of ctx.argv.slice(1)) {
    try {
      const st = await ctx.fs.stat(path);
      lines.push(`${path}\t${(st.mode & 0o777).toString(8)}`);
    } catch (error) {
      lines.push(`${path}\t${error.code || error.message}`);
    }
  }
  await ctx.write(1, new TextEncoder().encode(`${lines.join('\n')}\n`));
  return 0;
}
