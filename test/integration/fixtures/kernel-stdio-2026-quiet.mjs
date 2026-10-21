export default async function main(ctx) {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const reader = ctx.stdin.getReader();
  const writer = ctx.stdout.getWriter();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        nl = buffer.indexOf('\n');
        if (!line.trim()) continue;
        const msg = JSON.parse(line);
        if (msg.method !== 'server/discover') continue;
        const result = { supportedVersions: ['2026-07-28'], capabilities: { tools: {} } };
        await writer.write(
          encoder.encode(`${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result })}\n`)
        );
      }
    }
  } finally {
    reader.releaseLock();
    writer.releaseLock();
  }
  return 0;
}
