import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mcpcatArgs } from './helpers/bin.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const alphaServer = join(root, 'test/integration/fixtures/server-codemode-alpha.mjs');
const fixturesDir = join(root, 'test/integration/fixtures');
const hostBin = join(root, 'dist/host/mcpcat.mjs');

function createTmpDir() {
  const dir = join(tmpdir(), `mcpcat-fix-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function runCode(script, opts = {}) {
  const tmpDir = opts.tmpDir || createTmpDir();
  const agentDir = opts.agentDir || join(tmpDir, '.pi', 'agent');
  const stateDir = opts.stateDir || join(tmpDir, 'state');
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  const configPath = join(agentDir, 'mcp.json');
  if (!existsSync(configPath)) {
    writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { alpha: { command: 'node', args: [alphaServer] } } }, null, 2)
    );
  }
  const env = {
    ...process.env,
    NODE_NO_WARNINGS: '1',
    PI_CODING_AGENT_DIR: agentDir,
    XDG_STATE_HOME: stateDir,
    HOME: tmpDir,
  };
  const extraArgs = opts.extraArgs || [];
  const { cmd, args } = mcpcatArgs(['code', '--json', '-s', 'alpha', ...extraArgs, '-e', script]);
  try {
    const result = execFileSync(cmd, args, {
      encoding: 'utf8',
      timeout: 30_000,
      env,
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

describe('codemode: memory limit', () => {
  it('script that allocates without bound fails with exit 1', () => {
    const script = `
      const arrays = [];
      for (let i = 0; i < 100000; i++) {
        arrays.push(new Array(100000).fill(i));
      }
      return arrays.length;
    `;
    const result = runCode(script);
    assert.notEqual(result.status, 0, 'should fail');
    assert.ok(
      result.status === 1 || result.status === 124,
      `exit should be 1 or 124, got ${result.status}`
    );
    assert.ok(
      result.stderr.includes('memory') ||
        result.stderr.includes('out of memory') ||
        result.stdout.includes('memory') ||
        result.stdout.includes('out of memory'),
      `should mention memory: stderr=${result.stderr}, stdout=${result.stdout.slice(0, 200)}`
    );
  });

  it('normal scripts work within default memory limit', () => {
    const script = 'return 42;';
    const result = runCode(script);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    const parsed = JSON.parse(result.stdout);
    assert.ok(parsed.ok);
    assert.equal(parsed.value, 42);
  });

  it('--memory flag is accepted', () => {
    const script = 'return 1;';
    const result = runCode(script, { extraArgs: ['--memory', '128'] });
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  });
});

describe('codemode: script cannot extend deadline', () => {
  it('script timeout_ms cannot exceed -m', () => {
    const script = `// @options: {"timeout_ms": 300000}
while(true){}`;
    const result = runCode(script, { extraArgs: ['-m', '1'] });
    assert.equal(result.status, 124, `should timeout with exit 124, got ${result.status}`);
  });

  it('script timeout_ms can shorten -m', () => {
    const script = `// @options: {"timeout_ms": 500}
while(true){}`;
    const result = runCode(script, { extraArgs: ['-m', '300'] });
    assert.equal(result.status, 124, `should timeout with exit 124, got ${result.status}`);
  });
});

describe('discovery: same-origin and private target guard', () => {
  let publicServer;
  let canaryServer;
  let canaryHit;
  let publicUrl;

  before(async () => {
    canaryHit = false;
    canaryServer = await new Promise((resolve) => {
      const srv = createServer((req, res) => {
        canaryHit = true;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ entries: [] }));
      });
      srv.listen(0, '127.0.0.1', () => resolve(srv));
    });

    const canaryPort = canaryServer.address().port;

    publicServer = await new Promise((resolve) => {
      const srv = createServer((req, res) => {
        if (req.url === '/') {
          res.writeHead(200, {
            'Content-Type': 'text/html',
            Link: `<http://127.0.0.1:${canaryPort}/evil>; rel="ard"`,
          });
          res.end('<html></html>');
        } else if (
          req.url === '/.well-known/ard.json' ||
          req.url === '/.well-known/ai-catalog.json'
        ) {
          res.writeHead(404);
          res.end();
        } else if (req.method === 'POST') {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('not found');
        } else {
          res.writeHead(404);
          res.end();
        }
      });
      srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
    publicUrl = `http://127.0.0.1:${publicServer.address().port}`;
  });

  after(() => {
    publicServer?.close();
    canaryServer?.close();
  });

  it('cross-origin Link target is skipped and canary is not hit', async () => {
    const { cmd, args: cmdArgs } = mcpcatArgs(['discover', '--json', publicUrl]);
    const result = await new Promise((resolve) => {
      let stdout = '';
      let stderr = '';
      const child = spawn(cmd, cmdArgs, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, NODE_NO_WARNINGS: '1' },
      });
      child.stdout.on('data', (d) => {
        stdout += d;
      });
      child.stderr.on('data', (d) => {
        stderr += d;
      });
      child.on('exit', (code) => resolve({ stdout, stderr, status: code }));
    });
    await new Promise((r) => setTimeout(r, 200));
    assert.ok(!canaryHit, 'canary server should not have been hit');
  });
});

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('host: SIGTERM kills tree and exits 143', () => {
  const slowGrandchild = join(fixturesDir, 'server-slow-grandchild.mjs');

  it('SIGTERM kills server and grandchild, exits code 143 signal null', async () => {
    const pidFile = join(
      tmpdir(),
      `mcpcat-gc-term-${Date.now()}-${Math.random().toString(36).slice(2)}.pid`
    );
    const child = spawn(
      'node',
      [hostBin, 'call', `stdio:node ${slowGrandchild} ${pidFile}`, 'slow', '-d', '{"ms":60000}'],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, NODE_NO_WARNINGS: '1' },
      }
    );

    await new Promise((resolve) => {
      const check = () => {
        if (existsSync(pidFile)) resolve();
        else setTimeout(check, 30);
      };
      check();
      setTimeout(resolve, 5000);
    });

    const pids = existsSync(pidFile)
      ? readFileSync(pidFile, 'utf8').trim().split('\n').map(Number)
      : [];

    child.kill('SIGTERM');

    const { code: exitCode, signal } = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ code: -1, signal: 'timeout' }), 10000);
      child.on('exit', (code, sig) => {
        clearTimeout(timer);
        resolve({ code, signal: sig });
      });
    });

    assert.equal(signal, null, `should exit via code, not signal (signal=${signal})`);
    assert.equal(exitCode, 143, `expected exit 143, got ${exitCode}`);

    await new Promise((r) => setTimeout(r, 1000));

    for (const pid of pids) {
      assert.ok(!pidAlive(pid), `pid ${pid} should be dead after SIGTERM`);
    }

    try {
      rmSync(pidFile, { force: true });
    } catch {}
  });

  it('SIGHUP kills server and grandchild, exits code 129 signal null', async () => {
    const pidFile = join(
      tmpdir(),
      `mcpcat-gc-hup-${Date.now()}-${Math.random().toString(36).slice(2)}.pid`
    );
    const child = spawn(
      'node',
      [hostBin, 'call', `stdio:node ${slowGrandchild} ${pidFile}`, 'slow', '-d', '{"ms":60000}'],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, NODE_NO_WARNINGS: '1' },
      }
    );

    await new Promise((resolve) => {
      const check = () => {
        if (existsSync(pidFile)) resolve();
        else setTimeout(check, 30);
      };
      check();
      setTimeout(resolve, 5000);
    });

    const pids = existsSync(pidFile)
      ? readFileSync(pidFile, 'utf8').trim().split('\n').map(Number)
      : [];

    child.kill('SIGHUP');

    const { code: exitCode, signal } = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve({ code: -1, signal: 'timeout' }), 10000);
      child.on('exit', (code, sig) => {
        clearTimeout(timer);
        resolve({ code, signal: sig });
      });
    });

    assert.equal(signal, null, `should exit via code, not signal (signal=${signal})`);
    assert.equal(exitCode, 129, `expected exit 129, got ${exitCode}`);

    await new Promise((r) => setTimeout(r, 1000));

    for (const pid of pids) {
      assert.ok(!pidAlive(pid), `pid ${pid} should be dead after SIGHUP`);
    }

    try {
      rmSync(pidFile, { force: true });
    } catch {}
  });
});

describe('config: EACCES reports path and exits 2', () => {
  let tmpDir;
  let configPath;

  before(() => {
    tmpDir = createTmpDir();
    const agentDir = join(tmpDir, '.pi', 'agent');
    mkdirSync(agentDir, { recursive: true });
    configPath = join(agentDir, 'mcp.json');
    writeFileSync(configPath, '{"mcpServers":{"a":{"url":"http://x.test/mcp"}}}');
    chmodSync(configPath, 0o000);
  });

  after(() => {
    try {
      chmodSync(configPath, 0o644);
    } catch {}
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('EACCES error mentions path and exits 2', () => {
    const { cmd, args } = mcpcatArgs(['list']);
    let result;
    try {
      result = {
        stdout: execFileSync(cmd, args, {
          encoding: 'utf8',
          timeout: 10_000,
          env: {
            ...process.env,
            NODE_NO_WARNINGS: '1',
            PI_CODING_AGENT_DIR: join(tmpDir, '.pi', 'agent'),
            HOME: tmpDir,
          },
        }),
        stderr: '',
        status: 0,
      };
    } catch (err) {
      result = {
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? '',
        status: err.status ?? 1,
      };
    }
    assert.equal(
      result.status,
      2,
      `expected exit 2, got ${result.status}; stderr: ${result.stderr}`
    );
    assert.ok(
      result.stderr.includes('permission denied') || result.stderr.includes('EACCES'),
      `stderr should mention permission: ${result.stderr}`
    );
    assert.ok(
      result.stderr.includes('mcp.json'),
      `stderr should mention the path: ${result.stderr}`
    );
  });
});
