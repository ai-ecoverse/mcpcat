export default async function main(ctx) {
  const decoder = new TextDecoder();
  const reader = ctx.stdin.getReader();
  let input = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    input += decoder.decode(value, { stream: true });
  }
  const { MCPCAT_EVENT_ID: id, MCPCAT_EVENT_NAME: name, MCPCAT_EVENT_CURSOR: cursor } = ctx.env;
  const n = JSON.parse(input).data.n;
  await ctx.write(1, new TextEncoder().encode(`${id} ${name} ${cursor ?? '-'} ${n}\n`));
  return 0;
}
