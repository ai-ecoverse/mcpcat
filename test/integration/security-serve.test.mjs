import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import net from 'node:net';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fixtures, homeEnv, launch, scratchHome, startFixture } from './helpers/rows.mjs';
import { waitUntil } from './helpers/wait.mjs';

function raw(port, { method = 'POST', path = '/mcp', headers = {}, body = '' } = {}) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1');
    let data = '';
    const all = {
      Host: `127.0.0.1:${port}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...headers,
    };
    for (const k of Object.keys(all)) if (all[k] === null) delete all[k];
    const lines = [
      `${method} ${path} HTTP/1.1`,
      ...Object.entries(all).map(([k, v]) => `${k}: ${v}`),
      `Content-Length: ${Buffer.byteLength(body)}`,
      'Connection: close',
      '',
      body,
    ];
    socket.write(lines.join('\r\n'));
    socket.on('data', (d) => {
      data += d;
    });
    socket.on('end', () => {
      const [head] = data.split('\r\n\r\n');
      resolve({
        status: Number(head.split(' ')[1]),
        headers: head
          .split('\r\n')
          .slice(1)
          .map((l) => l.toLowerCase()),
      });
    });
    socket.on('error', (e) => resolve({ status: -1, error: e.code, headers: [] }));
    socket.setTimeout(10_000, () => {
      socket.destroy();
      resolve({ status: -2, headers: [] });
    });
  });
}

const rpc = (method, params = {}) => JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });

async function battery(port, bearer) {
  const auth = { Authorization: `Bearer ${bearer}` };
  const list = rpc('tools/list');
  const r = {
    init: await raw(port, {
      headers: auth,
      body: rpc('initialize', {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'c', version: '1' },
      }),
    }),
    list: await raw(port, { headers: auth, body: list }),
    noBearer: await raw(port, { body: list }),
    badBearer: await raw(port, { headers: { Authorization: 'Bearer nope' }, body: list }),
    originEvil: await raw(port, {
      headers: { ...auth, Origin: 'http://evil.example' },
      body: list,
    }),
    originOtherPort: await raw(port, {
      headers: { ...auth, Origin: `http://localhost:${port + 1}` },
      body: list,
    }),
    originSubLocalhost: await raw(port, {
      headers: { ...auth, Origin: 'http://foo.localhost' },
      body: list,
    }),
    originSelf: await raw(port, {
      headers: { ...auth, Origin: `http://127.0.0.1:${port}` },
      body: list,
    }),
    hostEvil: await raw(port, { headers: { ...auth, Host: 'evil.example' }, body: list }),
    hostLan: await raw(port, { headers: { ...auth, Host: `192.168.1.5:${port}` }, body: list }),
    textPlain: await raw(port, { headers: { ...auth, 'Content-Type': 'text/plain' }, body: list }),
    noAccept: await raw(port, { headers: { ...auth, Accept: null }, body: list }),
    preflight: await raw(port, { method: 'OPTIONS', headers: { Origin: 'http://evil.example' } }),
  };
  return r;
}

const EXPECT = {
  init: 200,
  list: 200,
  noBearer: 401,
  badBearer: 401,
  originEvil: 403,
  originOtherPort: 403,
  originSubLocalhost: 403,
  originSelf: 200,
  hostEvil: 403,
  hostLan: 403,
  textPlain: 415,
  noAccept: 406,
};

async function serve(args, env) {
  const child = launch(['serve', ...args, '--http', '0', '--json'], { env });
  const info = await waitUntil(() => {
    const line = child.out.split('\n').find((l) => l.startsWith('{'));
    return line ? JSON.parse(line) : undefined;
  }, 'serve --json');
  return {
    child,
    info,
    port: Number(new URL(info.url).port),
    bearer: readFileSync(info.bearerFile, 'utf8').trim(),
  };
}

function externalAddress() {
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address;
  }
  return undefined;
}

function reachable(address, port) {
  return new Promise((resolve) => {
    const socket = net.connect(port, address);
    socket.on('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.on('error', () => resolve(false));
    socket.setTimeout(3000, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

function checkBattery(r) {
  const statuses = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.status]));
  const wrong = Object.keys(EXPECT).filter((k) => statuses[k] !== EXPECT[k]);
  assert.deepEqual(wrong, [], JSON.stringify(statuses));
  assert.notEqual(statuses.preflight, 200, 'a CORS preflight succeeded');
  const cors = Object.values(r).some((x) => x.headers.some((h) => h.startsWith('access-control-')));
  assert.equal(cors, false, 'a response carried an access-control-* header');
}

describe('security: serve binds loopback with a bearer, checks Origin and Host, no CORS', () => {
  let s;
  before(async () => {
    s = await serve([join(fixtures, 'serve-cli.mjs')], homeEnv(scratchHome('serve')));
  });
  after(async () => {
    s?.child.kill('SIGTERM');
    await s?.child.done;
  });

  it('serves on 127.0.0.1 only', async () => {
    assert.equal(new URL(s.info.url).hostname, '127.0.0.1');
    const ext = externalAddress();
    if (ext) assert.equal(await reachable(ext, s.port), false, `reachable on ${ext}`);
  });

  it('answers the battery as expected', async () => checkBattery(await battery(s.port, s.bearer)));

  it('removes the bearer file on SIGTERM', async () => {
    s.child.kill('SIGTERM');
    await s.child.done;
    assert.equal(existsSync(s.info.bearerFile), false);
  });
});

describe('security: proxy is pinned to its upstream and never forwards its bearer', () => {
  let up;
  let other;
  let s;
  before(async () => {
    up = await startFixture('reflect-server.mjs');
    other = await startFixture('reflect-server.mjs');
    s = await serve(['--proxy', `${up.base}/mcp`], homeEnv(scratchHome('proxy')));
  });
  after(async () => {
    s?.child.kill('SIGTERM');
    await s?.child.done;
    up?.child.kill('SIGTERM');
    other?.child.kill('SIGTERM');
  });

  it('answers the battery as expected', async () => checkBattery(await battery(s.port, s.bearer)));

  it('cannot be steered to another server', async () => {
    const auth = { Authorization: `Bearer ${s.bearer}` };
    const list = rpc('tools/list');
    await raw(s.port, { path: `${other.base}/mcp`, headers: auth, body: list });
    await raw(s.port, {
      headers: { ...auth, 'X-Forwarded-Host': `127.0.0.1:${other.port}` },
      body: list,
    });
    await raw(s.port, { headers: { ...auth, Host: `127.0.0.1:${other.port}` }, body: list });
    const seen = await (await fetch(`${other.base}/seen`)).json();
    assert.equal(seen.length, 0);
  });

  it('does not forward its own bearer upstream', async () => {
    const seen = await (await fetch(`${up.base}/seen`)).json();
    assert.ok(seen.length > 0);
    assert.equal(seen.filter((e) => (e.headers.authorization ?? '').includes(s.bearer)).length, 0);
  });
});
