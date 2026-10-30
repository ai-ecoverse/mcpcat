export default async function main(ctx) {
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  const args = ctx.argv.slice(1);
  if (args[0] === '--version') {
    await ctx.write(1, enc.encode('jerk 1.3.2\n'));
    return 0;
  }
  const state = JSON.parse(dec.decode(await ctx.fs.readFile('/etc/fake-jerk.json')));
  const log = await ctx.fs.readFile('/tmp/fake-jerk.log').catch(() => new Uint8Array());
  await ctx.fs.writeFile(
    '/tmp/fake-jerk.log',
    enc.encode(`${dec.decode(log)}${args.join(' ')} config=${ctx.env.PI_MCP_CONFIG ?? ''}\n`)
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
