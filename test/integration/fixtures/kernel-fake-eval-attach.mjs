export default async function main(ctx) {
  const enc = new TextEncoder();
  const args = ctx.argv.slice(1);
  const value = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  if (args.includes('--version')) {
    await ctx.write(1, enc.encode('playwright-cli 1.51.0\n'));
    return 0;
  }
  if (!args.includes('eval-attach')) {
    await ctx.write(2, enc.encode(`unsupported: ${args.join(' ')}\n`));
    return 2;
  }
  const file = args[args.indexOf('eval-attach') + 1];
  const source = await ctx.fs.readFile(file);
  const text = typeof source === 'string' ? source : new TextDecoder().decode(source);
  const world = value('--world');
  const attachmentId = `eval-${world}`;
  const lines = [
    { event: 'ready', attachmentId, world, early: false },
    {
      event: 'document-ready',
      attachmentId,
      tab: 'TAB1',
      frameId: 'TAB1',
      loaderId: 'L1',
      url: 'https://shop.example.com/',
      world,
      early: false,
    },
  ];
  if (world === 'isolated') {
    const annotation = {
      id: 'k1',
      kind: 'element',
      comment: `bytes ${text.length}`,
      target: { selector: 'main' },
    };
    lines.unshift({
      event: 'message',
      attachmentId,
      tab: 'TAB1',
      payload: { type: 'annotation', annotation },
    });
  }
  await ctx.write(1, enc.encode(lines.map((l) => `${JSON.stringify(l)}\n`).join('')));
  const reader = ctx.stdin.getReader();
  for (;;) {
    const { done } = await reader.read();
    if (done) break;
  }
  return 0;
}
