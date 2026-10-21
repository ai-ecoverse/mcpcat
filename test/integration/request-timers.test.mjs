import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { getEventListeners, once } from 'node:events';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const fixturesDir = join(root, 'test/integration/fixtures');
const stdioModule = join(root, 'src/client/stdio-stateless.ts');
const httpModule = join(root, 'src/client/stateless-connection.ts');
const hostModule = join(root, 'src/platform/host.ts');

function runInChild(source, limitMs) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      stdout += c;
    });
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    const killer = setTimeout(() => child.kill('SIGKILL'), limitMs);
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      clearTimeout(killer);
      resolve({ code, signal, stdout, stderr, elapsed: Date.now() - started });
    });
  });
}

describe('stdio-stateless request timers (#319)', () => {
  it('an in-process caller exits promptly after a successful request', async () => {
    const source = `
      import { createStdioStatelessConnection } from ${JSON.stringify(stdioModule)};
      import { createHostPlatform } from ${JSON.stringify(hostModule)};
      const conn = await createStdioStatelessConnection({
        command: process.execPath,
        args: [${JSON.stringify(join(fixturesDir, 'server-stdio-2026.mjs'))}],
        platform: createHostPlatform(),
      });
      const tools = await conn.listTools();
      await conn.close();
      process.stdout.write(String(tools.length));
    `;
    const res = await runInChild(source, 20_000);
    assert.equal(res.signal, null, `child killed after ${res.elapsed}ms: ${res.stderr}`);
    assert.equal(res.code, 0, res.stderr);
    assert.ok(Number(res.stdout) > 0);
    assert.ok(res.elapsed < 15_000, `took ${res.elapsed}ms`);
  });

  it('removes its abort listener from a long-lived signal after each request', async () => {
    const source = `
      import { getEventListeners, once } from 'node:events';
import { createServer } from 'node:http';
      import { createStdioStatelessConnection } from ${JSON.stringify(stdioModule)};
      import { createHostPlatform } from ${JSON.stringify(hostModule)};
      const controller = new AbortController();
      const conn = await createStdioStatelessConnection({
        command: process.execPath,
        args: [${JSON.stringify(join(fixturesDir, 'server-stdio-2026.mjs'))}],
        platform: createHostPlatform(),
        signal: controller.signal,
      });
      for (let i = 0; i < 5; i++) await conn.listTools();
      await conn.close();
      process.stdout.write(String(getEventListeners(controller.signal, 'abort').length));
    `;
    const res = await runInChild(source, 20_000);
    assert.equal(res.code, 0, res.stderr);
    assert.equal(res.stdout, '0');
  });

  it('rejects promptly when aborted during a pending read', async () => {
    const source = `
      import { createStdioStatelessConnection } from ${JSON.stringify(stdioModule)};
      import { createHostPlatform } from ${JSON.stringify(hostModule)};
      const controller = new AbortController();
      const conn = await createStdioStatelessConnection({
        command: process.execPath,
        args: [${JSON.stringify(join(fixturesDir, 'server-stdio-2026-quiet.mjs'))}],
        platform: createHostPlatform(),
        signal: controller.signal,
      });
      const pending = conn.listTools();
      setTimeout(() => controller.abort(), 200);
      const started = Date.now();
      let name = 'resolved';
      try {
        await pending;
      } catch (err) {
        name = err.name;
      }
      await conn.close();
      process.stdout.write(name + ' ' + (Date.now() - started));
    `;
    const res = await runInChild(source, 20_000);
    assert.equal(res.code, 0, res.stderr);
    const [name, ms] = res.stdout.split(' ');
    assert.equal(name, 'McpTimeoutError');
    assert.ok(Number(ms) < 5_000, `took ${ms}ms`);
  });
});

describe('stateless HTTP abort listeners (#319)', () => {
  let server;

  before(async () => {
    const child = spawn(process.execPath, [join(fixturesDir, 'server-2026-http.mjs')], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    const info = await new Promise((resolve, reject) => {
      let data = '';
      child.stdout.on('data', (chunk) => {
        data += chunk.toString();
        if (data.includes('\n')) resolve(JSON.parse(data.trim()));
      });
      child.on('error', reject);
    });
    server = { child, ...info };
  });

  after(() => {
    server?.child.kill('SIGTERM');
  });

  it('removes its abort listener from a long-lived signal after each request', async () => {
    const { createStatelessConnection } = await import(httpModule);
    const controller = new AbortController();
    const conn = await createStatelessConnection({
      url: `http://127.0.0.1:${server.port}`,
      fetchImpl: globalThis.fetch,
      signal: controller.signal,
    });
    for (let i = 0; i < 5; i++) await conn.listTools();
    await conn.close();
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  });

  it('still aborts while the response body is pending', async () => {
    const { createStatelessConnection } = await import(httpModule);
    const stall = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => {
        raw += c;
      });
      req.on('end', () => {
        const msg = JSON.parse(raw);
        if (msg.method === 'server/discover') {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              result: { supportedVersions: ['2026-07-28'], capabilities: {} },
            })
          );
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.write('{');
      });
    });
    stall.listen(0, '127.0.0.1');
    await once(stall, 'listening');
    try {
      const controller = new AbortController();
      const conn = await createStatelessConnection({
        url: `http://127.0.0.1:${stall.address().port}`,
        fetchImpl: globalThis.fetch,
        signal: controller.signal,
      });
      const pending = conn.listTools();
      setTimeout(() => controller.abort(), 200);
      const started = Date.now();
      await assert.rejects(pending);
      assert.ok(Date.now() - started < 5_000);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    } finally {
      stall.closeAllConnections();
      stall.close();
    }
  });
});
