import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { createHmac } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { mcpcatArgs } from './helpers/bin.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, 'fixtures', 'event-source.mjs');
const X = ['--experimental', 'events'];
const hasOpenssl = spawnSync('openssl', ['version']).status === 0;
const bearer = 'events-webhook-token';
const AUTH = ['-H', `Authorization: Bearer ${bearer}`];

const home = mkdtempSync(join(tmpdir(), 'mcpcat-events-webhook-'));
const env = {
  ...process.env,
  NODE_NO_WARNINGS: '1',
  HOME: home,
  PI_CODING_AGENT_DIR: join(home, 'agent'),
};
const children = [];
after(() => {
  for (const c of children) c.kill('SIGKILL');
  rmSync(home, { recursive: true, force: true });
});

let files = 0;
const tmp = (name) => join(home, `${++files}-${name}`);

function collect(child) {
  return new Promise((resolve) => {
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.on('exit', (status) =>
      resolve({
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        status,
      })
    );
  });
}

function start(args) {
  const { cmd, args: a } = mcpcatArgs(args);
  const child = spawn(cmd, a, { stdio: ['ignore', 'pipe', 'pipe'], env, cwd: home });
  children.push(child);
  return child;
}

const run = (args) => collect(start(args));

async function startServe(args, extra = {}) {
  const { cmd, args: a } = mcpcatArgs(['serve', ...X, '--http', '0', ...args]);
  const child = spawn(cmd, a, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, ...extra },
    cwd: home,
  });
  children.push(child);
  let stderr = '';
  const port = await new Promise((resolve, reject) => {
    child.stderr.on('data', (d) => {
      stderr += d.toString();
      const m = /listening on http:\/\/[^:]+:(\d+)\/mcp/.exec(stderr);
      if (m) resolve(Number(m[1]));
    });
    child.on('exit', (code) => reject(new Error(`serve exited ${code}: ${stderr}`)));
  });
  return { child, url: `http://127.0.0.1:${port}/mcp` };
}

function makeCert(dir) {
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-keyout',
      join(dir, 'key.pem'),
      '-out',
      join(dir, 'cert.pem'),
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=IP:127.0.0.1',
    ],
    { stdio: 'ignore' }
  );
  return {
    key: readFileSync(join(dir, 'key.pem')),
    cert: readFileSync(join(dir, 'cert.pem')),
    path: join(dir, 'cert.pem'),
  };
}

function receiver(tls) {
  const deliveries = [];
  const plan = new Map();
  const server = createServer(tls, (req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      deliveries.push({ path: req.url, headers: req.headers, raw, body: JSON.parse(raw) });
      res.writeHead((plan.get(req.url) ?? []).shift() ?? 200);
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve({
        url: (path) => `https://127.0.0.1:${server.address().port}${path}`,
        at: (path) => deliveries.filter((d) => d.path === path),
        plan: (path, statuses) => plan.set(path, [...statuses]),
        close: () => server.close(),
      })
    );
  });
}

function verifies(delivery, secret) {
  const key = Buffer.from(secret.slice(6), 'base64');
  const { 'webhook-id': id, 'webhook-timestamp': ts, 'webhook-signature': sig } = delivery.headers;
  const want = `v1,${createHmac('sha256', key).update(`${id}.${ts}.${delivery.raw}`).digest('base64')}`;
  return sig.split(' ').includes(want);
}

async function until(check, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return true;
    await sleep(25);
  }
  return false;
}

const lines = (text) =>
  text
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));

describe('host: --webhook-url registers a webhook subscription', {
  skip: !hasOpenssl && 'needs openssl',
}, () => {
  let tls;
  let hook;
  let serve;
  let plain;

  before(async () => {
    tls = makeCert(mkdtempSync(join(home, 'tls-')));
    hook = await receiver(tls);
    serve = await startServe(
      [
        '--bearer',
        '${SERVE_TOKEN}',
        '--event',
        `tick: node ${source} tick {label} 50`,
        '--webhook-allow',
        hook.url('/ok/'),
      ],
      { SERVE_TOKEN: bearer, NODE_EXTRA_CA_CERTS: tls.path }
    );
    plain = await startServe(['--no-auth', '--event', `tick: node ${source} tick {label} 50`]);
  });

  after(() => hook?.close());

  const target = () => [serve.url, ...X, ...AUTH];

  it('subscribes, refreshes before the TTL, and unsubscribes on SIGINT', async () => {
    const secretFile = tmp('secret');
    const cursorFile = tmp('cursor.json');
    const child = start([
      ...target(),
      '--webhook-url',
      hook.url('/ok/a'),
      '--webhook-secret-file',
      secretFile,
      '--webhook-ttl',
      '2',
      '--cursor-file',
      cursorFile,
      '-v',
      '--subscribe',
      'tick',
      '--label',
      'a',
    ]);
    const done = collect(child);
    let out = '';
    child.stdout.on('data', (d) => {
      out += d.toString();
    });
    assert.ok(await until(() => out.split('\n').filter(Boolean).length >= 2), 'a refresh');
    assert.ok(await until(() => hook.at('/ok/a').length >= 3));
    const secret = readFileSync(secretFile, 'utf8').trim();
    assert.match(secret, /^whsec_/);
    assert.equal(statSync(secretFile).mode & 0o777, 0o600);
    assert.ok(verifies(hook.at('/ok/a')[0], secret));
    child.kill('SIGINT');
    const r = await done;
    assert.equal(r.status, 130, r.stderr);
    const status = lines(r.stdout);
    assert.match(status[0].id, /^sub_[0-9a-f]{16}$/);
    assert.equal(status[1].id, status[0].id);
    assert.equal(status[1].deliveryStatus.lastError, null);
    assert.ok(Date.parse(status[0].refreshBefore) - Date.now() < 2500);
    assert.equal(status[0].resultType, undefined);
    assert.match(r.stderr, /> events\/unsubscribe/);
    assert.doesNotMatch(r.stderr, new RegExp(secret.slice(6, 30).replace(/[+/]/g, '.')));
    assert.match(JSON.parse(readFileSync(cursorFile, 'utf8')).cursor, /\.\d+$/);
    const count = hook.at('/ok/a').length;
    await sleep(400);
    assert.ok(hook.at('/ok/a').length <= count + 1, 'deliveries stopped');
  });

  it('--webhook-once leaves the subscription for --webhook-unsubscribe, with the same secret', async () => {
    const secretFile = tmp('secret');
    const base = [
      ...target(),
      '--webhook-url',
      hook.url('/ok/once'),
      '--webhook-secret-file',
      secretFile,
    ];
    const once = await run([...base, '--webhook-once', '--subscribe', 'tick', '--label', 'o']);
    assert.equal(once.status, 0, once.stderr);
    assert.equal(lines(once.stdout).length, 1);
    assert.ok(await until(() => hook.at('/ok/once').length >= 3), 'still delivering');
    const again = await run([...base, '--webhook-once', '--subscribe', 'tick', '--label', 'o']);
    assert.equal(lines(again.stdout)[0].id, lines(once.stdout)[0].id);
    assert.ok(lines(again.stdout)[0].deliveryStatus);
    const secret = readFileSync(secretFile, 'utf8').trim();
    assert.ok(verifies(hook.at('/ok/once').at(-1), secret));
    const off = await run([
      ...base,
      '--webhook-unsubscribe',
      '--subscribe',
      'tick',
      '--label',
      'o',
    ]);
    assert.equal(off.status, 0, off.stderr);
    assert.match(off.stderr, /unsubscribed tick from https:\/\/127\.0\.0\.1:\d+\/ok\/once/);
    const count = hook.at('/ok/once').length;
    await sleep(400);
    assert.ok(hook.at('/ok/once').length <= count + 1, 'deliveries stopped');
    const gone = await run([
      ...base,
      '--webhook-unsubscribe',
      '--subscribe',
      'tick',
      '--label',
      'o',
    ]);
    assert.equal(gone.status, 5, gone.stderr);
    assert.match(gone.stderr, /-32023/);
  });

  it('refreshes a 1-second lease before it expires', async () => {
    const child = start([
      ...target(),
      '--webhook-url',
      hook.url('/ok/short'),
      '--webhook-ttl',
      '1',
      '--subscribe',
      'tick',
      '--label',
      's',
    ]);
    const done = collect(child);
    let out = '';
    child.stdout.on('data', (d) => {
      out += d.toString();
    });
    assert.ok(await until(() => out.split('\n').filter(Boolean).length >= 4), 'refreshes');
    child.kill('SIGINT');
    const r = await done;
    assert.equal(r.status, 130, r.stderr);
    const status = lines(r.stdout);
    assert.ok(Date.parse(status[0].refreshBefore) - Date.now() < 1000);
    for (const s of status.slice(1)) {
      assert.equal(s.id, status[0].id);
      assert.ok(s.deliveryStatus, `a refresh, not a new subscription: ${JSON.stringify(s)}`);
    }
  });

  it('--webhook-keep leaves the subscription registered on SIGINT', async () => {
    const child = start([
      ...target(),
      '--webhook-url',
      hook.url('/ok/keep'),
      '--webhook-keep',
      '--subscribe',
      'tick',
      '--label',
      'k',
    ]);
    const done = collect(child);
    assert.ok(await until(() => hook.at('/ok/keep').length >= 2));
    child.kill('SIGINT');
    const r = await done;
    assert.equal(r.status, 130);
    const count = hook.at('/ok/keep').length;
    assert.ok(await until(() => hook.at('/ok/keep').length > count + 2), 'still delivering');
  });

  it('reports the server seeing failed deliveries', async () => {
    hook.plan('/ok/fail', [500, 500, 500, 500, 500]);
    const child = start([
      ...target(),
      '--webhook-url',
      hook.url('/ok/fail'),
      '--webhook-ttl',
      '2',
      '--subscribe',
      'tick',
      '--label',
      'f',
    ]);
    const done = collect(child);
    let err = '';
    child.stderr.on('data', (d) => {
      err += d.toString();
    });
    assert.ok(await until(() => /webhook delivery failing \(http_5xx\)/.test(err)));
    child.kill('SIGINT');
    await done;
  });

  it('a callback outside the server allowlist is a JSON-RPC error', async () => {
    const r = await run([
      ...target(),
      '--webhook-url',
      'https://elsewhere.example/x',
      '--subscribe',
      'tick',
      '--label',
      'x',
    ]);
    assert.equal(r.status, 5, r.stderr);
    assert.match(r.stderr, /-32027.*--webhook-allow/);
  });

  it('an event without webhook delivery exits 2', async () => {
    const r = await run([
      plain.url,
      ...X,
      '--webhook-url',
      hook.url('/ok/p'),
      '--subscribe',
      'tick',
      '--label',
      'x',
    ]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /does not offer webhook delivery \(offers: push, poll\)/);
  });

  it('a secret file that does not hold a whsec_ secret exits 2 before connecting', async () => {
    const file = tmp('bad-secret');
    writeFileSync(file, 'not-a-secret\n');
    const r = await run([
      'stdio:nonexistent-server',
      ...X,
      '--webhook-url',
      hook.url('/ok/x'),
      '--webhook-secret-file',
      file,
      '--subscribe',
      'tick',
    ]);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /does not hold a whsec_ secret/);
    assert.ok(existsSync(file));
  });

  for (const [args, message] of [
    [
      ['--webhook-url', 'http://a.example/x', '--subscribe', 'tick'],
      /--webhook-url needs an https URL/,
    ],
    [['--delivery', 'webhook', '--subscribe', 'tick'], /--delivery webhook needs --webhook-url/],
    [['--webhook-keep', '--subscribe', 'tick'], /--webhook-… options need --webhook-url/],
    [
      ['--webhook-url', 'https://a.example/', '--delivery', 'poll', '--subscribe', 'tick'],
      /does not combine with --delivery poll/,
    ],
    [['--webhook-url', 'https://a.example/', '--list-events'], /--webhook-url needs --subscribe/],
    [
      ['--webhook-url', 'https://a.example/', '--count', '1', '--subscribe', 'tick'],
      /--count does not apply/,
    ],
    [
      ['--webhook-url', 'https://a.example/', '--subscribe', 'tick', '--', 'cat'],
      /ntfy subscribe <topic> <cmd>/,
    ],
  ]) {
    it(`usage error for ${args.join(' ')}`, async () => {
      const r = await run(['x', ...X, ...args]);
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, message);
    });
  }
});
