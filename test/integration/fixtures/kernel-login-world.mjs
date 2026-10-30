const enc = new TextEncoder();
const dec = new TextDecoder();

const CIMD_URL = 'https://mcpcat.sliccy.ai/oauth/client.json';
const TAB = 'TAB9';
const DECOY = 'DECOY1';
const BROWSER_STATE = '/tmp/fake-browser.json';
const JERK_LOG = '/tmp/fake-jerk.ndjson';

function randomToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function json(status, value) {
  return {
    status,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(value),
  };
}

async function s256(text) {
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}

function authServer(ctx, seed) {
  const log = (line) => ctx.write(2, `${line}\n`);
  const codes = new Map();
  const clients = new Set([CIMD_URL]);

  function metadata(base) {
    return {
      issuer: base,
      authorization_endpoint: `${base}/authorize`,
      token_endpoint: `${base}/token`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      scopes_supported: ['bb'],
      authorization_response_iss_parameter_supported: true,
      ...(seed.dcr
        ? { registration_endpoint: `${base}/register` }
        : { client_id_metadata_document_supported: true }),
    };
  }

  function authorize(base, query) {
    const redirect = URL.parse(query.get('redirect_uri') ?? '');
    const valid =
      query.get('response_type') === 'code' &&
      clients.has(query.get('client_id')) &&
      query.get('code_challenge_method') === 'S256' &&
      query.get('code_challenge') &&
      query.get('state') &&
      redirect?.protocol === 'http:' &&
      redirect.hostname === '127.0.0.1';
    if (!valid) {
      log(`authorize rejected ${query.get('client_id')}`);
      return json(400, { error: 'invalid_request' });
    }
    const code = randomToken();
    codes.set(code, {
      challenge: query.get('code_challenge'),
      redirect: redirect.href,
      client: query.get('client_id'),
    });
    log(`authorize client=${query.get('client_id')} scope=${query.get('scope')}`);
    redirect.searchParams.set('code', code);
    redirect.searchParams.set('state', query.get('state'));
    redirect.searchParams.set('iss', base);
    return { status: 302, headers: { Location: redirect.href }, body: '' };
  }

  async function token(body) {
    const form = new URLSearchParams(body);
    const grant = codes.get(form.get('code'));
    codes.delete(form.get('code'));
    if (seed.tokenFailure) {
      log('token failing');
      return { status: 500, headers: {}, body: `echo ${body}` };
    }
    if (
      form.get('grant_type') !== 'authorization_code' ||
      !grant ||
      grant.client !== form.get('client_id') ||
      grant.redirect !== form.get('redirect_uri') ||
      grant.challenge !== (await s256(form.get('code_verifier') ?? ''))
    ) {
      log('token rejected');
      return json(400, { error: 'invalid_grant' });
    }
    log('token issued');
    return json(200, {
      access_token: randomToken(),
      token_type: 'Bearer',
      expires_in: 3600,
      refresh_token: randomToken(),
      scope: 'bb',
    });
  }

  return async function handle({ method, path, query, headers, body }) {
    const base = `http://${headers.host}`;
    if (path.startsWith('/.well-known/oauth-protected-resource')) {
      return json(200, {
        resource: `${base}/mcp`,
        authorization_servers: [base],
        scopes_supported: ['bb'],
      });
    }
    if (path === '/.well-known/oauth-authorization-server') return json(200, metadata(base));
    if (path === '/authorize') return authorize(base, query);
    if (method === 'POST' && path === '/token') return token(body);
    if (method === 'POST' && path === '/register') {
      const client = randomToken();
      clients.add(client);
      log('registered');
      return json(201, {
        client_id: client,
        redirect_uris: JSON.parse(body).redirect_uris,
        token_endpoint_auth_method: 'none',
      });
    }
    return json(404, { error: 'not_found' });
  };
}

function headerEnd(buf) {
  for (let i = 0; i + 3 < buf.length; i++) {
    if (buf[i] === 13 && buf[i + 1] === 10 && buf[i + 2] === 13 && buf[i + 3] === 10) return i;
  }
  return -1;
}

async function readRequest(reader) {
  let buf = new Uint8Array(0);
  for (;;) {
    const end = headerEnd(buf);
    if (end >= 0) {
      const head = dec.decode(buf.subarray(0, end));
      const length = /\r\ncontent-length:\s*(\d+)/i.exec(head);
      const need = end + 4 + (length ? Number(length[1]) : 0);
      if (buf.length >= need) {
        const lines = head.split('\r\n');
        const [method, target] = lines[0].split(' ');
        const headers = {};
        for (const line of lines.slice(1)) {
          const colon = line.indexOf(':');
          headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
        }
        const url = new URL(target, 'http://x');
        return {
          method,
          path: url.pathname,
          query: url.searchParams,
          headers,
          body: dec.decode(buf.subarray(end + 4, need)),
        };
      }
    }
    const { value, done } = await reader.read();
    if (done) return undefined;
    const next = new Uint8Array(buf.length + value.length);
    next.set(buf);
    next.set(value, buf.length);
    buf = next;
  }
}

async function serve(conn, handle) {
  const reader = conn.readable.getReader();
  const writer = conn.writable.getWriter();
  try {
    const req = await readRequest(reader);
    if (req) {
      const res = await handle(req);
      const body = enc.encode(res.body);
      let head = `HTTP/1.1 ${res.status} X\r\n`;
      for (const [k, v] of Object.entries(res.headers)) head += `${k}: ${v}\r\n`;
      head += `Content-Length: ${body.length}\r\nConnection: close\r\n\r\n`;
      await writer.write(enc.encode(head));
      await writer.write(body);
    }
    await writer.close();
  } catch {
  } finally {
    conn.close();
  }
}

async function runAuthServer(ctx) {
  const handle = authServer(ctx, JSON.parse(ctx.argv[1] ?? '{}'));
  const listener = await ctx.net.listen({ port: 0, host: '127.0.0.1' });
  await ctx.write(1, `${JSON.stringify({ port: listener.port })}\n`);
  for (;;) {
    const conn = await listener.accept();
    void serve(conn, handle);
  }
}

async function follow(ctx, href) {
  const url = new URL(href);
  const conn = await ctx.net.connect({ host: '127.0.0.1', port: Number(url.port) });
  const writer = conn.writable.getWriter();
  await writer.write(
    enc.encode(`GET ${url.pathname}${url.search} HTTP/1.1\r\nHost: ${url.host}\r\n\r\n`)
  );
  const reader = conn.readable.getReader();
  let text = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    text += dec.decode(value);
  }
  conn.close();
  return /\r\nlocation:\s*(\S+)/i.exec(text)?.[1];
}

function tampered(href, mode) {
  const url = new URL(href);
  if (mode === 'wrong-state') url.searchParams.set('state', 'not-this-sign-in');
  if (mode === 'wrong-iss') url.searchParams.set('iss', 'https://evil.example');
  if (mode === 'denied') {
    url.search = '';
    url.searchParams.set('error', 'access_denied');
    url.searchParams.set('error_description', 'the user said no');
  }
  return url.href;
}

async function readBrowser(ctx) {
  try {
    return JSON.parse(dec.decode(await ctx.fs.readFile(BROWSER_STATE)));
  } catch {
    return { url: 'about:blank', closed: false, calls: [] };
  }
}

async function runBrowser(ctx) {
  const args = ctx.argv.slice(1);
  const mode = ctx.env.FAKE_BROWSER ?? 'ok';
  const state = await readBrowser(ctx);
  const [command] = args;
  const save = () => ctx.fs.writeFile(BROWSER_STATE, JSON.stringify(state));
  state.calls.push(command);
  if (command === 'open') {
    await save();
    if (mode === 'refuse') {
      await ctx.write(2, 'navigate: refused\n');
      return 1;
    }
    await ctx.write(1, `Opened about:blank in new tab [targetId: ${TAB}]\n`);
    return 0;
  }
  if (command === 'goto') {
    if (mode === 'closed') state.closed = true;
    else if (mode !== 'hold') state.url = tampered(await follow(ctx, args[1]), mode);
    await save();
    return mode === 'ok' ? 1 : 0;
  }
  if (command === 'tab-list') {
    await save();
    if (mode === 'blind') return 1;
    const lines = [`1: [${DECOY}] http://127.0.0.1:1/callback?code=decoy "other"`];
    if (!state.closed) {
      const shown = args.includes('--full-urls') ? state.url : state.url.split('?')[0];
      lines.push(`2: [${TAB}] ${shown} "sign-in" (active)`);
    }
    await ctx.write(1, `${lines.join('\n')}\n`);
    return 0;
  }
  if (command === 'close') {
    state.closed = args.includes(TAB);
    await save();
    return 0;
  }
  return 2;
}

async function readAll(stream) {
  const reader = stream.getReader();
  let text = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return text;
    text += dec.decode(value, { stream: true });
  }
}

async function runJerk(ctx) {
  const [, id, verb, flag] = ctx.argv;
  const mode = ctx.env.FAKE_JERK ?? 'ok';
  if (verb !== 'import' || mode === 'old') {
    await ctx.write(2, `jerk: unknown command ${verb}\n`);
    return 2;
  }
  if (flag === '--check') return 0;
  if (mode === 'locked') {
    await ctx.write(2, "jerk: seven's vault is locked\n");
    return 4;
  }
  const grant = JSON.parse(await readAll(ctx.stdin));
  await ctx.fs.writeFile(JERK_LOG, JSON.stringify({ argv: ctx.argv, id, grant }));
  return 0;
}

async function runUser(ctx) {
  const child = await ctx.spawn({
    argv: ['mcpcat', 'login', ...ctx.argv.slice(1)],
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const reader = child.stderr.getReader();
  const stdout = readAll(child.stdout);
  const writer = child.stdin.getWriter();
  let stderr = '';
  let pasted = false;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    stderr += dec.decode(value, { stream: true });
    const match = /(http:\/\/127\.0\.0\.1:\d+\/authorize\S+)/.exec(stderr);
    if (match && !pasted) {
      pasted = true;
      const landed = tampered(await follow(ctx, match[1]), ctx.env.FAKE_USER ?? 'ok');
      await writer.write(enc.encode(`${landed}\n`));
    }
  }
  const { status } = await child.wait();
  await ctx.write(1, `${await stdout}`);
  await ctx.write(2, stderr);
  return status;
}

async function runFiles(ctx) {
  const [, verb, ...paths] = ctx.argv;
  if (verb === 'exists') return (await ctx.fs.exists(paths[0])) ? 0 : 1;
  for (const path of paths) {
    if (await ctx.fs.exists(path)) await ctx.fs.unlink(path);
  }
  return 0;
}

export default function main(ctx) {
  const programs = {
    'login-as': runAuthServer,
    'playwright-cli': runBrowser,
    jerk: runJerk,
    'login-user': runUser,
    'login-files': runFiles,
  };
  return programs[ctx.argv[0]](ctx);
}
