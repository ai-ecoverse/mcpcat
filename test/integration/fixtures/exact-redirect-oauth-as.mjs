import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const clients = new Map();
const codes = new Map();
const access = new Map();
const refresh = new Map();
const flags = [];
const reqlog = [];
let base = '';

const tok = (p) => `${p}_${randomBytes(18).toString('base64url')}`;
const b64url = (b) => Buffer.from(b).toString('base64url');

function json(res, status, obj) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function issue(clientId, resource, scope) {
  const at = tok('cat');
  const rt = tok('crt');
  access.set(at, { exp: Date.now() + 3600_000, clientId, resource });
  refresh.set(rt, { state: 'live', clientId, resource });
  return {
    access_token: at,
    token_type: 'Bearer',
    expires_in: 3600,
    refresh_token: rt,
    ...(scope ? { scope } : {}),
  };
}

function rs(req, res, body) {
  const auth = req.headers.authorization || '';
  const t = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const a = access.get(t);
  if (!a || a.exp <= Date.now()) {
    res.writeHead(401, {
      'www-authenticate': `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
      'content-type': 'text/plain',
    });
    res.end('unauthorized');
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end();
    return;
  }
  const msg = JSON.parse(body || '{}');
  const { id, method } = msg;
  if (id === undefined) {
    res.writeHead(202);
    res.end();
    return;
  }
  const r = (result) => json(res, 200, { jsonrpc: '2.0', id, result });
  if (method === 'initialize')
    return r({
      protocolVersion: '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: 'exact-redirect', version: '1.0.0' },
    });
  if (method === 'tools/list')
    return r({
      tools: [
        { name: 'whoami', description: 'who', inputSchema: { type: 'object', properties: {} } },
      ],
    });
  if (method === 'tools/call' && msg.params?.name === 'whoami')
    return r({ content: [{ type: 'text', text: `user:${a.clientId}` }] });
  return json(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'nf' } });
}

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => {
    body += c;
  });
  req.on('end', () => {
    const u = new URL(req.url, base);
    const p = u.pathname;
    reqlog.push({ method: req.method, path: p });
    if (p === '/log')
      return json(res, 200, {
        flags,
        clients: [...clients.values()],
        reqlog,
      });
    if (p.startsWith('/.well-known/oauth-protected-resource'))
      return json(res, 200, {
        resource: `${base}/mcp`,
        authorization_servers: [base],
        scopes_supported: ['mcp:access', 'openid', 'profile', 'email'],
        bearer_methods_supported: ['header'],
      });
    if (
      p.startsWith('/.well-known/oauth-authorization-server') ||
      p.startsWith('/.well-known/openid-configuration')
    ) {
      return json(res, 200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        registration_endpoint: `${base}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: ['mcp:access', 'openid', 'profile', 'email'],
      });
    }
    if (p === '/register' && req.method === 'POST') {
      const m = JSON.parse(body || '{}');
      const redirectUris = m.redirect_uris || [];
      if (redirectUris.some((ru) => /:0(?:\/|$)/.test(ru))) {
        flags.push({ register: 'port-zero' });
        return json(res, 400, { error: 'invalid_redirect_uri' });
      }
      const id = tok('cid');
      clients.set(id, {
        client_id: id,
        redirect_uris: redirectUris,
        token_endpoint_auth_method: 'none',
      });
      return json(res, 201, {
        client_id: id,
        redirect_uris: redirectUris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      });
    }
    if (p === '/authorize') {
      const q = u.searchParams;
      const c = clients.get(q.get('client_id'));
      const ru = q.get('redirect_uri');
      if (!c?.redirect_uris?.includes(ru)) {
        flags.push({ authorize: 'invalid_redirect_uri', registered: c?.redirect_uris, sent: ru });
        return json(res, 400, { error: 'invalid_redirect_uri' });
      }
      if (
        q.get('code_challenge_method') !== 'S256' ||
        (q.get('code_challenge') || '').length !== 43
      ) {
        flags.push({ authorize: 'pkce' });
        return json(res, 400, { error: 'invalid_request' });
      }
      const code = tok('code');
      codes.set(code, {
        clientId: c.client_id,
        challenge: q.get('code_challenge'),
        redirect: ru,
        resource: q.get('resource'),
        scope: q.get('scope'),
      });
      res.writeHead(302, {
        location: `${ru}${ru.includes('?') ? '&' : '?'}code=${code}&state=${encodeURIComponent(q.get('state') || '')}`,
      });
      res.end();
      return;
    }
    if (p === '/token' && req.method === 'POST') {
      const f = new URLSearchParams(body);
      if (f.get('grant_type') === 'authorization_code') {
        const c = codes.get(f.get('code'));
        if (!c) return json(res, 400, { error: 'invalid_grant' });
        codes.delete(f.get('code'));
        const ver = f.get('code_verifier') || '';
        if (b64url(createHash('sha256').update(ver).digest()) !== c.challenge) {
          return json(res, 400, { error: 'invalid_grant' });
        }
        if (f.get('redirect_uri') !== c.redirect) {
          flags.push('token-redirect-mismatch');
          return json(res, 400, { error: 'invalid_grant' });
        }
        return json(res, 200, issue(c.clientId, f.get('resource') || c.resource, c.scope));
      }
      if (f.get('grant_type') === 'refresh_token') {
        const s = refresh.get(f.get('refresh_token'));
        if (s?.state !== 'live') return json(res, 400, { error: 'invalid_grant' });
        s.state = 'used';
        return json(res, 200, issue(s.clientId, s.resource));
      }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }
    if (p === '/mcp') return rs(req, res, body);
    json(res, 404, { error: 'not_found' });
  });
});

server.listen(0, '127.0.0.1', () => {
  const port = server.address().port;
  base = `http://127.0.0.1:${port}`;
  console.log(JSON.stringify({ port }));
});
