export default async function main(ctx) {
  const enc = new TextEncoder();
  const [, cmd, ...rest] = ctx.argv;
  if (cmd === '--mcp') {
    const commands = [
      {
        name: 'echo',
        description: 'Echo the text argument',
        positionals: [{ name: 'text', required: true }],
        flags: [],
      },
    ];
    await ctx.write(1, enc.encode(`${JSON.stringify({ commands })}\n`));
    return 0;
  }
  if (cmd === 'echo') {
    await ctx.write(1, enc.encode(`${rest.join(' ')}\n`));
    return 0;
  }
  return 2;
}
