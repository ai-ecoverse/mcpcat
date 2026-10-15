import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { execFileSync as exec, spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { mcpcatArgs } from './helpers/bin.mjs';
import {
  attachKernel,
  createNodeKernel,
  hasPgid,
  hostUrl,
  nodeTransport,
} from './helpers/kernel.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const kernelBundle = join(root, 'dist/kernel/mcpcat.mjs');
const fixturesDir = join(root, 'test/integration/fixtures');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

async function startFixtureServer(script, extraArgs = []) {
  const child = spawn('node', [join(fixturesDir, script), ...extraArgs], {
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

async function installMcpcat(kernel) {
  const bundleData = readFileSync(kernelBundle);
  await kernel.writeFile('/node_modules/@ai-ecoverse/mcpcat/dist/kernel/mcpcat.mjs', bundleData);
  await kernel.writeFile(
    '/node_modules/@ai-ecoverse/mcpcat/package.json',
    JSON.stringify({
      name: '@ai-ecoverse/mcpcat',
      version: pkg.version,
      type: 'module',
      slicc: {
        commands: {
          mcpcat: {
            abi: 'js',
            module: 'dist/kernel/mcpcat.mjs',
          },
        },
      },
    })
  );
}

async function installStdioFixture(kernel) {
  const fixtureData = readFileSync(join(fixturesDir, 'kernel-stdio-server.mjs'));
  await kernel.writeFile(
    '/node_modules/@ai-ecoverse/mcpcat-test-stdio/dist/server.mjs',
    fixtureData
  );
  await kernel.writeFile(
    '/node_modules/@ai-ecoverse/mcpcat-test-stdio/package.json',
    JSON.stringify({
      name: '@ai-ecoverse/mcpcat-test-stdio',
      version: '1.0.0',
      type: 'module',
      slicc: {
        commands: {
          'mcpcat-test-stdio': {
            abi: 'js',
            module: 'dist/server.mjs',
          },
        },
      },
    })
  );
}

async function installGrandchildFixtures(kernel) {
  const gcData = readFileSync(join(fixturesDir, 'kernel-stdio-grandchild.mjs'));
  await kernel.writeFile('/node_modules/@ai-ecoverse/mcpcat-test-gc/dist/server.mjs', gcData);
  await kernel.writeFile(
    '/node_modules/@ai-ecoverse/mcpcat-test-gc/package.json',
    JSON.stringify({
      name: '@ai-ecoverse/mcpcat-test-gc',
      version: '1.0.0',
      type: 'module',
      slicc: {
        commands: {
          'mcpcat-test-gc': {
            abi: 'js',
            module: 'dist/server.mjs',
          },
        },
      },
    })
  );

  const sleeperData = readFileSync(join(fixturesDir, 'kernel-sleeper.mjs'));
  await kernel.writeFile(
    '/node_modules/@ai-ecoverse/mcpcat-test-sleeper/dist/main.mjs',
    sleeperData
  );
  await kernel.writeFile(
    '/node_modules/@ai-ecoverse/mcpcat-test-sleeper/package.json',
    JSON.stringify({
      name: '@ai-ecoverse/mcpcat-test-sleeper',
      version: '1.0.0',
      type: 'module',
      slicc: {
        commands: {
          'mcpcat-test-sleeper': {
            abi: 'js',
            module: 'dist/main.mjs',
          },
        },
      },
    })
  );
}

describe('kernel: mcpcat', () => {
  let kernel;

  before(async () => {
    kernel = await createNodeKernel({});
    await installMcpcat(kernel);
  });

  after(() => {
    kernel?.terminate();
  });

  it('--version prints the package.json version', async () => {
    const { status, stdout } = await kernel.run(['mcpcat', '--version'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assert.equal(status, 0);
    assert.equal(stdout.trim(), pkg.version);
  });

  it('-V prints the version', async () => {
    const { status, stdout } = await kernel.run(['mcpcat', '-V'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assert.equal(status, 0);
    assert.equal(stdout.trim(), pkg.version);
  });

  it('--help prints help text', async () => {
    const { status, stdout } = await kernel.run(['mcpcat', '--help'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assert.equal(status, 0);
    assert.ok(stdout.includes('mcpcat'));
    assert.ok(stdout.includes('Usage:'));
  });

  it('unknown command exits 2', async () => {
    const { status, stderr } = await kernel.run(['mcpcat', 'bogus'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assert.equal(status, 2);
    assert.ok(stderr.includes('unknown target'));
  });

  it('--version output matches host', async () => {
    const { cmd, args } = mcpcatArgs(['--version']);
    const hostOut = exec(cmd, args, {
      encoding: 'utf8',
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    }).trim();

    const { stdout } = await kernel.run(['mcpcat', '--version'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    assert.equal(stdout.trim(), hostOut);
  });

  it('--help output matches host', async () => {
    const { cmd: helpCmd, args: helpArgs } = mcpcatArgs(['--help']);
    const hostOut = exec(helpCmd, helpArgs, {
      encoding: 'utf8',
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    }).trim();

    const { stdout } = await kernel.run(['mcpcat', '--help'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });

    assert.equal(stdout.trim(), hostOut);
  });
});

describe('kernel: HTTP client via transport', () => {
  let kernel;
  let server;

  before(async () => {
    server = await startFixtureServer('server-2026-http.mjs');
    kernel = await createNodeKernel({
      network: { transport: nodeTransport({ hostLoopback: true }) },
    });
    await installMcpcat(kernel);
  });

  after(() => {
    server?.child.kill('SIGTERM');
    kernel?.terminate();
  });

  it('info shows server details', async () => {
    const url = hostUrl(server.port);
    const { status, stdout, stderr } = await kernel.run(['mcpcat', 'info', url], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assert.equal(status, 0, `stderr: ${stderr}`);
    assert.ok(stdout.includes('test-2026'));
    assert.ok(stdout.includes('2026-07-28'));
  });

  it('tools lists tools', async () => {
    const url = hostUrl(server.port);
    const { status, stdout, stderr } = await kernel.run(['mcpcat', 'tools', url], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assert.equal(status, 0, `stderr: ${stderr}`);
    assert.ok(stdout.includes('echo'));
    assert.ok(stdout.includes('add'));
  });

  it('call invokes a tool', async () => {
    const url = hostUrl(server.port);
    const { status, stdout, stderr } = await kernel.run(
      ['mcpcat', 'call', url, 'echo', '-d', '{"message":"kernel hello"}'],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    assert.equal(status, 0, `stderr: ${stderr}`);
    assert.ok(stdout.includes('kernel hello'));
  });

  it('call with add tool', async () => {
    const url = hostUrl(server.port);
    const { status, stdout, stderr } = await kernel.run(
      ['mcpcat', 'call', url, 'add', '-d', '{"a":10,"b":20}'],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    assert.equal(status, 0, `stderr: ${stderr}`);
    assert.ok(stdout.includes('30'));
  });

  it('describe shows tool schema', async () => {
    const url = hostUrl(server.port);
    const { status, stdout, stderr } = await kernel.run(['mcpcat', 'describe', url, 'echo'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assert.equal(status, 0, `stderr: ${stderr}`);
    assert.ok(stdout.includes('echo'));
    assert.ok(stdout.includes('message'));
  });

  it('input_required exits 6 without prompting in kernel', async () => {
    const url = hostUrl(server.port);
    const { status, stdout, stderr } = await kernel.run(
      ['mcpcat', 'call', url, 'needs-input', '-d', '{}'],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    assert.equal(status, 6, `expected exit 6, got ${status}; stderr: ${stderr}`);
    assert.ok(!stderr.includes('answer:'), 'stderr must not contain interactive prompt');
    assert.ok(
      stderr.includes('input_required') || stderr.includes('needs-input'),
      'stderr should contain request JSON'
    );
  });
});

describe('kernel: legacy HTTP via transport', () => {
  let kernel;
  let server;

  before(async () => {
    server = await startFixtureServer('server-legacy-http.mjs');
    kernel = await createNodeKernel({
      network: { transport: nodeTransport({ hostLoopback: true }) },
    });
    await installMcpcat(kernel);
  });

  after(() => {
    server?.child.kill('SIGTERM');
    kernel?.terminate();
  });

  it('info shows server details via fallback', async () => {
    const url = hostUrl(server.port);
    const { status, stdout, stderr } = await kernel.run(['mcpcat', 'info', url], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assert.equal(status, 0, `stderr: ${stderr}`);
    assert.ok(stdout.includes('test-legacy'));
    assert.ok(stdout.includes('2025-11-25'));
  });

  it('tools lists tools', async () => {
    const url = hostUrl(server.port);
    const { status, stdout, stderr } = await kernel.run(['mcpcat', 'tools', url], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assert.equal(status, 0, `stderr: ${stderr}`);
    assert.ok(stdout.includes('echo'));
    assert.ok(stdout.includes('add'));
  });

  it('call invokes a tool', async () => {
    const url = hostUrl(server.port);
    const { status, stdout, stderr } = await kernel.run(
      ['mcpcat', 'call', url, 'echo', '-d', '{"message":"legacy kernel hello"}'],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    assert.equal(status, 0, `stderr: ${stderr}`);
    assert.ok(stdout.includes('legacy kernel hello'));
  });
});

describe('kernel: legacy HTTP SSE via transport', () => {
  let kernel;
  let server;

  before(async () => {
    server = await startFixtureServer('server-legacy-http.mjs', ['--sse']);
    kernel = await createNodeKernel({
      network: { transport: nodeTransport({ hostLoopback: true }) },
    });
    await installMcpcat(kernel);
  });

  after(() => {
    server?.child.kill('SIGTERM');
    kernel?.terminate();
  });

  it('info works over SSE', async () => {
    const url = hostUrl(server.port);
    const { status, stdout, stderr } = await kernel.run(['mcpcat', 'info', url], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assert.equal(status, 0, `stderr: ${stderr}`);
    assert.ok(stdout.includes('test-legacy'));
  });

  it('call works over SSE', async () => {
    const url = hostUrl(server.port);
    const { status, stdout, stderr } = await kernel.run(
      ['mcpcat', 'call', url, 'echo', '-d', '{"message":"sse kernel hello"}'],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    assert.equal(status, 0, `stderr: ${stderr}`);
    assert.ok(stdout.includes('sse kernel hello'));
  });
});

describe('kernel: stdio client', () => {
  let kernel;

  before(async () => {
    kernel = await createNodeKernel({});
    await installMcpcat(kernel);
    await installStdioFixture(kernel);
  });

  after(() => {
    kernel?.terminate();
  });

  it('info via stdio: prefix', async () => {
    const { status, stdout, stderr } = await kernel.run(
      ['mcpcat', 'info', 'stdio:mcpcat-test-stdio'],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    assert.equal(status, 0, `stderr: ${stderr}`);
    assert.ok(stdout.includes('test-kernel-stdio'));
  });

  it('tools via trailing --', async () => {
    const { status, stdout, stderr } = await kernel.run(
      ['mcpcat', 'tools', '--', 'mcpcat-test-stdio'],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    assert.equal(status, 0, `stderr: ${stderr}`);
    assert.ok(stdout.includes('echo'));
    assert.ok(stdout.includes('add'));
  });

  it('call via stdio: prefix', async () => {
    const { status, stdout, stderr } = await kernel.run(
      [
        'mcpcat',
        'call',
        'stdio:mcpcat-test-stdio',
        'echo',
        '-d',
        '{"message":"kernel stdio test"}',
      ],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    assert.equal(status, 0, `stderr: ${stderr}`);
    assert.ok(stdout.includes('kernel stdio test'));
  });

  it('call add via stdio', async () => {
    const { status, stdout, stderr } = await kernel.run(
      ['mcpcat', 'call', 'stdio:mcpcat-test-stdio', 'add', '-d', '{"a":5,"b":7}'],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    assert.equal(status, 0, `stderr: ${stderr}`);
    assert.ok(stdout.includes('12'));
  });
});

describe('kernel: stdio process group cleanup', {
  skip: !hasPgid && 'pgid requires slicc-kernel >= 1.74.0',
}, () => {
  let kernel;
  let client;

  before(async () => {
    kernel = await createNodeKernel({});
    await installMcpcat(kernel);
    await installGrandchildFixtures(kernel);
    const port = await kernel.connect();
    client = await attachKernel(port);
  });

  after(() => {
    client?.close();
    kernel?.terminate();
  });

  it('server and grandchild are gone when mcpcat exits', async () => {
    const pidsResult = await kernel.run(
      ['mcpcat', 'call', 'stdio:mcpcat-test-gc', 'pids', '-d', '{}'],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    assert.equal(pidsResult.status, 0, `stderr: ${pidsResult.stderr}`);
    const pids = JSON.parse(pidsResult.stdout.trim());
    const serverPid = pids.server;
    const grandchildPid = pids.grandchild;
    assert.ok(serverPid > 0, 'server pid should be positive');
    assert.ok(grandchildPid > 0, 'grandchild pid should be positive');

    const ps = await client.ps();
    const alivePids = new Set(ps.filter((p) => p.state !== 'Z').map((p) => p.pid));
    assert.ok(!alivePids.has(serverPid), `server pid ${serverPid} should be dead`);
    assert.ok(!alivePids.has(grandchildPid), `grandchild pid ${grandchildPid} should be dead`);
  });
});

describe('kernel: serve process group cleanup', {
  skip: !hasPgid && 'pgid requires slicc-kernel >= 1.74.0',
}, () => {
  let kernel;
  let client;

  before(async () => {
    kernel = await createNodeKernel({});
    await installMcpcat(kernel);

    const gcData = readFileSync(join(fixturesDir, 'kernel-serve-grandchild.mjs'));
    await kernel.writeFile('/node_modules/@ai-ecoverse/mcpcat-test-serve-gc/dist/main.mjs', gcData);
    await kernel.writeFile(
      '/node_modules/@ai-ecoverse/mcpcat-test-serve-gc/package.json',
      JSON.stringify({
        name: '@ai-ecoverse/mcpcat-test-serve-gc',
        version: '1.0.0',
        type: 'module',
        slicc: {
          commands: {
            'mcpcat-test-serve-gc': { abi: 'js', module: 'dist/main.mjs' },
          },
        },
      })
    );

    const sleeperData = readFileSync(join(fixturesDir, 'kernel-sleeper.mjs'));
    await kernel.writeFile(
      '/node_modules/@ai-ecoverse/mcpcat-test-sleeper/dist/main.mjs',
      sleeperData
    );
    await kernel.writeFile(
      '/node_modules/@ai-ecoverse/mcpcat-test-sleeper/package.json',
      JSON.stringify({
        name: '@ai-ecoverse/mcpcat-test-sleeper',
        version: '1.0.0',
        type: 'module',
        slicc: {
          commands: {
            'mcpcat-test-sleeper': { abi: 'js', module: 'dist/main.mjs' },
          },
        },
      })
    );

    const port = await kernel.connect();
    client = await attachKernel(port);
  });

  after(() => {
    client?.close();
    kernel?.terminate();
  });

  it('serve command grandchild is gone after SIGTERM', async () => {
    const sp = await client.spawn(
      ['mcpcat', 'serve', '--http', '0', '--no-auth', 'mcpcat-test-serve-gc'],
      {
        stdin: 'pipe',
        onStdout(chunk) {},
        onStderr(chunk) {},
      }
    );

    await sleep(1500);

    const psBefore = await client.ps();
    const sleepersBefore = psBefore.filter((p) =>
      p.argv.some((a) => a.includes('mcpcat-test-sleeper'))
    );
    assert.ok(sleepersBefore.length > 0, 'sleeper grandchild should be running');

    sp.signal('SIGTERM');
    await sp.exited;

    await sleep(500);

    const psAfter = await client.ps();
    const sleepersAfter = psAfter.filter((p) =>
      p.argv.some((a) => a.includes('mcpcat-test-sleeper'))
    );
    assert.equal(sleepersAfter.length, 0, 'sleeper grandchild should be dead after serve exits');
  });
});

describe('kernel: serve SIGTERM-trap escalates to SIGKILL', {
  skip: !hasPgid && 'pgid requires slicc-kernel >= 1.74.0',
}, () => {
  let kernel;
  let client;

  before(async () => {
    kernel = await createNodeKernel({});
    await installMcpcat(kernel);

    const trapData = readFileSync(join(fixturesDir, 'kernel-trap-sigterm.mjs'));
    await kernel.writeFile('/node_modules/@ai-ecoverse/mcpcat-test-trap/dist/main.mjs', trapData);
    await kernel.writeFile(
      '/node_modules/@ai-ecoverse/mcpcat-test-trap/package.json',
      JSON.stringify({
        name: '@ai-ecoverse/mcpcat-test-trap',
        version: '1.0.0',
        type: 'module',
        slicc: {
          commands: {
            'mcpcat-test-trap': { abi: 'js', module: 'dist/main.mjs' },
          },
        },
      })
    );

    const port = await kernel.connect();
    client = await attachKernel(port);
  });

  after(() => {
    client?.close();
    kernel?.terminate();
  });

  it('SIGKILL reaps a SIGTERM-trapping command', async () => {
    const sp = await client.spawn(
      ['mcpcat', 'serve', '--http', '0', '--no-auth', 'mcpcat-test-trap'],
      {
        stdin: 'pipe',
        onStdout(chunk) {},
        onStderr(chunk) {},
      }
    );

    await sleep(1500);

    const psBefore = await client.ps();
    const trapBefore = psBefore.filter((p) =>
      p.argv.some((a) => a.includes('mcpcat-test-trap') && !a.includes('--mcp'))
    );
    assert.ok(trapBefore.length > 0, 'trap process should be running');

    sp.signal('SIGTERM');
    await sp.exited;

    await sleep(500);

    const psAfter = await client.ps();
    const trapAfter = psAfter.filter((p) => p.argv.some((a) => a.includes('mcpcat-test-trap')));
    assert.equal(trapAfter.length, 0, 'trap process should be dead after SIGKILL escalation');
  });
});
describe('kernel: discover', () => {
  let kernel;
  let server;

  before(async () => {
    server = await startFixtureServer('server-2026-http.mjs');
    kernel = await createNodeKernel({
      network: { transport: nodeTransport({ hostLoopback: true }) },
    });
    await installMcpcat(kernel);
  });

  after(() => {
    server?.child.kill('SIGTERM');
    kernel?.terminate();
  });

  it('discovers MCP server via kernel fetch', async () => {
    const url = hostUrl(server.port);
    const { status, stdout, stderr } = await kernel.run(['mcpcat', 'discover', url], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assert.equal(status, 0, `stderr: ${stderr}`);
    assert.ok(stdout.includes('mcp'), 'should find MCP standard');
  });

  it('handles redirect in kernel (redirect: follow fallback)', async () => {
    const { status } = await kernel.run(['mcpcat', 'discover', 'http://127.0.0.1:1'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assert.equal(status, 0, 'should exit 0 even with unreachable URL');
  });
});

describe('kernel: login/logout exits 4 in seven', () => {
  let kernel;

  before(async () => {
    kernel = await createNodeKernel({});
    await installMcpcat(kernel);
  });

  after(() => {
    kernel?.terminate();
  });

  it('login exits 4 with pointer to agent sign-in', async () => {
    const { status, stderr } = await kernel.run(['mcpcat', 'login', 'example.com'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assert.equal(status, 4);
    assert.ok(stderr.includes('not available in seven'));
  });

  it('logout exits 4 in seven', async () => {
    const { status, stderr } = await kernel.run(['mcpcat', 'logout', 'example.com'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assert.equal(status, 4);
    assert.ok(stderr.includes('not available in seven'));
  });
});

describe('kernel: file object open/write/read/close', () => {
  let kernel;

  before(async () => {
    kernel = await createNodeKernel({});
    await installMcpcat(kernel);
  });

  after(() => {
    kernel?.terminate();
  });

  it('open, write, read, close on a regular file via JS program', async () => {
    await kernel.writeFile(
      '/node_modules/@ai-ecoverse/mcpcat-file-test/dist/main.mjs',
      `export default async function main(ctx) {
        const f = await ctx.open('/tmp/seal-test.txt', { read: true, write: true, create: true, truncate: true });
        await f.write(0, new TextEncoder().encode('hello'));
        const bytes = await f.read(0, 100);
        const text = new TextDecoder().decode(bytes);
        await f.close();
        await ctx.write(1, text);
        return text === 'hello' ? 0 : 1;
      }`
    );
    await kernel.writeFile(
      '/node_modules/@ai-ecoverse/mcpcat-file-test/package.json',
      JSON.stringify({
        name: '@ai-ecoverse/mcpcat-file-test',
        version: '1.0.0',
        type: 'module',
        slicc: {
          commands: {
            'mcpcat-file-test': { abi: 'js', module: 'dist/main.mjs' },
          },
        },
      })
    );

    const { status, stdout } = await kernel.run(['mcpcat-file-test'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assert.equal(status, 0, 'file object I/O should succeed');
    assert.equal(stdout.trim(), 'hello');
  });
});

describe('kernel: sealed device per-description state', () => {
  let kernel;

  before(async () => {
    kernel = await createNodeKernel({
      sealed: async (req) => {
        if (req.op === 'seal') {
          return { placeholder: '${' + req.name + '}', state: 'sealed' };
        }
        return { error: 'unknown op', errno: 'EINVAL' };
      },
    });
    await installMcpcat(kernel);
  });

  after(() => {
    kernel?.terminate();
  });

  it('kernel HTTP serve requires --bearer or --no-auth', async () => {
    const { status, stderr } = await kernel.run(['mcpcat', 'serve', '--http', '0', '/bin/echo'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assert.equal(status, 2);
    assert.ok(stderr.includes('--bearer') || stderr.includes('--no-auth'));
  });
});

describe('B5-1: kernel lock atomicity — 10 parallel add', () => {
  let kernel;

  before(async () => {
    kernel = await createNodeKernel({});
    await installMcpcat(kernel);
    await kernel.writeFile('/mcp.json', '{}');
  });

  after(() => {
    kernel?.terminate();
  });

  it('keeps all 10 entries from parallel add', async () => {
    const adds = Array.from({ length: 10 }, (_, i) =>
      kernel.run(
        [
          'mcpcat',
          'add',
          `srv${i}`,
          `http://127.0.0.1:${9900 + i}/mcp`,
          '--no-probe',
          '--config',
          '/mcp.json',
        ],
        { stdout: 'pipe', stderr: 'pipe' }
      )
    );
    const results = await Promise.all(adds);
    for (let i = 0; i < 10; i++) {
      assert.equal(results[i].status, 0, `add srv${i} failed: ${results[i].stderr}`);
    }

    const raw = new TextDecoder().decode(await kernel.readFile('/mcp.json'));
    const config = JSON.parse(raw);
    const servers = Object.keys(config.mcpServers || {});
    assert.equal(
      servers.length,
      10,
      `expected 10 servers, got ${servers.length}: ${servers.join(', ')}`
    );
    for (let i = 0; i < 10; i++) {
      assert.ok(servers.includes(`srv${i}`), `missing srv${i}`);
    }
  });
});

describe('kernel: chmod feature-detection for token store', () => {
  let kernel;

  before(async () => {
    kernel = await createNodeKernel({});
    await installMcpcat(kernel);
  });

  after(() => {
    kernel?.terminate();
  });

  it('detects ctx.fs.chmod and applies 0600 when available (skipped if missing)', async () => {
    const probeCode = [
      'export default async function main(ctx) {',
      '  const enc = new TextEncoder();',
      '  const has = typeof ctx.fs.chmod === "function";',
      '  await ctx.write(1, enc.encode(has ? "yes" : "no"));',
      '  return 0;',
      '}',
    ].join('\n');
    await kernel.writeFile('/node_modules/chprobe/index.mjs', probeCode);
    await kernel.writeFile(
      '/node_modules/chprobe/package.json',
      JSON.stringify({
        name: 'chprobe',
        type: 'module',
        slicc: { commands: { chprobe: { abi: 'js', module: 'index.mjs' } } },
      })
    );
    const { status, stdout } = await kernel.run(['chprobe'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assert.equal(status, 0);
    const hasChmod = stdout.trim() === 'yes';
    if (!hasChmod) {
      return;
    }
    await kernel.writeFile('/test-mode.txt', 'hello');
    const chmodCode = [
      'export default async function main(ctx) {',
      '  await ctx.fs.chmod("/test-mode.txt", 384);',
      '  const s = await ctx.fs.stat("/test-mode.txt");',
      '  const enc = new TextEncoder();',
      '  await ctx.write(1, enc.encode(String(s.mode)));',
      '  return 0;',
      '}',
    ].join('\n');
    await kernel.writeFile('/node_modules/chset/index.mjs', chmodCode);
    await kernel.writeFile(
      '/node_modules/chset/package.json',
      JSON.stringify({
        name: 'chset',
        type: 'module',
        slicc: { commands: { chset: { abi: 'js', module: 'index.mjs' } } },
      })
    );
    const r = await kernel.run(['chset'], { stdout: 'pipe', stderr: 'pipe' });
    assert.equal(r.status, 0, `chmod program failed: ${r.stderr}`);
    const mode = Number(r.stdout.trim());
    assert.equal(mode & 0o777, 0o600, `expected 0600, got ${(mode & 0o777).toString(8)}`);
  });
});
