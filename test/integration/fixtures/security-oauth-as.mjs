import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const MODE = process.env.ROW_AS_MODE || '';
const TTL = Number(process.env.ROW_AS_TTL || 3600);
const clients = new Map();
const codes = new Map();
const access = new Map();
const refresh = new Map();
const issued = [];
const reqlog = [];
const flags = [];
let base = '';

const tok = (p) => `${p}_${randomBytes(18).toString('base64url')}`;
const b64url = (b) => Buffer.from(b).toString('base64url');

function json(res, status, obj, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(obj));
}

function issue(clientId, resource, scope) {
  const at = tok('cat');
  const rt = tok('crt');
  access.set(at, { exp: Date.now() + TTL * 1000, clientId, resource });
  refresh.set(rt, { state: 'live', clientId, resource });
  issued.push(at, rt);
  return {
    access_token: at,
    token_type: 'Bearer',
    expires_in: TTL,
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
    res.end(process.env.ROW_RS_ECHO401 ? `invalid_token ${auth}` : 'unauthorized');
    return;
  }
  if (req.method !== 'POST') {
    res.writeHead(405);
    res.end();
    return;
  }
  const msg = JSON.parse(body || '{}');
  const { id, method, params } = msg;
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
      serverInfo: { name: 'security-oauth', version: '1.0.0' },
    });
  if (method === 'tools/list')
    return r({
      tools: [
        { name: 'whoami', description: 'who', inputSchema: { type: 'object', properties: {} } },
        {
          name: 'fail',
          description: 'reflects auth',
          inputSchema: { type: 'object', properties: {} },
        },
      ],
    });
  if (method === 'tools/call') {
    if (params?.name === 'whoami')
      return r({ content: [{ type: 'text', text: `user:${a.clientId}` }] });
    if (params?.name === 'fail')
      return json(res, 200, {
        jsonrpc: '2.0',
        id,
        error: { code: -32000, message: `fail ${auth}` },
      });
  }
  return json(res, 200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'nf' } });
}

const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => {
    body += c;
  });
  req.on('end', () => {
    const u = new URL(req.url, base);
    reqlog.push({
      method: req.method,
      path: u.pathname,
      auth: req.headers.authorization ? 'present' : 'none',
      at: Date.now(),
    });
    const p = u.pathname;
    if (p === '/log')
      return json(res, 200, {
        reqlog,
        issued,
        refresh: Object.fromEntries([...refresh].map(([k, v]) => [k, v.state])),
        flags,
        clients: [...clients.values()],
      });
    if (p.startsWith('/.well-known/oauth-protected-resource'))
      return json(res, 200, {
        resource: `${base}/mcp`,
        authorization_servers: [base],
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
      });
    }
    if (p === '/register' && req.method === 'POST') {
      const m = JSON.parse(body || '{}');
      const id = tok('cid');
      clients.set(id, {
        client_id: id,
        redirect_uris: m.redirect_uris || [],
        token_endpoint_auth_method: m.token_endpoint_auth_method,
      });
      return json(res, 201, {
        client_id: id,
        redirect_uris: m.redirect_uris,
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      });
    }
    if (p === '/authorize') {
      const q = u.searchParams;
      const c = clients.get(q.get('client_id'));
      const ru = q.get('redirect_uri');
      const problems = [];
      if (!c) problems.push('client');
      if (c && !c.redirect_uris.includes(ru)) problems.push('redirect');
      if (
        q.get('code_challenge_method') !== 'S256' ||
        (q.get('code_challenge') || '').length !== 43
      )
        problems.push('pkce');
      if ((q.get('state') || '').length < 16) problems.push('state');
      if (q.get('response_type') !== 'code') problems.push('response_type');
      if (problems.length) {
        flags.push({ authorize: problems });
        return json(res, 400, { error: 'invalid_request', problems });
      }
      const code = tok('code');
      codes.set(code, {
        clientId: c.client_id,
        challenge: q.get('code_challenge'),
        redirect: ru,
        resource: q.get('resource'),
        scope: q.get('scope'),
      });
      let target = ru;
      let state = q.get('state');
      if (MODE === 'bad-state') state = `${state}x`;
      if (MODE === 'evil-redirect') target = 'http://127.0.0.1:1/evil';
      res.writeHead(302, {
        location: `${target}${target.includes('?') ? '&' : '?'}code=${code}&state=${encodeURIComponent(state)}`,
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
          flags.push('pkce-mismatch');
          return json(res, 400, { error: 'invalid_grant' });
        }
        if (f.get('redirect_uri') !== c.redirect) {
          flags.push('redirect-mismatch');
          return json(res, 400, { error: 'invalid_grant' });
        }
        if (f.get('client_id') !== c.clientId) {
          flags.push('client-mismatch');
          return json(res, 400, { error: 'invalid_client' });
        }
        return json(res, 200, issue(c.clientId, f.get('resource') || c.resource, c.scope));
      }
      if (f.get('grant_type') === 'refresh_token') {
        const rt = f.get('refresh_token');
        const s = refresh.get(rt);
        if (!s) return json(res, 400, { error: 'invalid_grant' });
        if (s.state !== 'live') {
          flags.push('refresh-reuse');
          return json(res, 400, { error: 'invalid_grant' });
        }
        s.state = 'used';
        return json(res, 200, issue(s.clientId, s.resource));
      }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }
    if (p === '/forbidden') {
      res.writeHead(403, { 'content-type': 'text/plain' });
      res.end('Forbidden');
      return;
    }
    if (p === '/mcp') return rs(req, res, body);
    res.writeHead(404);
    res.end();
  });
});

server.listen(0, '127.0.0.1', () => {
  base = `http://127.0.0.1:${server.address().port}`;
  process.stdout.write(`${JSON.stringify({ port: server.address().port })}\n`);
});
process.on('SIGTERM', () => process.exit(0));
