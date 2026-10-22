import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { mcpcatArgs } from './helpers/bin.mjs';
import { createNodeKernel, hostUrl, nodeTransport } from './helpers/kernel.mjs';
import { fixtures, homeEnv, root, run, scratchHome } from './helpers/rows.mjs';

const PV = 'io.modelcontextprotocol/protocolVersion';
const CI = 'io.modelcontextprotocol/clientInfo';
const CC = 'io.modelcontextprotocol/clientCapabilities';
const WEATHER_B64 = `=?base64?${Buffer.from('天気').toString('base64')}?=`;
const UMLAUT_URI = 'file:///notes/ü.txt';
const strictStdio = join(fixtures, 'server-stdio-2026-strict.mjs');
const home = scratchHome('spec2026');
const env = homeEnv(home);

async function startHttp(args = []) {
  const child = spawn(process.execPath, [join(fixtures, 'server-2026-strict-http.mjs'), ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  const port = await new Promise((resolve, reject) => {
    let data = '';
    child.stdout.on('data', (chunk) => {
      data += chunk;
      const nl = data.indexOf('\n');
      if (nl >= 0) resolve(JSON.parse(data.slice(0, nl)).port);
    });
    child.on('exit', (code) => reject(new Error(`strict server exited ${code}`)));
  });
  return { child, port, url: `http://127.0.0.1:${port}/mcp` };
}

async function log(port) {
  return (await fetch(`http://127.0.0.1:${port}/_test/log`)).json();
}

function assertModernShape(entries) {
  const modern = entries.filter((e) => e.era === 'modern');
  assert.ok(modern.length > 0);
  for (const e of modern) {
    assert.equal(typeof e.meta[PV], 'string', `${e.method} lacks ${PV}`);
    assert.equal(e.protocolHeader, e.meta[PV], `${e.method} header differs from _meta`);
    assert.deepEqual(e.meta[CC], {}, `${e.method} lacks ${CC}`);
    assert.equal(e.meta[CI].name, 'mcpcat');
    for (const bare of ['protocolVersion', 'clientInfo', 'clientCapabilities']) {
      assert.ok(!(bare in e.meta), `${e.method} sends unprefixed _meta.${bare}`);
    }
  }
}

describe('2026-07-28 requests against a strict server (host)', () => {
  let strict;
  let dual;
  let modernError;

  before(async () => {
    strict = await startHttp();
    dual = await startHttp(['--dual', '--reject=-32602']);
    modernError = await startHttp(['--dual', '--reject=-32021']);
  });

  after(() => {
    for (const s of [strict, dual, modernError]) s?.child.kill('SIGTERM');
  });

  it('info, call, read and prompt succeed with prefixed _meta and matching headers', async () => {
    const info = run(['info', strict.url], { env });
    assert.equal(info.status, 0, info.stderr);
    assert.match(info.stdout, /strict-modern/);
    assert.match(info.stdout, /Protocol: 2026-07-28/);
    const call = run(['call', strict.url, '天気', '-d', '{"city":"Kyoto"}'], { env });
    assert.equal(call.status, 0, call.stderr);
    assert.match(call.stdout, /strict-modern:tool:天気/);
    const read = run(['read', strict.url, UMLAUT_URI], { env });
    assert.equal(read.status, 0, read.stderr);
    assert.match(read.stdout, /read:file:\/\/\/notes\/ü\.txt/);
    const prompt = run(['prompt', strict.url, 'greet'], { env });
    assert.equal(prompt.status, 0, prompt.stderr);
    assert.match(prompt.stdout, /prompt:greet/);
    const entries = await log(strict.port);
    assertModernShape(entries);
    assert.ok(!entries.some((e) => e.method === 'initialize'));
    assert.equal(entries.find((e) => e.method === 'tools/call').nameHeader, WEATHER_B64);
    const readEntry = entries.find((e) => e.method === 'resources/read');
    assert.equal(readEntry.nameHeader, `=?base64?${Buffer.from(UMLAUT_URI).toString('base64')}?=`);
    assert.equal(entries.find((e) => e.method === 'prompts/get').nameHeader, 'greet');
  });

  it('falls back to initialize on a 4xx without a recognized modern error body', async () => {
    const info = run(['info', dual.url], { env });
    assert.equal(info.status, 0, info.stderr);
    assert.match(info.stdout, /strict-legacy/);
    assert.match(info.stdout, /Protocol: 2025-11-25/);
    const call = run(['call', dual.url, 'echo', '-d', '{"message":"hi"}'], { env });
    assert.equal(call.status, 0, call.stderr);
    assert.match(call.stdout, /strict-legacy:hi/);
    const methods = (await log(dual.port)).map((e) => e.method);
    assert.equal(methods[0], 'server/discover');
    assert.equal(methods[1], 'initialize');
  });

  it('does not fall back when the 4xx body is a recognized modern error', async () => {
    const info = run(['info', modernError.url], { env });
    assert.notEqual(info.status, 0);
    assert.match(info.stderr, /-32021/);
    assert.ok(!(await log(modernError.port)).some((e) => e.method === 'initialize'));
  });

  it('stdio requests carry prefixed _meta and no server/discover protocolVersion', () => {
    const info = run(['info', '--', process.execPath, strictStdio], { env });
    assert.equal(info.status, 0, info.stderr);
    assert.match(info.stdout, /strict-modern/);
    const call = run(['call', `stdio:${process.execPath} ${strictStdio}`, '天気', '-d', '{}'], {
      env,
    });
    assert.equal(call.status, 0, call.stderr);
    assert.match(call.stdout, /strict-modern:tool:天気/);
  });

  it('stdio falls back to initialize on any non-modern probe error', () => {
    const info = run(['info', '--', process.execPath, strictStdio, '--dual', '--reject=-32602'], {
      env,
    });
    assert.equal(info.status, 0, info.stderr);
    assert.match(info.stdout, /strict-legacy/);
  });

  it('stdio stays modern on a recognized modern probe error', () => {
    const info = run(['info', '--', process.execPath, strictStdio, '--dual', '--reject=-32021'], {
      env,
    });
    assert.notEqual(info.status, 0);
    assert.match(info.stderr, /-32021/);
  });

  it('serve --proxy forwards spec-shaped requests upstream', async () => {
    const { cmd, args } = mcpcatArgs(['serve', '--proxy', strict.url, '--http', '0', '--no-auth']);
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    try {
      const port = await new Promise((resolve, reject) => {
        let data = '';
        child.stderr.on('data', (chunk) => {
          data += chunk;
          const m = data.match(/listening on http:\/\/[^:]+:(\d+)\/mcp/);
          if (m) resolve(Number(m[1]));
        });
        child.on('exit', (code) => reject(new Error(`proxy exited ${code}: ${data}`)));
      });
      const url = `http://127.0.0.1:${port}/mcp`;
      const info = run(['info', url], { env });
      assert.equal(info.status, 0, info.stderr);
      assert.match(info.stdout, /strict-modern/);
      assert.match(info.stdout, /Protocol: 2026-07-28/);
      const call = run(['call', url, 'echo', '-d', '{"message":"via proxy"}'], { env });
      assert.equal(call.status, 0, call.stderr);
      assert.match(call.stdout, /strict-modern:via proxy/);
      assertModernShape(await log(strict.port));
    } finally {
      child.kill('SIGTERM');
    }
  });
});

describe('discover probes a 2026-07-28 server that answers over SSE', () => {
  const servers = [];

  after(() => {
    for (const s of servers) s.child.kill('SIGTERM');
  });

  for (const [label, args] of [
    ['with only the result event', ['--sse']],
    ['after a request-related notification', ['--sse', '--notify']],
  ]) {
    it(label, async () => {
      const server = await startHttp(args);
      servers.push(server);
      const r = run(['discover', server.url], {
        env: homeEnv(home, { XDG_STATE_HOME: join(home, `.state-${servers.length}`) }),
      });
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /mcp\s+http:\/\/127\.0\.0\.1:\d+\/mcp\s+\(strict-modern\)/);
      const discover = (await log(server.port)).find((e) => e.method === 'server/discover');
      assert.equal(discover.protocolHeader, '2026-07-28');
    });
  }
});

describe('serve answers 2026-07-28 requests with spec-shaped results', () => {
  let child;
  let url;

  before(async () => {
    const { cmd, args } = mcpcatArgs([
      'serve',
      '--http',
      '0',
      '--no-auth',
      `node=${join(fixtures, 'serve-cli.mjs')}`,
    ]);
    child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env });
    const port = await new Promise((resolve, reject) => {
      let data = '';
      child.stderr.on('data', (chunk) => {
        data += chunk;
        const m = data.match(/listening on http:\/\/[^:]+:(\d+)\/mcp/);
        if (m) resolve(Number(m[1]));
      });
      child.on('exit', (code) => reject(new Error(`serve exited ${code}: ${data}`)));
    });
    url = `http://127.0.0.1:${port}/mcp`;
  });

  after(() => child?.kill('SIGTERM'));

  async function post(method, params) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-protocol-version': '2026-07-28',
        'mcp-method': method,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method, params }),
    });
    return res.json();
  }

  const meta = { [PV]: '2026-07-28', [CI]: { name: 't', version: '1' }, [CC]: {} };

  it('server/discover carries resultType and _meta serverInfo', async () => {
    const { result } = await post('server/discover', { _meta: meta });
    assert.equal(result.resultType, 'complete');
    assert.ok(result.supportedVersions.includes('2026-07-28'));
    assert.equal(typeof result._meta['io.modelcontextprotocol/serverInfo'].name, 'string');
    assert.ok(!('protocolVersion' in result));
  });

  it('modern tools/list carries resultType, legacy initialize does not', async () => {
    const list = await post('tools/list', { _meta: meta });
    assert.equal(list.result.resultType, 'complete');
    const init = await post('initialize', { protocolVersion: '2025-11-25' });
    assert.ok(!('resultType' in init.result));
  });
});

describe('2026-07-28 requests against a strict server (kernel)', () => {
  let kernel;
  let strict;
  let dual;

  before(async () => {
    strict = await startHttp();
    dual = await startHttp(['--dual', '--reject=-32602']);
    kernel = await createNodeKernel({
      network: { transport: nodeTransport({ hostLoopback: true }) },
    });
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    await kernel.writeFile(
      '/node_modules/@ai-ecoverse/mcpcat/dist/kernel/mcpcat.mjs',
      readFileSync(join(root, 'dist/kernel/mcpcat.mjs'))
    );
    await kernel.writeFile(
      '/node_modules/@ai-ecoverse/mcpcat/package.json',
      JSON.stringify({
        name: '@ai-ecoverse/mcpcat',
        version: pkg.version,
        type: 'module',
        slicc: { commands: { mcpcat: { abi: 'js', module: 'dist/kernel/mcpcat.mjs' } } },
      })
    );
    await kernel.writeFile(
      '/node_modules/@ai-ecoverse/mcpcat-test-strict/dist/server.mjs',
      readFileSync(join(fixtures, 'kernel-stdio-2026-strict.mjs'))
    );
    await kernel.writeFile(
      '/node_modules/@ai-ecoverse/mcpcat-test-strict/package.json',
      JSON.stringify({
        name: '@ai-ecoverse/mcpcat-test-strict',
        version: '1.0.0',
        type: 'module',
        slicc: { commands: { 'mcpcat-test-strict': { abi: 'js', module: 'dist/server.mjs' } } },
      })
    );
  });

  after(() => {
    strict?.child.kill('SIGTERM');
    dual?.child.kill('SIGTERM');
    kernel?.terminate();
  });

  function krun(args) {
    return kernel.run(['mcpcat', ...args], { stdout: 'pipe', stderr: 'pipe' });
  }

  it('HTTP info and non-ASCII call are spec-shaped', async () => {
    const url = `${hostUrl(strict.port)}/mcp`;
    const info = await krun(['info', url]);
    assert.equal(info.status, 0, info.stderr);
    assert.match(info.stdout, /strict-modern/);
    const call = await krun(['call', url, '天気', '-d', '{}']);
    assert.equal(call.status, 0, call.stderr);
    assert.match(call.stdout, /strict-modern:tool:天気/);
    const entries = await log(strict.port);
    assertModernShape(entries);
    assert.equal(entries.find((e) => e.method === 'tools/call').nameHeader, WEATHER_B64);
  });

  it('HTTP falls back to initialize against a dual-era server', async () => {
    const info = await krun(['info', `${hostUrl(dual.port)}/mcp`]);
    assert.equal(info.status, 0, info.stderr);
    assert.match(info.stdout, /strict-legacy/);
    assert.ok((await log(dual.port)).some((e) => e.method === 'initialize'));
  });

  it('stdio requests are spec-shaped', async () => {
    const info = await krun(['info', '--', 'mcpcat-test-strict']);
    assert.equal(info.status, 0, info.stderr);
    assert.match(info.stdout, /strict-modern/);
  });

  it('stdio falls back to initialize on a non-modern probe error', async () => {
    const info = await krun(['info', '--', 'mcpcat-test-strict', '--dual', '--reject=-32602']);
    assert.equal(info.status, 0, info.stderr);
    assert.match(info.stdout, /strict-legacy/);
  });
});
