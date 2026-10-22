import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { attachKernel, createNodeKernel, hostUrl, nodeTransport } from './helpers/kernel.mjs';
import { root, startFixture } from './helpers/rows.mjs';

const MARK = 'proxyKernelSecretW4n8Rt';
const ID = 'proxyKernIdPfx';
const SUFFIX = 'SuffixLeak88';
const AGENT_DIR = '/etc/mcpcat-proxy-vars';
const env = {
  PI_CODING_AGENT_DIR: AGENT_DIR,
  PROXY_TOK: MARK,
  PROXY_ID: ID,
  PROXY_KEY: `${ID}${SUFFIX}`,
  PROXY_HEAD: 'ShiftHeadQ7v',
  PROXY_TAIL: 'JK',
  PROXY_SHIFT: 'hiftHeadQ7vJK',
  PROXY_SHORT: 'abc1234',
};
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

function startServe(client, args) {
  const dec = new TextDecoder();
  let stdout = '';
  let stderr = '';
  let resolveLine;
  const line = new Promise((resolve) => {
    resolveLine = resolve;
  });
  const check = () => {
    const nl = stdout.indexOf('\n');
    if (nl >= 0 && stderr.includes('listening on')) resolveLine(stdout.slice(0, nl));
  };
  const spawned = client.spawn(
    ['mcpcat', 'serve', '--proxy', ...args, '--http', '0', '--no-auth', '--json'],
    {
      stdin: 'pipe',
      env,
      onStdout(chunk) {
        stdout += dec.decode(chunk, { stream: true });
        check();
      },
      onStderr(chunk) {
        stderr += dec.decode(chunk, { stream: true });
        check();
      },
    }
  );
  return { spawned, line };
}

describe('kernel: proxy hides each ${VAR} value of a header', () => {
  let up;
  let kernel;
  let client;
  const serves = [];
  const urls = {};

  before(async () => {
    up = await startFixture('reflect-server.mjs');
    const target = `${hostUrl(up.port)}/tok/mcp`;
    kernel = await createNodeKernel({
      network: { transport: nodeTransport({ hostLoopback: true }) },
    });
    await kernel.writeFile(
      '/node_modules/@ai-ecoverse/mcpcat/dist/kernel/mcpcat.mjs',
      readFileSync(join(root, 'dist/kernel/mcpcat.mjs'))
    );
    await kernel.writeFile(
      '/node_modules/@ai-ecoverse/mcpcat/package.json',
      JSON.stringify({
        name: '@ai-ecoverse/mcpcat',
        version: pkg.version,
        type: 'module',
        slicc: { commands: { mcpcat: { abi: 'js', module: 'dist/kernel/mcpcat.mjs' } } },
      })
    );
    await kernel.writeFile(
      `${AGENT_DIR}/mcp.json`,
      JSON.stringify({
        mcpServers: {
          tok: { url: target, headers: { Authorization: 'Bearer ${PROXY_TOK}' } },
          short: { url: target, headers: { 'X-Key': '${PROXY_SHORT}' } },
          unset: {
            url: target,
            headers: { Authorization: 'Bearer ${PROXY_UNSET}', 'X-Other': '${PROXY_ID}' },
          },
        },
      })
    );
    client = await attachKernel(await kernel.connect());
    const variants = {
      header: [target, '-H', 'Authorization: Bearer ${PROXY_TOK}'],
      config: ['tok'],
      short: ['short'],
      nested: [target, '-H', 'X-Id: ${PROXY_ID}', '-H', 'X-Key: ${PROXY_KEY}'],
      shifted: [
        target,
        '-H',
        'Authorization: Bearer ${PROXY_HEAD}${PROXY_TAIL}',
        '-H',
        'X-Shift: ${PROXY_SHIFT}',
      ],
    };
    for (const [name, args] of Object.entries(variants)) {
      const s = startServe(client, args);
      serves.push(s);
      urls[name] = JSON.parse(await s.line).url;
    }
  });

  after(async () => {
    for (const s of serves) {
      const sp = await s.spawned;
      sp.signal('SIGTERM');
      await sp.exited;
    }
    client?.close();
    kernel?.terminate();
    up?.child.kill('SIGTERM');
  });

  const call = (url, tool) =>
    kernel.run(['mcpcat', 'call', url, tool], { stdout: 'pipe', stderr: 'pipe' });

  for (const via of ['header', 'config']) {
    for (const tool of ['headers', 'err']) {
      it(`never returns the token: ${via}, ${tool}`, async () => {
        const r = await call(urls[via], tool);
        const out = `${r.stdout}${r.stderr}`;
        assert.ok(!out.includes(MARK), out.slice(0, 600));
        assert.ok(out.includes('token ***'), out.slice(0, 600));
      });
    }
  }

  for (const tool of ['headers', 'err']) {
    it(`never returns the suffix of a longer value: ${tool}`, async () => {
      const r = await call(urls.nested, tool);
      const out = `${r.stdout}${r.stderr}`;
      assert.ok(!out.includes(SUFFIX), out.slice(0, 600));
      assert.ok(out.includes('key ***'), out.slice(0, 600));
    });
  }

  for (const tool of ['headers', 'err']) {
    it(`never returns the tail of a value that overlaps another: ${tool}`, async () => {
      const r = await call(urls.shifted, tool);
      const out = `${r.stdout}${r.stderr}`;
      assert.ok(out.includes('token *** key'), out.slice(0, 600));
    });
  }

  for (const tool of ['headers', 'err']) {
    it(`never returns a short mcp.json header value: ${tool}`, async () => {
      const r = await call(urls.short, tool);
      const out = `${r.stdout}${r.stderr}`;
      assert.ok(!out.includes('abc1234'), out.slice(0, 600));
      assert.ok(out.includes('key ***'), out.slice(0, 600));
    });
  }

  const unsetCases = {
    'mcp.json': () => ['unset'],
    '-H': () => [
      `${hostUrl(up.port)}/tok/mcp`,
      '-H',
      'Authorization: Bearer ${PROXY_UNSET}',
      '-H',
      'X-Other: ${PROXY_ID}',
    ],
  };

  for (const [via, args] of Object.entries(unsetCases)) {
    it(`refuses a header with an unset \${VAR}: ${via}`, async () => {
      const before = (await (await fetch(`${up.base}/seen`)).json()).length;
      const r = await Promise.race([
        kernel.run(['mcpcat', 'serve', '--proxy', ...args(), '--http', '0', '--no-auth'], {
          stdout: 'pipe',
          stderr: 'pipe',
          env,
        }),
        new Promise((resolve) =>
          setTimeout(() => resolve({ status: 'hung', stdout: '', stderr: '' }), 10_000)
        ),
      ]);
      assert.equal(r.status, 2, r.stderr);
      assert.match(r.stderr, /unset variable PROXY_UNSET in header 'Authorization'/);
      assert.ok(!r.stderr.includes(ID), r.stderr);
      assert.equal(r.stdout, '');
      const seen = await (await fetch(`${up.base}/seen`)).json();
      assert.equal(seen.length, before);
    });
  }

  it('sends the expanded mcp.json header upstream', async () => {
    const seen = await (await fetch(`${up.base}/seen`)).json();
    assert.ok(seen.some((e) => e.headers.authorization === `Bearer ${MARK}`));
    assert.ok(!seen.some((e) => (e.headers.authorization ?? '').includes('${')));
  });
});
