import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const hostBin = join(root, 'dist/host/mcpcat.mjs');
const fixturesDir = join(root, 'test/integration/fixtures');

function runHost(args, opts = {}) {
  const r = spawnSync('node', [hostBin, ...args], {
    encoding: 'utf8',
    timeout: 15_000,
    env: { ...process.env, NODE_NO_WARNINGS: '1', ...opts.env },
  });
  return { stdout: r.stdout ?? '', stderr: r.stderr ?? '', status: r.status ?? 1 };
}

async function startFixtureServer(script) {
  const child = spawn('node', [join(fixturesDir, script)], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NODE_NO_WARNINGS: '1' },
  });
  const info = await new Promise((resolve, reject) => {
    let data = '';
    child.stdout.on('data', (chunk) => {
      data += chunk.toString();
      if (data.includes('\n')) {
        try {
          resolve(JSON.parse(data.trim()));
        } catch (e) {
          reject(e);
        }
      }
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (!data.includes('\n')) reject(new Error(`Server exited ${code}: ${data}`));
    });
  });
  return { child, ...info };
}

describe('B5-delta: call with no args checks required', () => {
  let server;
  let url;
  before(async () => {
    server = await startFixtureServer('server-2026-http.mjs');
    url = `http://127.0.0.1:${server.port}`;
  });
  after(() => {
    server?.child.kill('SIGTERM');
  });

  it('call with required tool and no args exits 2', () => {
    const { stderr, status } = runHost(['call', url, 'weather']);
    assert.equal(status, 2);
    assert.ok(stderr.includes('--city'), `expected --city in stderr: ${stderr}`);
  });

  it('call with required tool and -d skips check', () => {
    const { stdout, status } = runHost(['call', url, 'weather', '-d', '{"city":"NYC"}']);
    assert.equal(status, 0);
    assert.ok(stdout.includes('NYC'));
  });

  it('call tool with no required params and no args succeeds', () => {
    const { status } = runHost(['call', url, 'fail']);
    assert.equal(status, 1);
  });
});

describe('B5-delta: THIRD_PARTY_NOTICES complete', () => {
  it('has text for every bundled package', () => {
    const content = readFileSync(join(root, 'dist/THIRD_PARTY_NOTICES'), 'utf8');
    assert.ok(!content.includes('(license text not found)'), 'no missing license text');
  });

  it('includes QuickJS (Bellard/Gordon)', () => {
    const content = readFileSync(join(root, 'dist/THIRD_PARTY_NOTICES'), 'utf8');
    assert.ok(content.includes('QuickJS'), 'QuickJS entry');
    assert.ok(content.includes('Fabrice Bellard'), 'Bellard copyright');
    assert.ok(content.includes('Charlie Gordon'), 'Gordon copyright');
  });

  it('includes pi-codemode with correct copyright', () => {
    const content = readFileSync(join(root, 'dist/THIRD_PARTY_NOTICES'), 'utf8');
    assert.ok(content.includes('pi-codemode'));
    const idx = content.indexOf('pi-codemode');
    const section = content.slice(idx, idx + 800);
    assert.ok(section.includes('MIT'), 'pi-codemode has MIT');
    assert.ok(section.includes('Mario Zechner'), 'pi-codemode has correct copyright');
  });

  it('includes pi-mcp with copyright', () => {
    const content = readFileSync(join(root, 'dist/THIRD_PARTY_NOTICES'), 'utf8');
    assert.ok(content.includes('pi-mcp'));
    const idx = content.indexOf('pi-mcp');
    const section = content.slice(idx, idx + 500);
    assert.ok(section.includes('MIT') || section.includes('Permission'), 'pi-mcp has license');
  });

  it('includes quickjs-wasi', () => {
    const content = readFileSync(join(root, 'dist/THIRD_PARTY_NOTICES'), 'utf8');
    assert.ok(content.includes('quickjs-wasi'));
  });
});

describe('B5-delta: kernel input_required without TTY exits 6', () => {
  let server;
  let url;
  before(async () => {
    server = await startFixtureServer('server-2026-http.mjs');
    url = `http://127.0.0.1:${server.port}`;
  });
  after(() => {
    server?.child.kill('SIGTERM');
  });

  it('input_required without TTY exits 6 with request on stderr', () => {
    const { stderr, status } = runHost(['call', url, 'needs-input', '-d', '{}'], {
      env: { FORCE_NO_TTY: '1' },
    });
    assert.equal(status, 6);
    assert.ok(stderr.includes('input_required') || stderr.includes('needs-input'));
  });
});
