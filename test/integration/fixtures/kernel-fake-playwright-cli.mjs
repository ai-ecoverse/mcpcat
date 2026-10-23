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
  const out = (text) => ctx.write(1, enc.encode(text));
  const args = ctx.argv.slice(1);
  const command = args.find((a) => !a.startsWith('-') && !/^(ws|http)/.test(a) && a !== 'TAB1');
  if (args.includes('--version')) {
    await out('playwright-cli 1.32.0-fake\n');
    return 0;
  }
  if (command === 'webmcp-polyfill') {
    await out('{"event":"ready","loaderId":"L1","mode":"native","tab":"TAB1","late":true}\n');
    return 0;
  }
  if (command === 'tab-list') {
    await out('1: [TAB1] https://shop.example.com/ "Shop" (active)\n');
    return 0;
  }
  if (command === 'webmcp-list') {
    await out(JSON.stringify(TOOLS));
    return 0;
  }
  if (command === 'webmcp-call') {
    const dialogUrl = ctx.env.FAKE_PWCLI_DIALOG_URL;
    if (dialogUrl) await ctx.fetch(dialogUrl).then((r) => r.text());
    await new Promise(() => {});
  }
  await ctx.write(2, enc.encode(`unknown command: ${command}\n`));
  return 2;
}
