const enc = new TextEncoder();
const dec = new TextDecoder();

function randomToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function json(status, value, headers = {}) {
  return {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(value),
  };
}

function rpc(id, result) {
  return json(200, { jsonrpc: '2.0', id, result });
}

export function createHandler(seed, log) {
  const ttl = seed.ttl ?? 4;
  const access = new Map();
  const refresh = new Set([seed.refreshToken]);

  function issue() {
    const accessToken = randomToken();
    const refreshToken = randomToken();
    access.set(accessToken, Date.now() + ttl * 1000);
    refresh.add(refreshToken);
    return {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ttl,
      refresh_token: refreshToken,
    };
  }

  function token(headers, body) {
    const type = headers['content-type'] ?? '';
    if (!type.includes('application/x-www-form-urlencoded')) {
      log(`token rejected content-type ${type || '(none)'}`);
      return json(400, { error: 'invalid_request' });
    }
    const params = new URLSearchParams(body);
    if (params.get('grant_type') !== 'refresh_token') {
      log(`token rejected grant ${params.get('grant_type')}`);
      return json(400, { error: 'unsupported_grant_type' });
    }
    if (params.get('client_id') !== seed.clientId) {
      log('token rejected client_id');
      return json(401, { error: 'invalid_client' });
    }
    const presented = params.get('refresh_token');
    if (!refresh.has(presented)) {
      log('token rejected refresh_token');
      return json(400, { error: 'invalid_grant' });
    }
    refresh.delete(presented);
    log('token refresh_token');
    return json(200, issue());
  }

  function mcp(base, headers, body) {
    const auth = headers.authorization ?? '';
    const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    const expires = access.get(bearer);
    if (!expires || expires <= Date.now()) {
      return json(
        401,
        { error: 'invalid_token' },
        {
          'WWW-Authenticate': `Bearer error="invalid_token", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`,
        }
      );
    }
    const { id, method, params } = JSON.parse(body);
    if (method === 'server/discover') {
      return rpc(id, {
        supportedVersions: ['2026-07-28'],
        serverInfo: { name: 'kernel-oauth', version: '1.0.0' },
        capabilities: { tools: {} },
      });
    }
    if (method === 'tools/list') {
      return rpc(id, {
        tools: [
          {
            name: 'echo',
            inputSchema: {
              type: 'object',
              properties: { message: { type: 'string' } },
              required: ['message'],
            },
          },
        ],
      });
    }
    if (method === 'tools/call' && params?.name === 'echo') {
      return rpc(id, { content: [{ type: 'text', text: params.arguments?.message ?? '' }] });
    }
    return json(200, { jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found' } });
  }

  return function handle({ method, path, headers, body }) {
    const base = `http://${headers.host}`;
    if (method === 'GET' && path.startsWith('/.well-known/oauth-protected-resource')) {
      return json(200, { resource: `${base}/mcp`, authorization_servers: [base] });
    }
    if (method === 'GET' && path === '/.well-known/oauth-authorization-server') {
      return json(200, {
        issuer: base,
        authorization_endpoint: `${base}/authorize`,
        token_endpoint: `${base}/token`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
      });
    }
    if (method === 'POST' && path === '/token') return token(headers, body);
    if (method === 'POST' && path === '/mcp') return mcp(base, headers, body);
    return json(404, { error: 'not_found' });
  };
}

function indexOfCrlf2(buf, len) {
  for (let i = 0; i + 3 < len; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) return i;
  }
  return -1;
}

async function readRequest(reader) {
  let buf = new Uint8Array(0);
  let end = -1;
  let need = Number.POSITIVE_INFINITY;
  for (;;) {
    if (end < 0) {
      end = indexOfCrlf2(buf, buf.length);
      if (end >= 0) {
        const head = dec.decode(buf.subarray(0, end));
        const length = /\r\ncontent-length:\s*(\d+)/i.exec(head);
        need = end + 4 + (length ? Number(length[1]) : 0);
      }
    }
    if (buf.length >= need) break;
    const { value, done } = await reader.read();
    if (done) break;
    const next = new Uint8Array(buf.length + value.length);
    next.set(buf);
    next.set(value, buf.length);
    buf = next;
  }
  if (end < 0) return undefined;
  const lines = dec.decode(buf.subarray(0, end)).split('\r\n');
  const [method, target] = lines[0].split(' ');
  const headers = {};
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon > 0)
      headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
  }
  const body = dec.decode(buf.subarray(end + 4, need));
  return { method, path: new URL(target, 'http://x').pathname, headers, body };
}

function serialize(res) {
  const body = enc.encode(res.body);
  let head = `HTTP/1.1 ${res.status} X\r\n`;
  for (const [k, v] of Object.entries(res.headers)) head += `${k}: ${v}\r\n`;
  head += `Content-Length: ${body.length}\r\nConnection: close\r\n\r\n`;
  const headBytes = enc.encode(head);
  const out = new Uint8Array(headBytes.length + body.length);
  out.set(headBytes);
  out.set(body, headBytes.length);
  return out;
}

async function serve(conn, handle) {
  const reader = conn.readable.getReader();
  const writer = conn.writable.getWriter();
  try {
    const req = await readRequest(reader);
    if (req) await writer.write(serialize(handle(req)));
    await writer.close();
  } catch {
  } finally {
    conn.close();
  }
}

export default async function main(ctx) {
  const seed = JSON.parse(dec.decode(await ctx.fs.readFile(ctx.argv[1])));
  const handle = createHandler(seed, (line) => {
    ctx.write(2, `${line}\n`);
  });
  const listener = await ctx.net.listen({ port: 0, host: '127.0.0.1' });
  await ctx.write(1, `${JSON.stringify({ port: listener.port })}\n`);
  for (;;) {
    const conn = await listener.accept();
    void serve(conn, handle);
  }
}
