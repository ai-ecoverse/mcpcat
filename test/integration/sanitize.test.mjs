import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { waitForAuthorizeUrl } from './helpers/authorize.mjs';
import { isStandalone, mcpcatArgs, mcpcatBin } from './helpers/bin.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(here, 'fixtures');
const stdioFixture = join(fixturesDir, 'server-stdio-control-chars.mjs');
const elicitFixture = join(fixturesDir, 'server-stdio-2026-control-chars.mjs');
const fakeTty = join(here, 'helpers/fake-tty.mjs');
const fakePwCli = join(fixturesDir, 'fake-playwright-cli.sh');
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

function runTty(args, env, input) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--import', fakeTty, mcpcatBin, ...args], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1', ...env },
    });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.stdin.on('error', () => {});
    child.stdin.end(input);
    child.on('exit', (status) =>
      resolve({
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        status,
      })
    );
  });
}

function startFixture(script, args = []) {
  const child = spawn(process.execPath, [join(fixturesDir, script), ...args], {
    stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  return new Promise((resolve, reject) => {
    let data = '';
    child.stdout.on('data', (chunk) => {
      data += chunk;
      if (data.includes('\n')) resolve({ child, ...JSON.parse(data.split('\n')[0]) });
    });
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`${script} exited ${code}`)));
  });
}

function scriptCalling(suffix) {
  return `const n = ALL_TOOLS.find((t) => t.name.endsWith('__${suffix}')).name; await tools[n]({});`;
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
            tools: ['toolerr', 'ok', 'rpcerr'].map((name) => ({
              name,
              inputSchema,
            })),
          },
        };
      } else if (msg.method === 'tools/call' && msg.params?.name === 'toolerr') {
        payload = {
          result: { isError: true, content: [{ type: 'text', text: EVIL }] },
        };
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

  it('add reports a failed probe without control characters', async () => {
    const config = join(home, 'add-probe.json');
    const r = await run(['add', '--config', config, 'evil', `${base}/forbidden`], env);
    assert.equal(r.status, 3, r.stderr);
    assert.ok(r.stderr.includes('mcpcat add: probe failed:'), r.stderr);
    assert.ok(r.stderr.includes('pwned'), r.stderr);
    assert.ok(!CONTROL_RE.test(r.stderr), JSON.stringify(r.stderr));
  });

  it('a code script whose tool call fails is reported without control characters', async () => {
    const r = await run(['code', '-s', `${base}/mcp`, '-e', scriptCalling('rpcerr')], env);
    assert.equal(r.status, 1, r.stderr);
    assert.ok(r.stderr.includes('mcpcat: script failed: boom'), r.stderr);
    assert.ok(!CONTROL_RE.test(r.stderr), JSON.stringify(r.stderr));
  });

  it('a code script whose tool reports an error is reported without control characters', async () => {
    const r = await run(['code', '-s', `${base}/mcp`, '-e', scriptCalling('toolerr')], env);
    assert.equal(r.status, 1, r.stderr);
    assert.ok(r.stderr.includes('mcpcat: script failed: boom'), r.stderr);
    assert.ok(!CONTROL_RE.test(r.stderr), JSON.stringify(r.stderr));
  });

  it('code --json keeps the script failure byte-exact', async () => {
    const r = await run(
      ['code', '--json', '-s', `${base}/mcp`, '-e', scriptCalling('rpcerr')],
      env
    );
    assert.equal(r.status, 1, r.stderr);
    const parsed = JSON.parse(r.stdout);
    assert.equal(parsed.ok, false);
    assert.ok(parsed.error.message.includes(EVIL), r.stdout);
  });

  it('serve --webmcp reports a playwright-cli failure without control characters', async () => {
    const r = await run(['serve', '--webmcp', '--playwright-cli', fakePwCli], {
      ...env,
      FAKE_PWCLI_TAB_LIST_FAIL: '1',
    });
    assert.equal(r.status, 3, r.stderr);
    assert.ok(r.stderr.includes('mcpcat serve --webmcp: boom'), r.stderr);
    assert.ok(!CONTROL_RE.test(r.stderr), JSON.stringify(r.stderr));
  });
});

describe('server-supplied control characters in elicitation prompts', {
  skip: isStandalone,
}, () => {
  let home;
  let env;
  const target = `stdio:node ${elicitFixture}`;

  before(() => {
    home = mkdtempSync(join(tmpdir(), 'mcpcat-sanitize-elicit-'));
    env = { HOME: home, PI_CODING_AGENT_DIR: join(home, 'agent') };
  });

  after(() => rmSync(home, { recursive: true, force: true }));

  it('the elicitation message and field prompt are printed without control characters', async () => {
    const r = await runTty(['call', target, 'ask'], env, '\n');
    assert.ok(r.stderr.startsWith('boom \\x1b]0;pwned'), JSON.stringify(r.stderr));
    assert.ok(r.stderr.includes('key boom'), r.stderr);
    assert.ok(r.stderr.includes(' - boom'), r.stderr);
    assert.ok(r.stderr.includes(' (boom'), r.stderr);
    assert.ok(r.stderr.includes('|b) [boom'), r.stderr);
    assert.ok(!CONTROL_RE.test(r.stderr), JSON.stringify(r.stderr));
  });

  it('a URL-mode elicitation is printed without control characters', async () => {
    const r = await runTty(['call', target, 'ask-url'], env, '\n');
    assert.ok(r.stderr.includes('Open this URL to continue: https://example.com/boom'), r.stderr);
    assert.ok(!CONTROL_RE.test(r.stderr), JSON.stringify(r.stderr));
  });
});

describe('server-supplied control characters in login failures', () => {
  let as;
  let mcp;
  let home;
  let env;

  before(async () => {
    as = await startFixture('oauth-as.mjs');
    mcp = await startFixture('server-oauth-protected.mjs', [as.issuer]);
    home = mkdtempSync(join(tmpdir(), 'mcpcat-sanitize-login-'));
    const agent = join(home, 'agent');
    mkdirSync(agent, { recursive: true });
    writeFileSync(
      join(agent, 'mcp.json'),
      JSON.stringify({
        mcpServers: { evil: { url: `http://127.0.0.1:${mcp.port}/mcp` } },
      })
    );
    env = { HOME: home, PI_CODING_AGENT_DIR: agent };
  });

  after(() => {
    as?.child.kill('SIGTERM');
    mcp?.child.kill('SIGTERM');
    rmSync(home, { recursive: true, force: true });
  });

  it('an authorization error from the AS is printed without control characters', async () => {
    const { cmd, args } = mcpcatArgs(['login', 'evil', '--no-browser']);
    const child = spawn(cmd, args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1', ...env },
    });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d;
    });
    const exited = new Promise((resolve) => child.on('exit', resolve));
    const authorize = new URL(await waitForAuthorizeUrl(child, () => stderr));
    const redirect = new URL(authorize.searchParams.get('redirect_uri'));
    redirect.searchParams.set('error', 'access_denied');
    redirect.searchParams.set('error_description', EVIL);
    redirect.searchParams.set('state', authorize.searchParams.get('state'));
    child.stdin.end(`${redirect.href}\n`);
    const status = await exited;
    assert.equal(status, 4, stderr);
    assert.ok(stderr.includes('mcpcat: login failed: boom'), stderr);
    assert.ok(!CONTROL_RE.test(stderr), JSON.stringify(stderr));
  });
});

describe('server-supplied control characters in an unanswered elicitation', () => {
  let home;
  let env;
  const target = `stdio:node ${elicitFixture}`;

  before(() => {
    home = mkdtempSync(join(tmpdir(), 'mcpcat-sanitize-input-'));
    env = { HOME: home, PI_CODING_AGENT_DIR: join(home, 'agent') };
  });

  after(() => rmSync(home, { recursive: true, force: true }));

  for (const flags of [[], ['--json']]) {
    it(`the input request is printed without control characters (${flags.join(' ') || 'text'})`, async () => {
      const r = await run(['call', ...flags, target, 'ask'], env);
      assert.equal(r.status, 6, r.stderr);
      assert.ok(!CONTROL_RE.test(r.stderr), JSON.stringify(r.stderr));
      const parsed = JSON.parse(r.stderr);
      assert.equal(parsed.result.inputRequest.message, EVIL);
    });
  }

  it('an input request without a form is printed without control characters', async () => {
    const r = await run(['call', target, 'ask-bare'], env);
    assert.equal(r.status, 6, r.stderr);
    assert.ok(!CONTROL_RE.test(r.stderr), JSON.stringify(r.stderr));
    assert.equal(JSON.parse(r.stderr).result.content[0].text, EVIL);
  });
});

describe('server-supplied control characters in discovery messages', () => {
  let home;
  let env;

  before(() => {
    home = mkdtempSync(join(tmpdir(), 'mcpcat-sanitize-disc-'));
    const agent = join(home, 'agent');
    mkdirSync(agent, { recursive: true });
    writeFileSync(join(agent, 'mcp.json'), '{"mcpServers":{}}\n');
    env = {
      HOME: home,
      PI_CODING_AGENT_DIR: agent,
      XDG_STATE_HOME: join(home, 'state'),
    };
  });

  after(() => rmSync(home, { recursive: true, force: true }));

  it('an invalid discovery event is reported without control characters', async () => {
    const events = join(home, 'bad.ndjson');
    writeFileSync(events, `${EVIL}\n`);
    const r = await run(['add', '--from-discovery', events], env);
    assert.equal(r.status, 2, r.stderr);
    assert.ok(r.stderr.includes('invalid JSON: boom'), r.stderr);
    assert.ok(!CONTROL_RE.test(r.stderr), JSON.stringify(r.stderr));
  });

  it('a trust mismatch warning is printed without control characters', async () => {
    const events = join(home, 'squatted.ndjson');
    const event = {
      v: 1,
      standard: 'ard',
      origin: 'https://legit.example.com',
      url: 'https://legit.example.com/.well-known/ard.json',
      via: 'well-known',
      page: 'https://legit.example.com/',
      targetId: 't1',
      status: 'valid',
      summary: {
        entries: [
          {
            identifier: 'urn:air:legit.example.com:mcp:squatted',
            displayName: 'Squatted',
            type: 'application/mcp-server-card+json',
            url: 'https://legit.example.com/mcp',
            trustManifest: { identity: EVIL },
          },
        ],
      },
    };
    writeFileSync(events, `${JSON.stringify(event)}\n`);
    const added = await run(['add', '--from-discovery', events], env);
    assert.equal(added.status, 0, added.stderr);
    const r = await run(['add', 'squatted', '--candidate', '1'], env);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stderr.includes('trust-manifest-mismatch: identity boom'), r.stderr);
    assert.ok(!CONTROL_RE.test(r.stderr), JSON.stringify(r.stderr));
  });
});

describe('control characters in a jerk sign-in failure', () => {
  let home;
  let env;

  before(() => {
    home = mkdtempSync(join(tmpdir(), 'mcpcat-sanitize-jerk-'));
    const agent = join(home, 'agent');
    const bin = join(home, 'bin');
    mkdirSync(agent, { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(agent, 'mcp.json'),
      JSON.stringify({
        mcpServers: { evil: { url: 'https://mcp.example.com/' } },
      })
    );
    writeFileSync(join(home, 'evil.txt'), `${EVIL}\n`);
    writeFileSync(
      join(bin, 'jerk'),
      [
        '#!/bin/sh',
        'case "$1" in',
        '  --version) echo "jerk 0.14.1"; exit 0 ;;',
        `  list) echo '[{"provider":"mcp:evil","source":"mcp.json"}]'; exit 0 ;;`,
        'esac',
        `cat "${join(home, 'evil.txt')}" >&2`,
        'exit 1',
        '',
      ].join('\n'),
      { mode: 0o755 }
    );
    env = {
      HOME: home,
      PI_CODING_AGENT_DIR: agent,
      PATH: `${bin}:${process.env.PATH}`,
    };
  });

  after(() => rmSync(home, { recursive: true, force: true }));

  it('the jerk error output is printed without control characters', async () => {
    const r = await run(['login', 'evil'], env);
    assert.notEqual(r.status, 0, r.stderr);
    assert.ok(r.stderr.includes('boom'), r.stderr);
    assert.ok(!CONTROL_RE.test(r.stderr), JSON.stringify(r.stderr));
  });
});
