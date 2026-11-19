const TOOLS = [
  {
    name: 'get_price',
    description: 'Returns the current price of a product',
    inputSchema: { type: 'object', properties: { productId: { type: 'string' } } },
    origin: 'https://shop.example.com',
    annotations: { readOnlyHint: true },
  },
];

export default async function main(ctx) {
  const enc = new TextEncoder();
  const out = (value) => ctx.write(1, enc.encode(value));
  const args = ctx.argv.slice(1);
  if (args.includes('--version')) {
    await out(`playwright-cli ${ctx.env.FAKE_PWCLI_VERSION ?? '1.54.0'}-fake\n`);
    return 0;
  }
  if (args.includes('tab-list')) {
    await out('1: [TAB1] https://shop.example.com/ "Shop" (active)\n');
    return 0;
  }
  if (args.includes('eval-attach')) {
    const emit = (value) =>
      out(
        `${JSON.stringify({ tab: 'TAB1', frameId: 'TAB1', loaderId: 'L1', attachmentId: 'A1', ...value })}\n`
      );
    await emit({ event: 'ready' });
    if (ctx.env.FAKE_PWCLI_HOLDER_REFUSAL) await emit({ event: 'refused', reason: 'guard' });
    else {
      await emit({ event: 'document-ready' });
      await emit({
        event: 'message',
        payload: { type: 'tools-changed', origin: 'https://shop.example.com', tools: TOOLS },
      });
      if (args.includes('--frames'))
        await emit({
          event: 'refused',
          frameId: 'CHILD',
          parentFrameId: 'TAB1',
          reason: 'cross-origin child tools are unavailable',
        });
    }
    const reader = ctx.stdin.getReader();
    while (!(await reader.read()).done) {}
    return 0;
  }
  if (args.includes('eval-file')) {
    if (ctx.env.FAKE_PWCLI_DIALOG_URL)
      await ctx.fetch(ctx.env.FAKE_PWCLI_DIALOG_URL).then((r) => r.text());
    await new Promise(() => {});
  }
  if (args.includes('eval')) {
    const expression = args[args.indexOf('eval') + 1];
    await out(expression.includes('refresh') ? JSON.stringify({ tools: TOOLS }) : 'false');
    return 0;
  }
  return 2;
}
