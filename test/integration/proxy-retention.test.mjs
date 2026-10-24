import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { isStandalone, mcpcatBin } from './helpers/bin.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const upstream = `stdio:node ${join(here, 'fixtures/server-stdio-legacy.mjs')}`;
const REQUESTS = 100_000;

describe('serve --proxy to a legacy upstream', { skip: isStandalone }, () => {
  let home;

  before(() => {
    home = mkdtempSync(join(tmpdir(), 'mcpcat-proxy-retention-'));
  });

  after(() => rmSync(home, { recursive: true, force: true }));

  it(`forwards ${REQUESTS} requests within a 24 MiB heap`, { timeout: 180_000 }, async () => {
    const child = spawn(
      process.execPath,
      ['--max-old-space-size=24', mcpcatBin, 'serve', '--proxy', upstream, '--stdio'],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          NODE_NO_WARNINGS: '1',
          HOME: home,
          PI_CODING_AGENT_DIR: join(home, 'agent'),
        },
      }
    );
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.stdin.on('error', () => {});
    let answered = 0;
    let tail = '';
    child.stdout.on('data', (d) => {
      const text = tail + d.toString();
      const lines = text.split('\n');
      tail = lines.pop();
      for (const line of lines) if (line.includes('"result"')) answered += 1;
    });
    const exited = new Promise((resolve) => child.on('exit', resolve));
    const write = (msg) =>
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...msg })}\n`)
        ? Promise.resolve()
        : Promise.race([new Promise((resolve) => child.stdin.once('drain', resolve)), exited]);
    await write({
      id: 0,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'test', version: '1' },
      },
    });
    for (let i = 1; i <= REQUESTS && child.exitCode === null; i++) {
      await write({ id: i, method: 'tools/list', params: {} });
    }
    child.stdin.end();
    const code = await exited;
    assert.ok(!stderr.includes('heap'), stderr.slice(-1500));
    assert.equal(answered, REQUESTS + 1, `exit ${code}: ${stderr.slice(-1500)}`);
  });
});
