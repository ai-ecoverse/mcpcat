export default async function main(ctx) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const args = ctx.argv.slice(1);
  if (args[0] === '--version') {
    await ctx.write(1, enc.encode('jerk 1.3.2\n'));
    return 0;
  }
  if (args[0] === '--log') {
    const prefix = `fake-jerk.${args[1]}.`;
    const names = (await ctx.fs.readdir('/tmp')).filter((name) => name.startsWith(prefix));
    for (const name of names) await ctx.write(1, await ctx.fs.readFile(`/tmp/${name}`));
    return 0;
  }
  const state = JSON.parse(dec.decode(await ctx.fs.readFile('/etc/fake-jerk.json')));
  await ctx.fs.writeFile(
    `/tmp/fake-jerk.${ctx.env.FAKE_JERK_EPOCH}.${ctx.pid}`,
    enc.encode(`${args.join(' ')} config=${ctx.env.PI_MCP_CONFIG ?? ''}\n`)
  );
  if (args[0] === 'list') {
    await ctx.write(1, enc.encode(JSON.stringify(state.list)));
    return 0;
  }
  if (args[1] === 'get' && state.get[args[0]]) {
    const { exit, stdout, stderr } = state.get[args[0]];
    await ctx.write(1, enc.encode(stdout ?? ''));
    await ctx.write(2, enc.encode(stderr ?? ''));
    return exit;
  }
  await ctx.write(2, enc.encode(`jerk: ${args[0]}: no sealed record\n`));
  return 3;
}
