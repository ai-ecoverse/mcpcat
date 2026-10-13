import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';

const PORT = 0;
const ISSUER_BASE = 'http://127.0.0.1';
let issuerPort;

let sendIss = true;
let cimdSupported = true;
const tokens = new Map();
const refreshTokens = new Map();
const clients = new Map();
const codes = new Map();
const requestLog = [];

const CIMD_URL = 'https://mcpcat.sliccy.ai/oauth/client.json';

function randomToken() {
  return randomBytes(32).toString('hex');
}

function asMetadata() {
  return {
    issuer: `${ISSUER_BASE}:${issuerPort}`,
    authorization_endpoint: `${ISSUER_BASE}:${issuerPort}/authorize`,
    token_endpoint: `${ISSUER_BASE}:${issuerPort}/token`,
    registration_endpoint: `${ISSUER_BASE}:${issuerPort}/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    client_id_metadata_document_supported: cimdSupported,
    authorization_response_iss_parameter_supported: sendIss,
  };
}

function prmMetadata() {
  return {
    resource: `${ISSUER_BASE}:${issuerPort}/api`,
    authorization_servers: [`${ISSUER_BASE}:${issuerPort}`],
  };
}

function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => resolve(body));
  });
}

function verifyPkce(verifier, challenge) {
  const expected = createHash('sha256').update(verifier).digest('base64url');
  return expected === challenge;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `${ISSUER_BASE}:${issuerPort}`);
  const path = url.pathname;

  res.setHeader('Content-Type', 'application/json');

  if (path === '/.well-known/oauth-protected-resource') {
    res.end(JSON.stringify(prmMetadata()));
    return;
  }

  if (path === '/.well-known/oauth-authorization-server') {
    res.end(JSON.stringify(asMetadata()));
    return;
  }

  if (path === '/register' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    const clientId = `client_${randomToken().slice(0, 8)}`;
    const info = {
      client_id: clientId,
      client_name: body.client_name || 'unknown',
      redirect_uris: body.redirect_uris || [],
      grant_types: body.grant_types || ['authorization_code'],
      response_types: body.response_types || ['code'],
      token_endpoint_auth_method: body.token_endpoint_auth_method || 'none',
    };
    clients.set(clientId, info);
    requestLog.push({
      type: 'dcr',
      clientName: body.client_name,
      redirectUris: body.redirect_uris,
    });
    res.statusCode = 201;
    res.end(JSON.stringify(info));
    return;
  }

  if (path === '/authorize' && req.method === 'GET') {
    const clientId = url.searchParams.get('client_id');
    const redirectUri = url.searchParams.get('redirect_uri');
    const state = url.searchParams.get('state');
    const codeChallenge = url.searchParams.get('code_challenge');
    const codeChallengeMethod = url.searchParams.get('code_challenge_method');
    const scope = url.searchParams.get('scope');
    const resource = url.searchParams.get('resource');

    requestLog.push({
      type: 'authorize',
      clientId,
      codeChallengeMethod,
      scope,
      resource,
    });

    const code = randomToken().slice(0, 16);
    codes.set(code, {
      clientId,
      redirectUri,
      codeChallenge,
      scope: scope || 'default',
    });

    const redirect = new URL(redirectUri);
    redirect.searchParams.set('code', code);
    redirect.searchParams.set('state', state);
    if (sendIss) {
      redirect.searchParams.set('iss', `${ISSUER_BASE}:${issuerPort}`);
    }

    res.statusCode = 302;
    res.setHeader('Location', redirect.href);
    res.end();
    return;
  }

  if (path === '/token' && req.method === 'POST') {
    const body = new URLSearchParams(await readBody(req));
    const grantType = body.get('grant_type');

    if (grantType === 'authorization_code') {
      const code = body.get('code');
      const codeVerifier = body.get('code_verifier');
      const stored = codes.get(code);

      if (!stored) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }

      if (stored.codeChallenge && !verifyPkce(codeVerifier, stored.codeChallenge)) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'PKCE failed' }));
        return;
      }

      codes.delete(code);
      const accessToken = `access_${randomToken()}`;
      const refreshToken = `refresh_${randomToken()}`;
      tokens.set(accessToken, { scope: stored.scope, clientId: stored.clientId });
      refreshTokens.set(refreshToken, { scope: stored.scope, clientId: stored.clientId });
      requestLog.push({
        type: 'token_issued',
        accessToken,
        refreshToken,
        grant: 'authorization_code',
      });

      res.end(
        JSON.stringify({
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: refreshToken,
          scope: stored.scope,
        })
      );
      return;
    }

    if (grantType === 'refresh_token') {
      const rt = body.get('refresh_token');
      const stored = refreshTokens.get(rt);
      if (!stored) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }
      refreshTokens.delete(rt);

      const accessToken = `access_${randomToken()}`;
      const newRefreshToken = `refresh_${randomToken()}`;
      tokens.set(accessToken, stored);
      refreshTokens.set(newRefreshToken, stored);
      requestLog.push({
        type: 'token_issued',
        accessToken,
        refreshToken: newRefreshToken,
        grant: 'refresh_token',
      });

      res.end(
        JSON.stringify({
          access_token: accessToken,
          token_type: 'Bearer',
          expires_in: 3600,
          refresh_token: newRefreshToken,
          scope: stored.scope,
        })
      );
      return;
    }

    res.statusCode = 400;
    res.end(JSON.stringify({ error: 'unsupported_grant_type' }));
    return;
  }

  if (path === '/api' && req.method === 'GET') {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      res.statusCode = 401;
      res.setHeader(
        'WWW-Authenticate',
        `Bearer resource_metadata="${ISSUER_BASE}:${issuerPort}/.well-known/oauth-protected-resource"`
      );
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    const token = auth.slice(7);
    const stored = tokens.get(token);
    if (!stored) {
      res.statusCode = 401;
      res.setHeader('WWW-Authenticate', 'Bearer error="invalid_token"');
      res.end(JSON.stringify({ error: 'invalid_token' }));
      return;
    }
    res.end(JSON.stringify({ ok: true, scope: stored.scope }));
    return;
  }

  if (path === '/api/step-up' && req.method === 'GET') {
    const auth = req.headers.authorization;
    if (!auth?.startsWith('Bearer ')) {
      res.statusCode = 401;
      res.setHeader(
        'WWW-Authenticate',
        `Bearer resource_metadata="${ISSUER_BASE}:${issuerPort}/.well-known/oauth-protected-resource"`
      );
      res.end(JSON.stringify({ error: 'unauthorized' }));
      return;
    }
    const token = auth.slice(7);
    const stored = tokens.get(token);
    if (!stored?.scope.includes('admin')) {
      res.statusCode = 403;
      res.setHeader(
        'WWW-Authenticate',
        `Bearer error="insufficient_scope", scope="admin", resource_metadata="${ISSUER_BASE}:${issuerPort}/.well-known/oauth-protected-resource"`
      );
      res.end(JSON.stringify({ error: 'insufficient_scope' }));
      return;
    }
    res.end(JSON.stringify({ ok: true, admin: true }));
    return;
  }

  if (path === '/_control/iss' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    sendIss = body.enabled !== false;
    res.end(JSON.stringify({ sendIss }));
    return;
  }

  if (path === '/_control/cimd' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    cimdSupported = body.enabled !== false;
    res.end(JSON.stringify({ cimdSupported }));
    return;
  }

  if (path === '/_control/log' && req.method === 'GET') {
    res.end(JSON.stringify(requestLog));
    return;
  }

  if (path === '/_control/log' && req.method === 'DELETE') {
    requestLog.length = 0;
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (path === '/_control/expire' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    if (body.token) tokens.delete(body.token);
    else tokens.clear();
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  if (path === '/_control/token' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req));
    const accessToken = `access_${randomToken()}`;
    const refreshToken = `refresh_${randomToken()}`;
    tokens.set(accessToken, { scope: body.scope || 'default', clientId: body.clientId || 'test' });
    refreshTokens.set(refreshToken, {
      scope: body.scope || 'default',
      clientId: body.clientId || 'test',
    });
    res.end(JSON.stringify({ access_token: accessToken, refresh_token: refreshToken }));
    return;
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'not_found' }));
});

server.listen(PORT, '127.0.0.1', () => {
  issuerPort = server.address().port;
  console.log(JSON.stringify({ port: issuerPort, issuer: `${ISSUER_BASE}:${issuerPort}` }));
});
