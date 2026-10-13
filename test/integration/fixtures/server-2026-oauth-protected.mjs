import { createServer } from 'node:http';

const PORT = 0;
let serverPort;
let asOrigin;
const validTokens = new Set();
let stepUpRequired = false;
let stepUpScope = 'admin';

function jsonRpc(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function jsonRpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(body));
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${serverPort}`);

  if (url.pathname === '/.well-known/oauth-protected-resource') {
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        resource: `http://127.0.0.1:${serverPort}/mcp`,
        authorization_servers: [asOrigin],
      })
    );
    return;
  }

  if (url.pathname === '/_control/token' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    if (body.add) validTokens.add(body.add);
    if (body.remove) validTokens.delete(body.remove);
    if (body.stepUp !== undefined) stepUpRequired = body.stepUp;
    if (body.stepUpScope) stepUpScope = body.stepUpScope;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname === '/_control/expire-all' && req.method === 'POST') {
    validTokens.clear();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (url.pathname !== '/mcp' || req.method !== 'POST') {
    res.statusCode = 404;
    res.end();
    return;
  }

  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    res.statusCode = 401;
    res.setHeader(
      'WWW-Authenticate',
      `Bearer resource_metadata="http://127.0.0.1:${serverPort}/.well-known/oauth-protected-resource"`
    );
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }

  const token = auth.slice(7);
  if (!validTokens.has(token)) {
    res.statusCode = 401;
    res.setHeader('WWW-Authenticate', 'Bearer error="invalid_token"');
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'invalid_token' }));
    return;
  }

  if (stepUpRequired) {
    res.statusCode = 403;
    res.setHeader(
      'WWW-Authenticate',
      `Bearer error="insufficient_scope", scope="${stepUpScope}", resource_metadata="http://127.0.0.1:${serverPort}/.well-known/oauth-protected-resource"`
    );
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: 'insufficient_scope' }));
    return;
  }

  const body = JSON.parse(await readBody(req));
  res.setHeader('Content-Type', 'application/json');

  if (body.method === 'server/discover') {
    res.end(
      jsonRpc(body.id, {
        supportedVersions: ['2026-07-28'],
        serverInfo: { name: 'protected-2026-server', version: '1.0.0' },
        capabilities: { tools: {} },
      })
    );
    return;
  }

  if (body.method === 'initialize') {
    res.end(jsonRpcError(body.id, -32601, 'Method not found: initialize'));
    return;
  }

  if (body.method === 'tools/list') {
    res.end(
      jsonRpc(body.id, {
        tools: [
          {
            name: 'echo',
            description: 'Echo back the input',
            inputSchema: { type: 'object', properties: { text: { type: 'string' } } },
          },
        ],
      })
    );
    return;
  }

  if (body.method === 'tools/call') {
    const text = body.params?.arguments?.text ?? '';
    res.end(
      jsonRpc(body.id, {
        content: [{ type: 'text', text }],
      })
    );
    return;
  }

  res.end(jsonRpcError(body.id, -32601, 'Method not found'));
});

server.listen(PORT, '127.0.0.1', () => {
  serverPort = server.address().port;
  asOrigin = process.argv[2] || `http://127.0.0.1:${serverPort}`;
  console.log(JSON.stringify({ port: serverPort, asOrigin }));
});

process.on('SIGTERM', () => {
  server.close();
  process.exit(0);
});
