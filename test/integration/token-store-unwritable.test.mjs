import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const hostBin = join(root, 'dist/host/mcpcat.mjs');
const fixturesDir = join(root, 'test/integration/fixtures');
const DIR = '/dev/null/agent';

async function startServer(script, args = []) {
  const child = spawn('node', [join(fixturesDir, script), ...args], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const info = await new Promise((resolve, reject) => {
    child.stdout.once('data', (chunk) => resolve(JSON.parse(chunk.toString())));
    child.on('error', reject);
  });
  return { child, ...info };
}

describe('host: a config directory mcpcat cannot create', {
  skip: process.getuid?.() === 0 && 'root could chmod /dev/null',
}, () => {
  let as;
  let mcp;
  let url;
  const mcpcat = (...args) =>
    spawnSync('node', [hostBin, ...args], {
      encoding: 'utf8',
      timeout: 15_000,
      input: '',
      env: { ...process.env, NODE_NO_WARNINGS: '1', PI_CODING_AGENT_DIR: DIR },
    });

  before(async () => {
    as = await startServer('oauth-as.mjs');
    mcp = await startServer('server-oauth-protected.mjs', [as.issuer]);
    url = `http://127.0.0.1:${mcp.port}/mcp`;
  });

  after(() => {
    as?.child.kill('SIGTERM');
    mcp?.child.kill('SIGTERM');
  });

  it('a request gets to the 401 and exits 4', () => {
    const { status, stderr } = mcpcat('info', url);
    assert.equal(status, 4, stderr);
    assert.ok(stderr.includes('mcpcat login'), stderr);
    assert.ok(!stderr.includes('could not write'), stderr);
  });

  it('login has to write, so it exits 2 before any sign-in starts', () => {
    const { status, stderr } = mcpcat('login', url, '--no-browser');
    assert.equal(status, 2, stderr);
    assert.ok(stderr.includes(`could not write ${DIR}/mcp-auth.json.lock`), stderr);
    assert.ok(!stderr.includes('/authorize'), stderr);
  });

  it('add has to write, so it exits 2 and names the path', () => {
    const { status, stderr } = mcpcat('add', 'x', url);
    assert.equal(status, 2, stderr);
    assert.ok(stderr.includes(`could not write ${DIR}/mcp.json.lock`), stderr);
  });
});
