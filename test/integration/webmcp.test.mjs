import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mcpcatArgs } from './helpers/bin.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const fixturesDir = join(root, 'test/integration/fixtures');
const fakePwCli = join(fixturesDir, 'fake-playwright-cli.sh');
const singleOriginFixture = join(fixturesDir, 'webmcp-tools.json');
const multiOriginFixture = join(fixturesDir, 'webmcp-tools-multi-origin.json');

const testHome = join(tmpdir(), `mcpcat-webmcp-test-${Date.now()}`);
mkdirSync(join(testHome, '.pi', 'agent'), { recursive: true });
const testEnv = {
  HOME: testHome,
  PI_CODING_AGENT_DIR: join(testHome, '.pi', 'agent'),
};
const spawnedChildren = [];

after(() => {
  for (const c of spawnedChildren) {
    try {
      c.kill('SIGKILL');
    } catch {}
  }
  spawnedChildren.length = 0;
  rmSync(testHome, { recursive: true, force: true });
});

function rpc(method, params, id) {
  return JSON.stringify({ jsonrpc: '2.0', id: id ?? 1, method, params });
}

function runHost(args, opts = {}) {
  const { cmd, args: cmdArgs } = mcpcatArgs(args);
  try {
    const result = execFileSync(cmd, cmdArgs, {
      encoding: 'utf8',
      timeout: 15_000,
      env: { ...process.env, NODE_NO_WARNINGS: '1', ...testEnv, ...opts.env },
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
      FAKE_PWCLI_FIXTURE: singleOriginFixture,
      FAKE_PWCLI_ECHO_CALL: '1',
      ...extraEnv,
    },
  });
  spawnedChildren.push(child);

  const port = await new Promise((resolve, reject) => {
    let data = '';
    child.stderr.on('data', (chunk) => {
      data += chunk.toString();
      const match = data.match(/listening on http:\/\/[^:]+:(\d+)\/mcp/);
      if (match) resolve(Number(match[1]));
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (!data.includes('listening')) reject(new Error(`Server exited ${code}: ${data}`));
    });
  });

  return { child, port };
}

async function rpcCall(port, method, params) {
  const body = rpc(method, params);
  const resp = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body,
  });
  return resp.json();
}

const NONCE_PATTERN = /<<untrusted-page-content id=([0-9a-f]{16})>>/;

describe('serve --webmcp', () => {
  it('exits 3 when playwright-cli is missing', () => {
    const result = runHost(['serve', '--webmcp', '--playwright-cli', '/nonexistent-binary-path']);
    assert.equal(result.status, 3);
    assert.ok(result.stderr.includes('playwright-cli not found'));
  });

  describe('stdio transport', () => {
    it('lists tools via tools/list', () => {
      const input =
        [
          rpc('initialize', {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'test' },
          }),
          rpc('tools/list', {}, 2),
        ].join('\n') + '\n';

      const result = runHost(['serve', '--webmcp', '--playwright-cli', fakePwCli], {
        input,
        env: { FAKE_PWCLI_FIXTURE: singleOriginFixture },
      });

      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      const lines = result.stdout.trim().split('\n');
      assert.ok(lines.length >= 2);

      const listResp = JSON.parse(lines[1]);
      assert.ok(listResp.result);
      assert.ok(Array.isArray(listResp.result.tools));
      const names = listResp.result.tools.map((t) => t.name);
      assert.ok(names.includes('get_price'), `expected get_price in ${names}`);
      assert.ok(names.includes('search'), `expected search in ${names}`);
      assert.ok(!names.includes('place_order'), 'consequential tool should be hidden by default');
    });

    it('hides consequential tools by default and shows with --allow-consequential', () => {
      const input =
        [
          rpc('initialize', {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'test' },
          }),
          rpc('tools/list', {}, 2),
        ].join('\n') + '\n';

      const withFlag = runHost(
        ['serve', '--webmcp', '--allow-consequential', '--playwright-cli', fakePwCli],
        {
          input,
          env: { FAKE_PWCLI_FIXTURE: singleOriginFixture },
        }
      );

      assert.equal(withFlag.status, 0, `stderr: ${withFlag.stderr}`);
      const lines = withFlag.stdout.trim().split('\n');
      const listResp = JSON.parse(lines[1]);
      const names = listResp.result.tools.map((t) => t.name);
      assert.ok(
        names.includes('place_order'),
        'consequential tool should be visible with --allow-consequential'
      );

      const placeOrder = listResp.result.tools.find((t) => t.name === 'place_order');
      assert.ok(placeOrder.annotations?.destructiveHint === true);
    });

    it('calls a tool with arguments via stdin, never argv', () => {
      const input =
        [
          rpc('initialize', {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'test' },
          }),
          rpc('tools/call', { name: 'get_price', arguments: { productId: 'abc123' } }, 2),
        ].join('\n') + '\n';

      const result = runHost(['serve', '--webmcp', '--playwright-cli', fakePwCli], {
        input,
        env: {
          FAKE_PWCLI_FIXTURE: singleOriginFixture,
          FAKE_PWCLI_ECHO_CALL: '1',
        },
      });

      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      const lines = result.stdout.trim().split('\n');
      assert.ok(lines.length >= 2);

      const callResp = JSON.parse(lines[1]);
      assert.ok(callResp.result);
      assert.equal(callResp.result.isError, false);
      assert.ok(callResp.result.content[0].text.includes('abc123'));

      const callLogLine = result.stderr.split('\n').find((l) => l.includes('CALL_LOG:'));
      if (callLogLine) {
        const callLog = JSON.parse(callLogLine.replace('CALL_LOG:', ''));
        assert.equal(callLog.stdinUsed, true);
        assert.deepEqual(callLog.input, { productId: 'abc123' });
        assert.ok(!callLog.argv.includes('abc123'), 'arguments must not appear in argv');
      }
    });

    it('wraps every result with a nonce-based delimiter', () => {
      const input =
        [
          rpc('initialize', {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'test' },
          }),
          rpc('tools/call', { name: 'get_price', arguments: { productId: 'x' } }, 2),
        ].join('\n') + '\n';

      const result = runHost(['serve', '--webmcp', '--playwright-cli', fakePwCli], {
        input,
        env: { FAKE_PWCLI_FIXTURE: singleOriginFixture, FAKE_PWCLI_ECHO_CALL: '1' },
      });

      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      const lines = result.stdout.trim().split('\n');
      const callResp = JSON.parse(lines[1]);
      const text = callResp.result.content[0].text;
      const match = text.match(NONCE_PATTERN);
      assert.ok(match, `expected nonce-based open tag, got: ${text.slice(0, 120)}`);
      const nonce = match[1];
      assert.ok(text.includes(`<<end id=${nonce}>>`), 'expected matching close tag');
    });

    it('tool without untrustedContentHint still gets wrapped', () => {
      const input =
        [
          rpc('initialize', {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'test' },
          }),
          rpc('tools/call', { name: 'get_price', arguments: { productId: 'y' } }, 2),
        ].join('\n') + '\n';

      const result = runHost(['serve', '--webmcp', '--playwright-cli', fakePwCli], {
        input,
        env: { FAKE_PWCLI_FIXTURE: singleOriginFixture },
      });

      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      const lines = result.stdout.trim().split('\n');
      const callResp = JSON.parse(lines[1]);
      const text = callResp.result.content[0].text;
      assert.ok(
        NONCE_PATTERN.test(text),
        'get_price (no untrustedContentHint) must still be wrapped'
      );
    });

    it('result containing old end marker cannot escape the wrapper', () => {
      const input =
        [
          rpc('initialize', {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'test' },
          }),
          rpc('tools/call', { name: 'get_price', arguments: { productId: 'z' } }, 2),
        ].join('\n') + '\n';

      const result = runHost(['serve', '--webmcp', '--playwright-cli', fakePwCli], {
        input,
        env: { FAKE_PWCLI_FIXTURE: singleOriginFixture },
      });

      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      const lines = result.stdout.trim().split('\n');
      const callResp = JSON.parse(lines[1]);
      const text = callResp.result.content[0].text;

      const match = text.match(NONCE_PATTERN);
      assert.ok(match);
      const nonce = match[1];
      const closeTag = `<<end id=${nonce}>>`;
      const parts = text.split(closeTag);
      assert.equal(parts.length, 2, 'close tag must appear exactly once');
    });

    it('neutralises delimiter prefix inside content', () => {
      const input =
        [
          rpc('initialize', {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'test' },
          }),
          rpc('tools/call', { name: 'get_price', arguments: { productId: 'trick' } }, 2),
        ].join('\n') + '\n';

      const result = runHost(['serve', '--webmcp', '--playwright-cli', fakePwCli], {
        input,
        env: { FAKE_PWCLI_FIXTURE: singleOriginFixture },
      });

      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      const lines = result.stdout.trim().split('\n');
      const callResp = JSON.parse(lines[1]);
      const text = callResp.result.content[0].text;
      const match = text.match(NONCE_PATTERN);
      assert.ok(match);
      const nonce = match[1];
      const openTag = `<<untrusted-page-content id=${nonce}>>`;
      const afterOpen = text.slice(text.indexOf(openTag) + openTag.length);
      const beforeClose = afterOpen.slice(0, afterOpen.indexOf(`<<end id=${nonce}>>`));
      assert.ok(
        !beforeClose.includes('<<untrusted-page-content'),
        'delimiter prefix must be neutralised inside content'
      );
    });

    it('_meta is present on every call result', () => {
      const input =
        [
          rpc('initialize', {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'test' },
          }),
          rpc('tools/call', { name: 'get_price', arguments: { productId: 'meta-test' } }, 2),
        ].join('\n') + '\n';

      const result = runHost(['serve', '--webmcp', '--playwright-cli', fakePwCli], {
        input,
        env: { FAKE_PWCLI_FIXTURE: singleOriginFixture },
      });

      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      const lines = result.stdout.trim().split('\n');
      const callResp = JSON.parse(lines[1]);
      assert.ok(callResp.result._meta, '_meta must be present');
      assert.equal(callResp.result._meta['io.mcpcat/untrusted'], true);
      assert.equal(callResp.result._meta.origin, 'https://shop.example.com');
    });

    it('openWorldHint is set on every bridged tool', () => {
      const input =
        [
          rpc('initialize', {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'test' },
          }),
          rpc('tools/list', {}, 2),
        ].join('\n') + '\n';

      const result = runHost(['serve', '--webmcp', '--playwright-cli', fakePwCli], {
        input,
        env: { FAKE_PWCLI_FIXTURE: singleOriginFixture },
      });

      const lines = result.stdout.trim().split('\n');
      const listResp = JSON.parse(lines[1]);
      for (const tool of listResp.result.tools) {
        assert.equal(
          tool.annotations?.openWorldHint,
          true,
          `${tool.name} must have openWorldHint: true`
        );
      }
    });

    it('maps exit code 1 to isError result', () => {
      const input =
        [
          rpc('initialize', {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'test' },
          }),
          rpc('tools/call', { name: 'get_price', arguments: { productId: 'x' } }, 2),
        ].join('\n') + '\n';

      const result = runHost(['serve', '--webmcp', '--playwright-cli', fakePwCli], {
        input,
        env: {
          FAKE_PWCLI_FIXTURE: singleOriginFixture,
          FAKE_PWCLI_EXIT_CODE: '1',
        },
      });

      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      const lines = result.stdout.trim().split('\n');
      const callResp = JSON.parse(lines[1]);
      assert.equal(callResp.result.isError, true);
    });

    it('maps exit code 2 to JSON-RPC error', () => {
      const input =
        [
          rpc('initialize', {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'test' },
          }),
          rpc('tools/call', { name: 'get_price', arguments: { productId: 'x' } }, 2),
        ].join('\n') + '\n';

      const result = runHost(['serve', '--webmcp', '--playwright-cli', fakePwCli], {
        input,
        env: {
          FAKE_PWCLI_FIXTURE: singleOriginFixture,
          FAKE_PWCLI_EXIT_CODE: '2',
        },
      });

      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      const lines = result.stdout.trim().split('\n');
      const callResp = JSON.parse(lines[1]);
      assert.ok(callResp.error, 'exit 2 should produce a JSON-RPC error');
      assert.equal(callResp.error.code, -32000);
    });

    it('prefixes tool names when multiple origins', () => {
      const input =
        [
          rpc('initialize', {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'test' },
          }),
          rpc('tools/list', {}, 2),
        ].join('\n') + '\n';

      const result = runHost(['serve', '--webmcp', '--playwright-cli', fakePwCli], {
        input,
        env: { FAKE_PWCLI_FIXTURE: multiOriginFixture },
      });

      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      const lines = result.stdout.trim().split('\n');
      const listResp = JSON.parse(lines[1]);
      const names = listResp.result.tools.map((t) => t.name);
      assert.ok(
        names.some((n) => n.includes('shop_example_com')),
        `expected origin prefix in ${names}`
      );
      assert.ok(
        names.some((n) => n.includes('warehouse_example_org')),
        `expected origin prefix in ${names}`
      );
    });

    it('passes readOnlyHint and maps annotations', () => {
      const input =
        [
          rpc('initialize', {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'test' },
          }),
          rpc('tools/list', {}, 2),
        ].join('\n') + '\n';

      const result = runHost(['serve', '--webmcp', '--playwright-cli', fakePwCli], {
        input,
        env: { FAKE_PWCLI_FIXTURE: singleOriginFixture },
      });

      const lines = result.stdout.trim().split('\n');
      const listResp = JSON.parse(lines[1]);

      const getPrice = listResp.result.tools.find((t) => t.name === 'get_price');
      assert.ok(getPrice.annotations?.readOnlyHint === true);

      const search = listResp.result.tools.find((t) => t.name === 'search');
      assert.ok(search.annotations?.openWorldHint === true);
    });

    it('includes origin in tool description', () => {
      const input =
        [
          rpc('initialize', {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'test' },
          }),
          rpc('tools/list', {}, 2),
        ].join('\n') + '\n';

      const result = runHost(['serve', '--webmcp', '--playwright-cli', fakePwCli], {
        input,
        env: { FAKE_PWCLI_FIXTURE: singleOriginFixture },
      });

      const lines = result.stdout.trim().split('\n');
      const listResp = JSON.parse(lines[1]);
      const getPrice = listResp.result.tools.find((t) => t.name === 'get_price');
      assert.ok(getPrice.description.includes('https://shop.example.com'));
    });
  });

  describe('TTL cache', () => {
    it('reuses cached tools within TTL', () => {
      const input =
        [
          rpc('initialize', {
            protocolVersion: '2025-11-25',
            capabilities: {},
            clientInfo: { name: 'test' },
          }),
          rpc('tools/list', {}, 2),
          rpc('tools/list', {}, 3),
        ].join('\n') + '\n';

      const result = runHost(
        ['serve', '--webmcp', '--playwright-cli', fakePwCli, '--webmcp-ttl', '60'],
        {
          input,
          env: { FAKE_PWCLI_FIXTURE: singleOriginFixture },
        }
      );

      assert.equal(result.status, 0, `stderr: ${result.stderr}`);
      const lines = result.stdout.trim().split('\n');
      assert.ok(lines.length >= 3);
      const resp2 = JSON.parse(lines[1]);
      const resp3 = JSON.parse(lines[2]);
      assert.deepEqual(resp2.result.tools.length, resp3.result.tools.length);
    });
  });

  describe('HTTP transport', () => {
    let server;
    after(async () => {
      if (server?.child) {
        try {
          server.child.kill('SIGKILL');
        } catch {}
      }
    });

    it('serves tools over HTTP', async () => {
      server = await startWebMcpHttp();
      const listResult = await rpcCall(server.port, 'tools/list', {});
      assert.ok(listResult.result);
      assert.ok(Array.isArray(listResult.result.tools));
      assert.ok(listResult.result.tools.length > 0);
    });

    it('calls tools over HTTP with _meta', async () => {
      if (!server) server = await startWebMcpHttp();
      const callResult = await rpcCall(server.port, 'tools/call', {
        name: 'get_price',
        arguments: { productId: 'http-test' },
      });
      assert.ok(callResult.result);
      assert.equal(callResult.result.isError, false);
      assert.ok(callResult.result.content[0].text.includes('http-test'));
      assert.ok(callResult.result._meta, '_meta must be present over HTTP');
      assert.equal(callResult.result._meta['io.mcpcat/untrusted'], true);
    });
  });
});
