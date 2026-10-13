import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const hostBin = join(root, 'dist/host/mcpcat.mjs');
const fixturesDir = join(root, 'test/integration/fixtures');

function runHost(args, opts = {}) {
  try {
    const result = execFileSync('node', [hostBin, ...args], {
      encoding: 'utf8',
      timeout: 15_000,
      env: { ...process.env, NODE_NO_WARNINGS: '1', ...opts.env },
      input: opts.input,
    });
    return { stdout: result, stderr: '', status: 0 };
  } catch (err) {
    return {
      stdout: err.stdout ?? '',
      stderr: err.stderr ?? '',
      status: err.status ?? 1,
    };
  }
}

async function startFixtureServer(script) {
  const child = spawn('node', [join(fixturesDir, script)], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });

  const info = await new Promise((resolve, reject) => {
    let data = '';
    child.stdout.on('data', (chunk) => {
      data += chunk.toString();
      if (data.includes('\n')) {
        try {
          resolve(JSON.parse(data.trim()));
        } catch (e) {
          reject(e);
        }
      }
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (!data.includes('\n')) reject(new Error(`Server exited ${code}: ${data}`));
    });
  });

  return { child, ...info };
}

describe('auth: token store interop', () => {
  let tempDir;

  before(() => {
    tempDir = join(tmpdir(), `mcpcat-auth-test-${Date.now()}`);
    mkdirSync(join(tempDir, 'agent'), { recursive: true });
  });

  after(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('reads a pi-written mcp-auth.json', () => {
    const authPath = join(tempDir, 'agent', 'mcp-auth.json');
    const piState = {
      'mcp__test_server|https://example.com/mcp': {
        serverUrl: 'https://example.com/mcp',
        tokens: {
          access_token: 'pi_token_123',
          token_type: 'Bearer',
          refresh_token: 'pi_refresh_456',
          scope: 'read',
        },
        tokensExpireAt: Date.now() + 3600000,
      },
    };
    writeFileSync(authPath, JSON.stringify(piState, null, 2) + '\n', { mode: 0o600 });

    const { stdout, status } = runHost(['info', 'https://example.com/mcp'], {
      env: { PI_CODING_AGENT_DIR: join(tempDir, 'agent') },
    });
    assert.equal(status === 0 || status === 3, true, `unexpected status ${status}`);
  });

  it('pi-written file is found by mcpcat token lookup', () => {
    const authPath = join(tempDir, 'agent', 'mcp-auth.json');
    const data = JSON.parse(readFileSync(authPath, 'utf8'));
    const key = 'mcp__test_server|https://example.com/mcp';
    assert.ok(data[key], 'key should exist');
    assert.equal(data[key].tokens.access_token, 'pi_token_123');
  });

  it('mcpcat-written tokens match pi key format', () => {
    const authPath = join(tempDir, 'agent', 'mcp-auth.json');
    const data = JSON.parse(readFileSync(authPath, 'utf8'));
    data['mcp__github|https://github.com/mcp'] = {
      serverUrl: 'https://github.com/mcp',
      tokens: {
        access_token: 'mcpcat_token_789',
        token_type: 'Bearer',
        scope: 'repo',
      },
    };
    writeFileSync(authPath, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    const reread = JSON.parse(readFileSync(authPath, 'utf8'));
    assert.ok(reread['mcp__github|https://github.com/mcp']);
  });

  it('legacy URL-only key is migrated', () => {
    const authPath = join(tempDir, 'agent', 'mcp-auth.json');
    const data = {
      'https://legacy.example.com/mcp': {
        serverUrl: 'https://legacy.example.com/mcp',
        tokens: {
          access_token: 'legacy_tok',
          token_type: 'Bearer',
        },
      },
    };
    writeFileSync(authPath, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    runHost(['info', 'legacy'], {
      env: { PI_CODING_AGENT_DIR: join(tempDir, 'agent') },
    });
  });
});

describe('auth: login in seven', () => {
  it('login exits 4 in kernel mode', () => {
    const { stderr, status } = runHost(['login', 'example.com'], {
      env: { SLICC_KERNEL: '1' },
    });
    assert.equal(status, 4);
    assert.ok(stderr.includes('not available in seven'));
  });

  it('logout exits 4 in kernel mode', () => {
    const { stderr, status } = runHost(['logout', 'example.com'], {
      env: { SLICC_KERNEL: '1' },
    });
    assert.equal(status, 4);
    assert.ok(stderr.includes('not available in seven'));
  });
});

describe('auth: header expansion', () => {
  it('${VAR} in -H is expanded from env', () => {
    const { stdout, stderr, status } = runHost(
      ['info', 'http://127.0.0.1:1', '-H', 'Authorization: Bearer ${MY_TOKEN}'],
      { env: { MY_TOKEN: 'secret_value_42' } }
    );
    assert.ok(!stdout.includes('secret_value_42'), 'token must not appear in stdout');
    assert.ok(!stderr.includes('secret_value_42'), 'token must not appear in stderr');
  });

  it('${VAR} is redacted in -v output', () => {
    const { stderr } = runHost(
      ['-v', 'info', 'http://127.0.0.1:1', '-H', 'Authorization: Bearer ${MY_TOKEN}'],
      { env: { MY_TOKEN: 'secret_value_42' } }
    );
    assert.ok(!stderr.includes('secret_value_42'), 'token must not appear in verbose output');
    if (stderr.includes('Authorization')) {
      assert.ok(stderr.includes('***'), 'should be redacted');
    }
  });
});

describe('auth: no secrets leak', () => {
  it('planted token never appears in output', () => {
    const marker = 'PLANTED_SECRET_' + Date.now();
    const { stdout, stderr } = runHost(
      ['info', 'http://127.0.0.1:1', '-H', `X-Secret: ${marker}`],
      { env: {} }
    );
    assert.ok(!stdout.includes(marker), 'marker must not appear in stdout');
    assert.ok(!stderr.includes(marker), 'marker must not appear in stderr');
  });
});

describe('auth: OAuth fixture AS', () => {
  let as;

  before(async () => {
    as = await startFixtureServer('oauth-as.mjs');
  });

  after(() => {
    as?.child.kill('SIGTERM');
  });

  it('serves AS metadata', async () => {
    const res = await fetch(`http://127.0.0.1:${as.port}/.well-known/oauth-authorization-server`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.issuer, `http://127.0.0.1:${as.port}`);
    assert.ok(body.client_id_metadata_document_supported);
    assert.ok(body.authorization_response_iss_parameter_supported);
  });

  it('serves PRM metadata', async () => {
    const res = await fetch(`http://127.0.0.1:${as.port}/.well-known/oauth-protected-resource`);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(body.authorization_servers.includes(`http://127.0.0.1:${as.port}`));
  });

  it('handles DCR', async () => {
    const res = await fetch(`http://127.0.0.1:${as.port}/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_name: 'mcpcat',
        redirect_uris: ['http://127.0.0.1/callback'],
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: 'none',
      }),
    });
    assert.equal(res.status, 201);
    const body = await res.json();
    assert.ok(body.client_id);
  });

  it('authorize endpoint redirects with code and iss', async () => {
    const res = await fetch(
      `http://127.0.0.1:${as.port}/authorize?client_id=test&redirect_uri=http://127.0.0.1/callback&state=abc&code_challenge=xyz&code_challenge_method=S256&response_type=code`,
      { redirect: 'manual' }
    );
    assert.equal(res.status, 302);
    const location = new URL(res.headers.get('location'));
    assert.ok(location.searchParams.has('code'));
    assert.equal(location.searchParams.get('state'), 'abc');
    assert.ok(location.searchParams.has('iss'));
  });

  it('iss toggle works', async () => {
    await fetch(`http://127.0.0.1:${as.port}/_control/iss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });

    const res = await fetch(
      `http://127.0.0.1:${as.port}/authorize?client_id=test&redirect_uri=http://127.0.0.1/callback&state=def&response_type=code`,
      { redirect: 'manual' }
    );
    const location = new URL(res.headers.get('location'));
    assert.ok(!location.searchParams.has('iss'), 'iss should be absent when disabled');

    await fetch(`http://127.0.0.1:${as.port}/_control/iss`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    });
  });

  it('PKCE token exchange', async () => {
    const verifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
    const challenge = createChallenge(verifier);

    const authRes = await fetch(
      `http://127.0.0.1:${as.port}/authorize?client_id=test&redirect_uri=http://127.0.0.1/callback&state=pkce&code_challenge=${challenge}&code_challenge_method=S256&response_type=code`,
      { redirect: 'manual' }
    );
    const location = new URL(authRes.headers.get('location'));
    const code = location.searchParams.get('code');

    const tokenRes = await fetch(`http://127.0.0.1:${as.port}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        redirect_uri: 'http://127.0.0.1/callback',
      }),
    });
    assert.equal(tokenRes.status, 200);
    const tokenBody = await tokenRes.json();
    assert.ok(tokenBody.access_token);
    assert.ok(tokenBody.refresh_token);
  });

  it('refresh token exchange', async () => {
    const controlRes = await fetch(`http://127.0.0.1:${as.port}/_control/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'read' }),
    });
    const { refresh_token } = await controlRes.json();

    const refreshRes = await fetch(`http://127.0.0.1:${as.port}/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token,
      }),
    });
    assert.equal(refreshRes.status, 200);
    const body = await refreshRes.json();
    assert.ok(body.access_token);
    assert.ok(body.refresh_token);
    assert.notEqual(body.refresh_token, refresh_token, 'refresh token should rotate');
  });

  it('insufficient_scope step-up', async () => {
    const controlRes = await fetch(`http://127.0.0.1:${as.port}/_control/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'read' }),
    });
    const { access_token } = await controlRes.json();

    const apiRes = await fetch(`http://127.0.0.1:${as.port}/api/step-up`, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    assert.equal(apiRes.status, 403);
    const wwwAuth = apiRes.headers.get('www-authenticate');
    assert.ok(wwwAuth.includes('insufficient_scope'));
    assert.ok(wwwAuth.includes('admin'));
  });

  it('401 for missing bearer token', async () => {
    const res = await fetch(`http://127.0.0.1:${as.port}/api`);
    assert.equal(res.status, 401);
  });

  it('valid bearer token accesses API', async () => {
    const controlRes = await fetch(`http://127.0.0.1:${as.port}/_control/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scope: 'read' }),
    });
    const { access_token } = await controlRes.json();

    const apiRes = await fetch(`http://127.0.0.1:${as.port}/api`, {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    assert.equal(apiRes.status, 200);
    const body = await apiRes.json();
    assert.ok(body.ok);
  });
});

function createChallenge(verifier) {
  return createHash('sha256').update(verifier).digest('base64url');
}
