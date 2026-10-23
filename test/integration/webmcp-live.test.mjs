import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mcpcatArgs } from './helpers/bin.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const fakePwCli = join(root, 'test/integration/fixtures/fake-playwright-cli.sh');
const testHome = join(tmpdir(), `mcpcat-webmcp-live-${process.pid}-${Date.now()}`);
mkdirSync(testHome, { recursive: true });
const children = [];
let n = 0;

after(() => {
  for (const c of children) {
    try {
      c.kill('SIGKILL');
    } catch {}
  }
  rmSync(testHome, { recursive: true, force: true });
});

const SHOP = 'https://shop.example.com';
const WAREHOUSE = 'https://warehouse.example.org';
const MODERN_META = {
  'io.modelcontextprotocol/protocolVersion': '2026-07-28',
  'io.modelcontextprotocol/clientInfo': { name: 't', version: '1' },
  'io.modelcontextprotocol/clientCapabilities': {},
};
const SUB = 'io.modelcontextprotocol/subscriptionId';

const tool = (name, extra = {}) => ({
  name,
  description: name,
  inputSchema: { type: 'object', properties: {} },
  annotations: { readOnlyHint: true },
  policy: 'allowed',
  ...extra,
});

const SCRIPT = {
  frames: { TAB1: { origin: SHOP, tools: [tool('get_price')] } },
  steps: [
    { frame: 'TAB1', origin: SHOP, tools: [tool('get_price'), tool('add_to_cart')] },
    { frame: 'F2', target: 'OOPIF1', origin: WAREHOUSE, tools: [tool('get_stock')] },
    {
      frame: 'TAB1',
      origin: SHOP,
      tools: [
        tool('get_price'),
        tool('add_to_cart'),
        tool('place_order', { annotations: { consequentialHint: true } }),
      ],
    },
    { frame: 'F3', origin: SHOP, loaderId: 'LF3', tools: [tool('track_order')] },
    {
      navigate: 'L2',
      pending: { frame: 'TAB1', origin: SHOP, tools: [tool('ghost')] },
      frames: { TAB1: { origin: SHOP, tools: [tool('checkout')] } },
    },
    { frame: 'TAB1', origin: SHOP, tools: [tool('checkout'), tool('coupon')] },
  ],
};

function scratch() {
  const dir = join(testHome, `case-${++n}`);
  mkdirSync(dir, { recursive: true });
  const script = join(dir, 'script.json');
  writeFileSync(script, JSON.stringify(SCRIPT));
  return { dir, script, log: join(dir, 'log.jsonl'), holder: join(dir, 'holder') };
}

function env(dirs, extra = {}) {
  return {
    ...process.env,
    NODE_NO_WARNINGS: '1',
    HOME: testHome,
    FAKE_PWCLI_LOG: dirs.log,
    FAKE_PWCLI_HOLDER_FILE: dirs.holder,
    FAKE_PWCLI_HOLDER: 'polyfill',
    FAKE_PWCLI_VERSION: '1.40.0',
    FAKE_PWCLI_LIVE: dirs.script,
    ...extra,
  };
}

function step(dirs, i) {
  writeFileSync(`${dirs.script}.step${i}`, '');
}

function lists(dirs) {
  if (!existsSync(dirs.log)) return 0;
  return readFileSync(dirs.log, 'utf8')
    .split('\n')
    .filter((l) => l.includes('"command":"webmcp-list"')).length;
}

async function until(check, ms = 10_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = check();
    if (value) return value;
    await new Promise((r) => setTimeout(r, 25));
  }
  return undefined;
}

function inbox() {
  const messages = [];
  const taken = new Set();
  return {
    messages,
    push(message) {
      messages.push(message);
    },
    async take(match, ms) {
      const found = await until(() => {
        const i = messages.findIndex((m, j) => !taken.has(j) && match(m));
        return i >= 0 ? i + 1 : undefined;
      }, ms);
      assert.ok(found, `no matching message in ${JSON.stringify(messages)}`);
      taken.add(found - 1);
      return messages[found - 1];
    },
  };
}

const isChange = (m) => m.method === 'notifications/tools/list_changed';

function stdioServe(extra, environment) {
  const { cmd, args } = mcpcatArgs([
    'serve',
    '--webmcp',
    '--tab',
    'TAB1',
    '--webmcp-ttl',
    '600',
    '--playwright-cli',
    fakePwCli,
    ...extra,
  ]);
  const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env: environment });
  children.push(child);
  const box = inbox();
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString();
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      box.push(JSON.parse(buffer.slice(0, nl)));
      buffer = buffer.slice(nl + 1);
    }
  });
  let id = 0;
  const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  return {
    child,
    box,
    send,
    async request(method, params = {}) {
      const rid = ++id;
      send({ jsonrpc: '2.0', id: rid, method, params });
      return box.take((m) => m.id === rid);
    },
  };
}

const names = (response) => response.result.tools.map((t) => t.name);

async function httpServe(extra, environment) {
  const { cmd, args } = mcpcatArgs([
    'serve',
    '--webmcp',
    '--tab',
    'TAB1',
    '--webmcp-ttl',
    '600',
    '--http',
    '0',
    '--no-auth',
    '--playwright-cli',
    fakePwCli,
    ...extra,
  ]);
  const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], env: environment });
  children.push(child);
  let stderr = '';
  const port = await new Promise((resolve, reject) => {
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      const match = stderr.match(/listening on http:\/\/[^:]+:(\d+)\/mcp/);
      if (match) resolve(Number(match[1]));
    });
    child.on('exit', (code) => reject(new Error(`serve exited ${code}: ${stderr}`)));
  });
  return { child, url: `http://127.0.0.1:${port}/mcp` };
}

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function sse(res) {
  const box = inbox();
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buffer = '';
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true }));
      if (done) break;
      buffer += dec.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const data = buffer
          .slice(0, end)
          .split('\n')
          .filter((l) => l.startsWith('data: '))
          .map((l) => l.slice(6))
          .join('\n');
        buffer = buffer.slice(end + 2);
        if (data) box.push(JSON.parse(data));
      }
    }
  })();
  return { box, cancel: () => reader.cancel().catch(() => {}) };
}

function stopped(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null) resolve(child.exitCode);
    else child.on('exit', (code, signal) => resolve(code ?? signal));
  });
}

describe('serve --webmcp live tool updates', () => {
  it('serve --help documents live updates', async () => {
    const { cmd, args } = mcpcatArgs(['serve', '--help']);
    const child = spawn(cmd, args, { env: { ...process.env, NODE_NO_WARNINGS: '1' } });
    let out = '';
    child.stdout.on('data', (chunk) => {
      out += chunk.toString();
    });
    assert.equal(await stopped(child), 0);
    assert.match(out, /playwright-cli 1\.40\.0 or newer the polyfill holder's/);
    assert.match(out, /notifications\/tools\/list_changed/);
  });

  it('stdio legacy client: list_changed per change, cross-origin and consequential stay out, navigation re-lists', async () => {
    const dirs = scratch();
    const s = stdioServe([], env(dirs));
    const init = await s.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 't' },
    });
    assert.equal(init.result.capabilities.tools.listChanged, true);
    s.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.deepEqual(names(await s.request('tools/list')), ['get_price']);
    const listed = lists(dirs);

    step(dirs, 0);
    await s.box.take(isChange);
    assert.deepEqual(names(await s.request('tools/list')), ['get_price', 'add_to_cart']);
    assert.equal(lists(dirs), listed);

    step(dirs, 1);
    step(dirs, 2);
    await s.box.take(isChange);
    const guarded = await s.request('tools/list');
    assert.deepEqual(names(guarded), ['get_price', 'add_to_cart']);
    assert.ok(Object.hasOwn(guarded.result._meta['io.mcpcat/hidden'], 'place_order'));

    step(dirs, 3);
    await s.box.take(isChange);
    assert.deepEqual(names(await s.request('tools/list')), [
      'get_price',
      'add_to_cart',
      'track_order',
    ]);
    assert.equal(lists(dirs), listed);

    step(dirs, 4);
    await s.box.take(isChange);
    assert.deepEqual(names(await s.request('tools/list')), ['checkout']);
    assert.equal(lists(dirs), listed + 1);

    step(dirs, 5);
    await s.box.take(isChange);
    assert.deepEqual(names(await s.request('tools/list')), ['checkout', 'coupon']);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(s.box.messages.filter(isChange).length, 5);
    const call = await s.request('tools/call', { name: 'coupon', arguments: {} });
    assert.equal(call.result.isError, false);
    s.child.stdin.end();
    assert.equal(await stopped(s.child), 0);
  });

  it('stdio 2026 client: subscriptions/listen gets an acknowledgment and tagged notifications, with native WebMCP', async () => {
    const dirs = scratch();
    const s = stdioServe([], env(dirs, { FAKE_PWCLI_HOLDER: 'native' }));
    const discover = await s.request('server/discover', { _meta: MODERN_META });
    assert.equal(discover.result.capabilities.tools.listChanged, true);
    assert.deepEqual(names(await s.request('tools/list', { _meta: MODERN_META })), ['get_price']);
    s.send({
      jsonrpc: '2.0',
      id: 'sub-1',
      method: 'subscriptions/listen',
      params: { _meta: MODERN_META, notifications: { toolsListChanged: true } },
    });
    const ack = await s.box.take((m) => m.method === 'notifications/subscriptions/acknowledged');
    assert.equal(ack.params._meta[SUB], 'sub-1');
    assert.deepEqual(ack.params.notifications, { toolsListChanged: true });

    step(dirs, 0);
    const change = await s.box.take(isChange);
    assert.equal(change.params._meta[SUB], 'sub-1');
    const after = await s.request('tools/list', { _meta: MODERN_META });
    assert.deepEqual(names(after), ['get_price', 'add_to_cart']);
    assert.equal(after.result.resultType, 'complete');

    s.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'sub-1' } });
    await s.request('ping');
    step(dirs, 1);
    step(dirs, 2);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(s.box.messages.filter(isChange).length, 1);
    s.child.stdin.end();
    assert.equal(await stopped(s.child), 0);
  });

  it('cross-origin frame tools arrive live only with --webmcp-from-origin', async () => {
    const dirs = scratch();
    const s = stdioServe(['--webmcp-from-origin', WAREHOUSE], env(dirs));
    await s.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 't' },
    });
    assert.deepEqual(names(await s.request('tools/list')), ['get_price']);
    step(dirs, 0);
    await s.box.take(isChange);
    step(dirs, 1);
    await s.box.take(isChange);
    assert.deepEqual(names(await s.request('tools/list')), [
      'shop_example_com__get_price',
      'shop_example_com__add_to_cart',
      'warehouse_example_org__get_stock',
    ]);
    s.child.stdin.end();
    assert.equal(await stopped(s.child), 0);
  });

  it('HTTP legacy client: the GET stream carries list_changed and the next tools/list has the change', async () => {
    const dirs = scratch();
    const { child, url } = await httpServe([], env(dirs));
    const init = await post(url, {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't' } },
    });
    assert.equal(init.result.capabilities.tools.listChanged, true);
    const first = await post(url, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    assert.deepEqual(names(first), ['get_price']);
    const res = await fetch(url, { headers: { accept: 'text/event-stream' } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const stream = await sse(res);
    await new Promise((r) => setTimeout(r, 200));
    step(dirs, 0);
    const change = await stream.box.take(isChange);
    assert.equal(change.params, undefined);
    const next = await post(url, { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} });
    assert.deepEqual(names(next), ['get_price', 'add_to_cart']);
    const bad = await fetch(url, { headers: { accept: 'application/json' } });
    assert.equal(bad.status, 406);
    await stream.cancel();
    child.kill('SIGTERM');
    await stopped(child);
  });

  it('HTTP 2026 client: subscriptions/listen streams the acknowledgment and changes, and ends cleanly on shutdown', async () => {
    const dirs = scratch();
    const { child, url } = await httpServe([], env(dirs));
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'subscriptions/listen',
        params: { _meta: MODERN_META, notifications: { toolsListChanged: true } },
      }),
    });
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const stream = await sse(res);
    const ack = await stream.box.take(
      (m) => m.method === 'notifications/subscriptions/acknowledged'
    );
    assert.equal(ack.params._meta[SUB], 7);
    step(dirs, 0);
    const change = await stream.box.take(isChange);
    assert.equal(change.params._meta[SUB], 7);
    const next = await post(url, {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/list',
      params: { _meta: MODERN_META },
    });
    assert.deepEqual(names(next), ['get_price', 'add_to_cart']);
    child.kill('SIGTERM');
    const done = await stream.box.take((m) => m.id === 7);
    assert.equal(done.result.resultType, 'complete');
    await stopped(child);
  });

  it('playwright-cli older than 1.40.0 keeps the TTL cache and sends no notifications', async () => {
    const dirs = scratch();
    const s = stdioServe([], env(dirs, { FAKE_PWCLI_VERSION: '1.39.3' }));
    const init = await s.request('initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 't' },
    });
    assert.equal(init.result.capabilities.tools.listChanged, false);
    assert.deepEqual(names(await s.request('tools/list')), ['get_price']);
    step(dirs, 0);
    await until(() => readFileSync(`${dirs.script}.page.json`, 'utf8').includes('add_to_cart'));
    await new Promise((r) => setTimeout(r, 300));
    assert.deepEqual(names(await s.request('tools/list')), ['get_price']);
    const listen = await s.request('subscriptions/listen', {
      _meta: MODERN_META,
      notifications: { toolsListChanged: true },
    });
    assert.equal(listen.error.code, -32601);
    assert.equal(s.box.messages.filter(isChange).length, 0);
    s.child.stdin.end();
    assert.equal(await stopped(s.child), 0);
  });
});
