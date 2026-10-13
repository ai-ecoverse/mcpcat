import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const hostBin = join(root, 'dist/host/mcpcat.mjs');
const fixturesDir = join(root, 'test/integration/fixtures');

async function startProxy(target) {
  const child = spawn('node', [hostBin, 'serve', '--proxy', target, '--http', '0', '--json'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });

  const port = await new Promise((resolve, reject) => {
    let stdoutData = '';
    child.stdout.on('data', (chunk) => {
      stdoutData += chunk.toString();
      const nlIdx = stdoutData.indexOf('\n');
      if (nlIdx >= 0) {
        try {
          const parsed = JSON.parse(stdoutData.slice(0, nlIdx));
          const match = parsed.url.match(/:(\d+)\//);
          if (match) resolve(Number(match[1]));
        } catch (e) {
          reject(e);
        }
      }
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (!stdoutData.includes('\n')) reject(new Error(`Proxy exited ${code}`));
    });
  });

  return { child, port };
}

describe('proxy: soak test (500 sequential calls)', { timeout: 120_000 }, () => {
  let proxy;

  before(async () => {
    const fixture = join(fixturesDir, 'server-stdio-legacy.mjs');
    proxy = await startProxy(`stdio:node ${fixture}`);
  });

  after(() => {
    proxy?.child.kill('SIGTERM');
  });

  it('RSS stays within bound over 500 calls through proxy', async () => {
    const CALLS = 500;
    const MAX_RSS_MB = 150;

    for (let i = 0; i < CALLS; i++) {
      const body = JSON.stringify({
        jsonrpc: '2.0',
        id: i + 1,
        method: 'tools/call',
        params: {
          name: 'echo',
          arguments: { message: `soak iteration ${i}` },
        },
      });

      const res = await fetch(`http://127.0.0.1:${proxy.port}/mcp`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          connection: 'close',
        },
        body,
      });
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.ok(json.result);
    }

    const rss = process.memoryUsage().rss / (1024 * 1024);
    assert.ok(rss < MAX_RSS_MB, `RSS ${rss.toFixed(1)} MB exceeds ${MAX_RSS_MB} MB limit`);
  });
});
