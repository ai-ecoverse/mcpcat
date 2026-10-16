import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mcpcatArgs } from './helpers/bin.mjs';

const stdioFixture = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/server-stdio-control-chars.mjs'
);
const EVIL = 'boom \x1b]0;pwned\x07 \x1b[2J \x9b31m end';
const CONTROL_RE = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/;

function run(args, env) {
  const { cmd, args: cmdArgs } = mcpcatArgs(args);
  return new Promise((resolve) => {
    const child = spawn(cmd, cmdArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1', ...env },
    });
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

function rpcServer() {
  return createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
    });
    req.on('end', () => {
      if (req.url === '/forbidden') {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end(EVIL);
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405);
        res.end();
        return;
      }
      const msg = JSON.parse(body);
      if (msg.id === undefined) {
        res.writeHead(202);
        res.end();
        return;
      }
      let payload;
      if (msg.method === 'server/discover') {
        payload = { error: { code: -32601, message: 'Method not found' } };
      } else if (msg.method === 'initialize') {
        payload = {
          result: {
            protocolVersion: '2025-11-25',
            capabilities: { tools: {} },
            serverInfo: { name: 'evil', version: '1.0.0' },
          },
        };
      } else if (msg.method === 'tools/list') {
        const inputSchema = { type: 'object', properties: {} };
        payload = {
          result: {
            tools: ['toolerr', 'ok', 'rpcerr'].map((name) => ({ name, inputSchema })),
          },
        };
      } else if (msg.method === 'tools/call' && msg.params?.name === 'toolerr') {
        payload = { result: { isError: true, content: [{ type: 'text', text: EVIL }] } };
      } else if (msg.method === 'tools/call' && msg.params?.name === 'ok') {
        payload = { result: { content: [{ type: 'text', text: EVIL }] } };
      } else {
        payload = { error: { code: -32000, message: EVIL } };
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ...payload }));
    });
  });
}

describe('server-supplied control characters in printed messages', () => {
  let server;
  let base;
  let home;
  let env;

  before(async () => {
    server = rpcServer();
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${server.address().port}`;
    home = mkdtempSync(join(tmpdir(), 'mcpcat-sanitize-'));
    env = { HOME: home, PI_CODING_AGENT_DIR: join(home, 'agent') };
  });

  after(() => {
    server?.close();
    rmSync(home, { recursive: true, force: true });
  });

  it('a 403 text/plain reason is printed without control characters', async () => {
    const r = await run(['call', `${base}/forbidden`, 'whoami'], env);
    assert.equal(r.status, 4, r.stderr);
    assert.ok(r.stderr.includes('pwned'), r.stderr);
    assert.ok(!CONTROL_RE.test(r.stderr), JSON.stringify(r.stderr));
  });

  it('a JSON-RPC error message is printed without control characters', async () => {
    const r = await run(['call', `${base}/mcp`, 'rpcerr'], env);
    assert.notEqual(r.status, 0);
    assert.ok(r.stderr.includes('pwned'), r.stderr);
    assert.ok(!CONTROL_RE.test(r.stderr), JSON.stringify(r.stderr));
  });

  it('a tool error is printed without control characters', async () => {
    const r = await run(['call', `${base}/mcp`, 'toolerr'], env);
    assert.equal(r.status, 1, r.stderr);
    assert.ok(r.stderr.includes('pwned'), r.stderr);
    assert.ok(!CONTROL_RE.test(r.stderr), JSON.stringify(r.stderr));
  });

  it('-v logs are printed without control characters', async () => {
    const r = await run(['-v', 'call', `${base}/mcp`, 'rpcerr'], env);
    assert.ok(r.stderr.includes('< '), r.stderr);
    assert.ok(!CONTROL_RE.test(r.stderr), JSON.stringify(r.stderr));
  });

  it('--json keeps the JSON-RPC error message byte-exact', async () => {
    const r = await run(['call', '--json', `${base}/mcp`, 'rpcerr'], env);
    assert.notEqual(r.status, 0);
    const parsed = JSON.parse(r.stderr);
    assert.ok(parsed.error.message.includes(EVIL), r.stderr);
  });

  it('--json keeps the 403 reason byte-exact', async () => {
    const r = await run(['call', '--json', `${base}/forbidden`, 'whoami'], env);
    assert.equal(r.status, 4, r.stderr);
    const parsed = JSON.parse(r.stderr);
    assert.ok(parsed.error.message.includes(EVIL), r.stderr);
  });

  it('the result on stdout stays byte-exact', async () => {
    const r = await run(['call', `${base}/mcp`, 'ok'], env);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `${EVIL}\n`);
  });

  it('-v progress and stdio server stderr are printed without control characters', async () => {
    const r = await run(['-v', 'call', `stdio:node ${stdioFixture}`, 'progress'], env);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stderr.includes('* progress: 50% boom'), r.stderr);
    assert.ok(r.stderr.includes('[server] boom'), r.stderr);
    assert.ok(!CONTROL_RE.test(r.stderr), JSON.stringify(r.stderr));
  });

  it('a code target that fails to connect is reported without control characters', async () => {
    const r = await run(['code', '-s', `${base}/forbidden`, '-e', '1'], env);
    assert.ok(r.stderr.includes('pwned'), r.stderr);
    assert.ok(!CONTROL_RE.test(r.stderr), JSON.stringify(r.stderr));
  });
});
