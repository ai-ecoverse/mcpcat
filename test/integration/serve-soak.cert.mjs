import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const hostBin = join(root, 'dist/host/mcpcat.mjs');
const fixturesDir = join(root, 'test/integration/fixtures');
const fixtureCli = join(fixturesDir, 'serve-cli.mjs');

async function startServeHttp() {
  const bearerToken = `soak-test-${Date.now()}`;
  const child = spawn(
    'node',
    [hostBin, 'serve', '--http', '0', '--no-auth', `node=${fixtureCli}`],
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

describe('serve: soak test (500 sequential calls)', { timeout: 120_000 }, () => {
  let server;

  before(async () => {
    server = await startServeHttp();
  });

  after(() => {
    server?.child.kill('SIGTERM');
  });

  it('RSS stays within bound over 500 calls', async () => {
    const CALLS = 500;
    const MAX_RSS_MB = 150;

    for (let i = 0; i < CALLS; i++) {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: i + 1,
        method: 'tools/call',
        params: {
          name: 'node_echo',
          arguments: { text: `soak iteration ${i}` },
        },
      });

      const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          connection: 'close',
        },
        body,
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.ok(json.result);
      assert.ok(!json.result.isError);
    }

    const rss = process.memoryUsage().rss / (1024 * 1024);
    assert.ok(rss < MAX_RSS_MB, `RSS ${rss.toFixed(1)} MB exceeds ${MAX_RSS_MB} MB limit`);
  });
});
