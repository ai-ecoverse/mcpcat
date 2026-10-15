import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const hostBin = join(root, 'dist/host/mcpcat.mjs');
const fixtureCli = join(root, 'test/integration/fixtures/serve-soak-cli.sh');

async function startServeHttp() {
  const child = spawn(
    process.execPath,
    [hostBin, 'serve', '--http', '0', '--no-auth', `soak=${fixtureCli}`],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    }
  );

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

function serverRssMb(pid) {
  const kb = Number(execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' }));
  return kb / 1024;
}

async function call(port, id) {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json',
      connection: 'close',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: 'soak_echo', arguments: { text: `soak iteration ${id}` } },
    }),
  });
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.ok(json.result, JSON.stringify(json));
  assert.equal(json.result.isError, false);
  assert.equal(json.result.structuredContent.stdout, `soak iteration ${id}\n`);
}

describe('serve: soak test (500 sequential calls)', () => {
  let server;

  before(async () => {
    server = await startServeHttp();
  });

  after(async () => {
    if (!server || server.child.exitCode !== null) return;
    server.child.kill('SIGTERM');
    await once(server.child, 'exit');
  });

  it('server RSS stays within bound over 500 calls', async () => {
    const CALLS = 500;
    const MAX_RSS_MB = 150;

    for (let i = 1; i <= CALLS; i++) await call(server.port, i);

    const rss = serverRssMb(server.child.pid);
    assert.ok(rss < MAX_RSS_MB, `server RSS ${rss.toFixed(1)} MB exceeds ${MAX_RSS_MB} MB limit`);
  });
});
