import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { attachKernel, createNodeKernel, nodeTransport } from './helpers/kernel.mjs';
import { fixtures, homeEnv, root, run } from './helpers/rows.mjs';
import { waitUntil } from './helpers/wait.mjs';

const CLIENT_ID = 'mcpcat-retry-id';
const AGENT_DIR = '/home/agent/.pi/agent';

function seed() {
  return { refreshToken: randomBytes(24).toString('hex'), clientId: CLIENT_ID, ttl: 300 };
}

function staleState(href, s) {
  return {
    [String(new URL(href))]: {
      serverUrl: href,
      clientInformation: { client_id: CLIENT_ID, redirect_uris: ['http://127.0.0.1/callback'] },
      tokens: {
        access_token: randomBytes(24).toString('hex'),
        token_type: 'Bearer',
        expires_in: 3600,
        refresh_token: s.refreshToken,
      },
      tokensExpireAt: Date.now() + 3_600_000,
    },
  };
}

function assertRetried(log) {
  assert.ok(log.includes('token refresh_token'), `AS log: ${log}`);
  assert.ok(!log.includes('reused id'), `AS log: ${log}`);
}

describe('a request retried after a 401 gets a fresh JSON-RPC id (host)', () => {
  let dir;
  let child;
  let stderr = '';

  after(() => {
    child?.kill('SIGTERM');
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('refreshes and retries with a new id', async () => {
    dir = mkdtempSync(join(tmpdir(), 'mcpcat-retry-id-'));
    const s = seed();
    writeFileSync(join(dir, 'seed.json'), JSON.stringify(s));
    child = spawn(process.execPath, [join(fixtures, 'oauth-as-host.mjs'), join(dir, 'seed.json')], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    const port = await new Promise((resolve, reject) => {
      let data = '';
      child.stdout.on('data', (c) => {
        data += c;
        const nl = data.indexOf('\n');
        if (nl >= 0) resolve(JSON.parse(data.slice(0, nl)).port);
      });
      child.on('exit', (code) => reject(new Error(`AS exited ${code}`)));
    });
    const href = `http://127.0.0.1:${port}/mcp`;
    const agent = join(dir, 'agent');
    mkdirSync(agent, { recursive: true });
    writeFileSync(join(agent, 'mcp-auth.json'), JSON.stringify(staleState(href, s)), {
      mode: 0o600,
    });
    const r = run(['call', href, 'echo', '-d', '{"message":"retried"}'], {
      env: homeEnv(dir, { PI_CODING_AGENT_DIR: agent }),
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}; AS: ${stderr}`);
    assert.match(r.stdout, /retried/);
    await waitUntil(() => stderr.includes('token '), 'AS log');
    assertRetried(stderr);
  });
});

describe('a request retried after a 401 gets a fresh JSON-RPC id (kernel)', () => {
  let kernel;
  let client;
  let as;

  before(async () => {
    kernel = await createNodeKernel({ network: { transport: nodeTransport({}) } });
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    const install = async (name, command, module, data) => {
      await kernel.writeFile(`/node_modules/${name}/${module}`, data);
      await kernel.writeFile(
        `/node_modules/${name}/package.json`,
        JSON.stringify({
          name,
          version: pkg.version,
          type: 'module',
          slicc: { commands: { [command]: { abi: 'js', module } } },
        })
      );
    };
    await install(
      '@ai-ecoverse/mcpcat',
      'mcpcat',
      'dist/kernel/mcpcat.mjs',
      readFileSync(join(root, 'dist/kernel/mcpcat.mjs'))
    );
    await install(
      '@ai-ecoverse/mcpcat-test-retry-as',
      'retry-as',
      'dist/as.mjs',
      readFileSync(join(fixtures, 'kernel-oauth-as.mjs'))
    );
    client = await attachKernel(await kernel.connect());
  });

  after(async () => {
    if (as) {
      const sp = await as.spawned;
      sp.signal('SIGTERM');
      await sp.exited.catch(() => undefined);
    }
    client?.close();
    kernel?.terminate();
  });

  it('refreshes and retries with a new id', async () => {
    const s = seed();
    await kernel.writeFile('/tmp/retry-seed.json', JSON.stringify(s));
    const dec = new TextDecoder();
    let out = '';
    let log = '';
    let resolvePort;
    const port = new Promise((resolve) => {
      resolvePort = resolve;
    });
    as = {
      spawned: client.spawn(['retry-as', '/tmp/retry-seed.json'], {
        stdin: 'pipe',
        onStdout(chunk) {
          out += dec.decode(chunk, { stream: true });
          const nl = out.indexOf('\n');
          if (nl >= 0) resolvePort(JSON.parse(out.slice(0, nl)).port);
        },
        onStderr(chunk) {
          log += dec.decode(chunk, { stream: true });
        },
      }),
    };
    const href = `http://127.0.0.1:${await port}/mcp`;
    await kernel.writeFile(`${AGENT_DIR}/mcp-auth.json`, JSON.stringify(staleState(href, s)));
    const r = await kernel.run(['mcpcat', 'call', href, 'echo', '-d', '{"message":"retried"}'], {
      stdout: 'pipe',
      stderr: 'pipe',
      env: { PI_CODING_AGENT_DIR: AGENT_DIR },
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}; AS: ${log}`);
    assert.match(r.stdout, /retried/);
    assertRetried(log);
  });
});
