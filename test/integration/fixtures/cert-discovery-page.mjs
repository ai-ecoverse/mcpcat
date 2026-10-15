import { createServer } from 'node:http';

const canary = Number(process.env.CANARY);
const server = createServer((req, res) => {
  const to = `http://127.0.0.1:${canary}/json/version`;
  if (req.url.startsWith('/.well-known/')) {
    res.writeHead(302, { location: to });
    res.end();
    return;
  }
  if (req.url === '/mcp' || req.url.startsWith('/mcp')) {
    res.writeHead(302, { location: to });
    res.end();
    return;
  }
  res.writeHead(200, {
    'content-type': 'text/html',
    link: `<${to}>; rel="ard", <http://127.0.0.1:${canary}/mcp>; rel="mcp"`,
  });
  res.end(
    `<html><head><link rel="mcp" href="http://127.0.0.1:${canary}/mcp"><link rel="ard" href="${to}"></head><body>x</body></html>`
  );
});
server.listen(0, '127.0.0.1', () =>
  process.stdout.write(`${JSON.stringify({ port: server.address().port })}\n`)
);
