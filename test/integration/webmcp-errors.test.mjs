import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mcpcatArgs } from './helpers/bin.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const fixturesDir = join(root, 'test/integration/fixtures');
const fakePwCli = join(fixturesDir, 'fake-playwright-cli.sh');
const fixture = join(fixturesDir, 'webmcp-tools.json');
const fixtureCli = join(fixturesDir, 'serve-cli.mjs');

const testHome = mkdtempSync(join(tmpdir(), 'mcpcat-webmcp-errors-'));
mkdirSync(join(testHome, '.pi', 'agent'), { recursive: true });
const testEnv = { HOME: testHome, PI_CODING_AGENT_DIR: join(testHome, '.pi', 'agent') };
const cleanups = [];

after(async () => {
  for (const fn of cleanups.reverse()) {
    try {
      await fn();
    } catch {}
  }
  rmSync(testHome, { recursive: true, force: true });
});

function rpc(method, params, id) {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

const init = rpc(
  'initialize',
  { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't' } },
  1
);

function run(args, opts = {}) {
  const { cmd, args: cmdArgs } = mcpcatArgs(args);
  const bin = cmd === 'node' ? process.execPath : cmd;
  return new Promise((resolve) => {
    const started = Date.now();
    const child = execFile(
      bin,
      cmdArgs,
      {
        encoding: 'utf8',
        timeout: opts.timeout ?? 20_000,
        env: {
          ...process.env,
          NODE_NO_WARNINGS: '1',
          FAKE_PWCLI_FIXTURE: fixture,
          ...testEnv,
          ...opts.env,
        },
      },
      (err, stdout, stderr) => {
        resolve({
          stdout,
          stderr,
          status: err ? (err.code ?? 1) : 0,
          ms: Date.now() - started,
        });
      }
    );
    child.stdin.end(opts.input ?? '');
  });
}

function responses(stdout) {
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function startWebMcpHttp(extraArgs = [], extraEnv = {}) {
  const { cmd, args } = mcpcatArgs([
    'serve',
    '--webmcp',
    '--http',
    '0',
    '--no-auth',
    '--playwright-cli',
    fakePwCli,
    ...extraArgs,
  ]);
  const child = spawn(cmd, args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NODE_NO_WARNINGS: '1',
      ...testEnv,
      FAKE_PWCLI_FIXTURE: fixture,
      ...extraEnv,
    },
  });
  cleanups.push(() => child.kill('SIGKILL'));
  const port = await new Promise((resolve, reject) => {
    let data = '';
    child.stderr.on('data', (chunk) => {
      data += chunk.toString();
      const match = data.match(/listening on http:\/\/[^:]+:(\d+)\/mcp/);
      if (match) resolve(Number(match[1]));
    });
    child.on('exit', (code) => reject(new Error(`serve exited ${code}: ${data}`)));
  });
  return port;
}

function wsFrame(obj) {
  const data = Buffer.from(JSON.stringify(obj));
  if (data.length < 126) return Buffer.concat([Buffer.from([0x81, data.length]), data]);
  const header = Buffer.alloc(4);
  header[0] = 0x81;
  header[1] = 126;
  header.writeUInt16BE(data.length, 2);
  return Buffer.concat([header, data]);
}

async function startFakeCdp({ stall = false } = {}) {
  const seen = [];
  const sessions = new Set();
  const server = createServer((req, res) => {
    if (req.url === '/dialog') {
      for (const socket of sessions) {
        socket.write(
          wsFrame({
            method: 'Page.javascriptDialogOpening',
            sessionId: 'S1',
            params: { type: 'confirm', message: 'Send it?', url: 'https://shop.example.com/' },
          })
        );
      }
      res.end('ok');
      return;
    }
    if (req.url === '/json/version') {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          webSocketDebuggerUrl: `ws://127.0.0.1:${server.address().port}/devtools/browser/fake`,
        })
      );
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  server.on('upgrade', (req, socket) => {
    const accept = createHash('sha1')
      .update(`${req.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    socket.on('error', () => {});
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 2) return;
        const op = buf[0] & 0x0f;
        let len = buf[1] & 0x7f;
        let off = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          off = 4;
        }
        const masked = (buf[1] & 0x80) !== 0;
        const maskAt = off;
        if (masked) off += 4;
        if (buf.length < off + len) return;
        const payload = Buffer.from(buf.subarray(off, off + len));
        if (masked) for (let i = 0; i < len; i++) payload[i] ^= buf[maskAt + (i % 4)];
        buf = buf.subarray(off + len);
        if (op === 8) {
          socket.end();
          return;
        }
        if (op !== 1) continue;
        const msg = JSON.parse(payload.toString());
        seen.push(msg);
        if (msg.method === 'Target.attachToTarget') {
          socket.write(wsFrame({ id: msg.id, result: { sessionId: 'S1' } }));
        } else if (msg.method === 'Page.enable') {
          sessions.add(socket);
          if (!stall) socket.write(wsFrame({ id: msg.id, sessionId: msg.sessionId, result: {} }));
        }
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections?.();
        server.close(resolve);
      })
  );
  const url = `http://127.0.0.1:${server.address().port}`;
  return { url, dialogUrl: `${url}/dialog`, seen };
}

async function busyPort() {
  const server = createNetServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise((resolve) => server.close(resolve)));
  return server.address().port;
}

describe('serve --webmcp error reporting', () => {
  it('says a consequential tool is hidden when it is called over stdio', async () => {
    const r = await run(['serve', '--webmcp', '--playwright-cli', fakePwCli], {
      input: `${[init, rpc('tools/list', {}, 2), rpc('tools/call', { name: 'place_order', arguments: { productId: 'a', quantity: 1 } }, 3)].join('\n')}\n`,
    });
    assert.equal(r.status, 0, r.stderr);
    const [, list, call] = responses(r.stdout);
    assert.ok(!list.result.tools.some((t) => t.name === 'place_order'));
    assert.match(list.result._meta['io.mcpcat/hidden'].place_order, /--allow-consequential/);
    assert.equal(call.error.code, -32602);
    assert.match(call.error.message, /place_order exists on the page but is hidden/);
    assert.match(call.error.message, /consequentialHint/);
    assert.match(call.error.message, /serve --webmcp --allow-consequential/);
  });

  it('mcpcat call with flags names the hidden tool instead of an unknown flag', async () => {
    const port = await startWebMcpHttp();
    const url = `http://127.0.0.1:${port}/mcp`;
    const withFlags = await run([
      'call',
      url,
      'place_order',
      '--productId',
      'a',
      '--quantity',
      '1',
    ]);
    assert.equal(withFlags.status, 2, withFlags.stderr);
    assert.doesNotMatch(withFlags.stderr, /unknown flag/);
    assert.match(withFlags.stderr, /place_order exists on the page but is hidden/);
    assert.match(withFlags.stderr, /--allow-consequential/);
    const withData = await run(['call', url, 'place_order', '-d', '{"productId":"a"}']);
    assert.notEqual(withData.status, 0);
    assert.match(withData.stderr, /hidden because it is consequential/);
  });

  it('reports a pinned tab that is gone instead of an empty tool list', async () => {
    const r = await run(['serve', '--webmcp', '--tab', 'GONE', '--playwright-cli', fakePwCli], {
      input: `${[init, rpc('tools/list', {}, 2), rpc('tools/call', { name: 'get_price', arguments: { productId: 'a' } }, 3)].join('\n')}\n`,
      env: { FAKE_PWCLI_TABS: JSON.stringify(['TAB1']) },
    });
    assert.equal(r.status, 0, r.stderr);
    const [, list, call] = responses(r.stdout);
    assert.equal(list.result, undefined);
    assert.match(list.error.message, /tab GONE is gone/);
    assert.match(call.error.message, /tab GONE is gone/);
  });

  it('mcpcat tools fails on a gone tab over HTTP', async () => {
    const port = await startWebMcpHttp(['--tab', 'GONE'], {
      FAKE_PWCLI_TABS: JSON.stringify(['TAB1']),
    });
    const r = await run(['tools', `http://127.0.0.1:${port}/mcp`]);
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /tab GONE is gone/);
  });

  it('a busy port gives one line and exit 3 for every serve mode', async () => {
    const port = await busyPort();
    const modes = [
      ['serve', '--webmcp', '--http', `127.0.0.1:${port}`, '--playwright-cli', fakePwCli],
      ['serve', '--http', `127.0.0.1:${port}`, `node=${fixtureCli}`],
      ['serve', '--proxy', 'http://127.0.0.1:9/mcp', '--http', `127.0.0.1:${port}`],
    ];
    for (const args of modes) {
      const r = await run(args);
      assert.equal(r.status, 3, `${args.join(' ')}: ${r.stderr}`);
      assert.doesNotMatch(r.stderr, /node:net|\n\s+at |UVException/);
      assert.match(
        r.stderr,
        new RegExp(`cannot listen on 127\\.0\\.0\\.1:${port}: address already in use\\n$`)
      );
      assert.equal(r.stderr.trim().split('\n').length, 1, r.stderr);
    }
  });

  it('detects a JavaScript dialog that a tool opens and reports it fast', async () => {
    const cdp = await startFakeCdp();
    const r = await run(['serve', '--webmcp', '--cdp', cdp.url, '--playwright-cli', fakePwCli], {
      input: `${[init, rpc('tools/call', { name: 'get_price', arguments: { productId: 'a' } }, 2), rpc('tools/list', {}, 3)].join('\n')}\n`,
      env: { FAKE_PWCLI_HANG: '1', FAKE_PWCLI_DIALOG_URL: cdp.dialogUrl },
    });
    assert.equal(r.status, 0, r.stderr);
    const [, call, list] = responses(r.stdout);
    assert.match(call.error.message, /^tab TAB1 is blocked by a JavaScript confirm dialog; answer/);
    assert.match(list.error.message, /^tab TAB1 is blocked by a JavaScript confirm dialog/);
    assert.ok(r.ms < 15_000, `took ${r.ms} ms`);
    const attach = cdp.seen.find((m) => m.method === 'Target.attachToTarget');
    assert.equal(attach.params.targetId, 'TAB1');
    assert.ok(cdp.seen.some((m) => m.method === 'Page.enable' && m.sessionId === 'S1'));
  });

  it('answers server/discover while the page is blocked, and tools/list names the dialog', async () => {
    const cdp = await startFakeCdp();
    const r = await run(['serve', '--webmcp', '--cdp', cdp.url, '--playwright-cli', fakePwCli], {
      input: `${[rpc('server/discover', {}, 1), rpc('tools/list', {}, 2)].join('\n')}\n`,
      env: { FAKE_PWCLI_HANG_LIST: '1', FAKE_PWCLI_DIALOG_URL: cdp.dialogUrl },
    });
    assert.equal(r.status, 0, r.stderr);
    const [discover, list] = responses(r.stdout);
    assert.equal(discover.result.serverInfo.name, 'mcpcat-webmcp');
    assert.match(list.error.message, /blocked by a JavaScript confirm dialog/);
    assert.ok(r.ms < 15_000, `took ${r.ms} ms`);
  });

  it('a tab that never answers Page.enable times out with a dialog hint', async () => {
    const cdp = await startFakeCdp({ stall: true });
    const r = await run(
      ['serve', '--webmcp', '--call-timeout', '2', '--cdp', cdp.url, '--playwright-cli', fakePwCli],
      {
        input: `${[init, rpc('tools/call', { name: 'get_price', arguments: { productId: 'a' } }, 2)].join('\n')}\n`,
        env: { FAKE_PWCLI_HANG: '1' },
      }
    );
    assert.equal(r.status, 0, r.stderr);
    const [, call] = responses(r.stdout);
    assert.match(call.error.message, /webmcp-call timed out after 2s; tab TAB1 does not answer/);
    assert.match(call.error.message, /JavaScript dialog opened before mcpcat attached/);
  });

  it('a hung call without a dialog times out with a dialog hint', async () => {
    const r = await run(
      ['serve', '--webmcp', '--call-timeout', '2', '--playwright-cli', fakePwCli],
      {
        input: `${[init, rpc('tools/call', { name: 'get_price', arguments: { productId: 'a' } }, 2)].join('\n')}\n`,
        env: { FAKE_PWCLI_HANG: '1', SLICC_CDP_URL: '' },
      }
    );
    assert.equal(r.status, 0, r.stderr);
    const [, call] = responses(r.stdout);
    assert.match(call.error.message, /webmcp-call timed out after 2s/);
    assert.match(call.error.message, /JavaScript dialog/);
    assert.match(call.error.message, /--cdp/);
  });

  it('a hung call with --cdp and no dialog times out without a false dialog report', async () => {
    const cdp = await startFakeCdp();
    const r = await run(
      ['serve', '--webmcp', '--call-timeout', '3', '--cdp', cdp.url, '--playwright-cli', fakePwCli],
      {
        input: `${[init, rpc('tools/call', { name: 'get_price', arguments: { productId: 'a' } }, 2)].join('\n')}\n`,
        env: { FAKE_PWCLI_HANG: '1' },
      }
    );
    assert.equal(r.status, 0, r.stderr);
    const [, call] = responses(r.stdout);
    assert.equal(call.error.message, 'webmcp-call timed out after 3s');
    assert.ok(cdp.seen.some((m) => m.method === 'Page.enable'));
  });

  it('looks for playwright-cli in PATH instead of trusting any PATH entry', async () => {
    const empty = mkdtempSync(join(testHome, 'empty-'));
    const missing = await run(['serve', '--webmcp'], { env: { PATH: empty } });
    assert.equal(missing.status, 3);
    assert.match(missing.stderr, /playwright-cli not found on PATH/);

    const bin = mkdtempSync(join(testHome, 'bin-'));
    writeFileSync(join(bin, 'playwright-cli'), `#!/bin/sh\nexec "${fakePwCli}" "$@"\n`);
    chmodSync(join(bin, 'playwright-cli'), 0o755);
    const found = await run(['serve', '--webmcp'], {
      input: `${[init, rpc('tools/list', {}, 2)].join('\n')}\n`,
      env: { PATH: `${empty}:${bin}:${dirname(process.execPath)}:/usr/bin:/bin` },
    });
    assert.equal(found.status, 0, found.stderr);
    const [, list] = responses(found.stdout);
    assert.ok(list.result.tools.some((t) => t.name === 'get_price'));
  });
});
