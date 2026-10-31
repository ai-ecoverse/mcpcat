import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createNodeKernel, hostUrl, nodeTransport } from './helpers/kernel.mjs';
import { root, startFixture } from './helpers/rows.mjs';

const MARK = 'secrowKernelSecretH4w8Pq';
const AGENT_DIR = '/etc/mcpcat-row';
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

describe('security: secrets redaction in the kernel', () => {
  let srv;
  let kernel;
  let base;
  const header = ['-H', 'X-Api: ${ROW_TOKEN}'];
  const env = { ROW_TOKEN: MARK, PI_CODING_AGENT_DIR: AGENT_DIR };
  const run = (argv) => kernel.run(['mcpcat', ...argv], { stdout: 'pipe', stderr: 'pipe', env });

  before(async () => {
    srv = await startFixture('reflect-server.mjs');
    base = hostUrl(srv.port);
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
          r: { url: `${base}/mcp`, headers: { 'X-Api': '${ROW_TOKEN}' } },
          r500: { url: `${base}/500`, headers: { 'X-Api': '${ROW_TOKEN}' } },
          r403: { url: `${base}/403`, headers: { 'X-Api': '${ROW_TOKEN}' } },
          r401: { url: `${base}/401`, headers: { 'X-Api': '${ROW_TOKEN}' } },
          rask: { url: `${base}/ask`, headers: { 'X-Api': '${ROW_TOKEN}' } },
          rtok: { url: `${base}/tok/mcp`, headers: { Authorization: 'Bearer ${ROW_TOKEN}' } },
          rtok500: {
            url: `${base}/tok/500`,
            headers: { Authorization: 'Bearer ${ROW_TOKEN}' },
          },
          rtokask: {
            url: `${base}/tok/ask`,
            headers: { Authorization: 'Bearer ${ROW_TOKEN}' },
          },
        },
      })
    );
  });

  after(() => {
    kernel?.terminate();
    srv?.child.kill('SIGTERM');
  });

  const cases = {
    'a JSON-RPC error quoting -H': () => [...header, 'call', `${base}/mcp`, 'err'],
    'a JSON-RPC error quoting -H, --json': () => [
      ...header,
      '--json',
      'call',
      `${base}/mcp`,
      'err',
    ],
    'a JSON-RPC error quoting -H, -v': () => [...header, '-v', 'call', `${base}/mcp`, 'err'],
    'a successful call with -H, -v': () => [
      ...header,
      '-v',
      'call',
      `${base}/mcp`,
      'echo',
      '-d',
      '{"message":"hi"}',
    ],
    'tools with -H, -v': () => [...header, '-v', 'tools', `${base}/mcp`],
    'HTTP 500 quoting -H, -v': () => [...header, '-v', 'call', `${base}/500`, 'echo'],
    'HTTP 403 quoting -H, --json': () => [...header, '--json', 'call', `${base}/403`, 'echo'],
    'HTTP 401 quoting -H, -v': () => [...header, '-v', 'call', `${base}/401`, 'echo'],
    'mcp.json ${VAR}, JSON-RPC error, -v': () => ['-v', 'call', 'r', 'err'],
    'mcp.json ${VAR}, successful call, -v': () => [
      '-v',
      'call',
      'r',
      'echo',
      '-d',
      '{"message":"hi"}',
    ],
    'mcp.json ${VAR}, HTTP 500': () => ['call', 'r500', 'echo'],
    'mcp.json ${VAR}, HTTP 403, --json': () => ['--json', 'call', 'r403', 'echo'],
    'mcp.json ${VAR}, HTTP 401, -v': () => ['-v', 'call', 'r401', 'echo'],
  };

  for (const [name, args] of Object.entries(cases)) {
    it(`never prints the value: ${name}`, async () => {
      const r = await run(args());
      const out = `${r.stdout}${r.stderr}`;
      assert.ok(!out.includes(MARK), `the secret leaked (exit ${r.status}):\n${out.slice(0, 600)}`);
    });
  }

  const inputCases = {
    'an input request quoting -H': [() => [...header, 'call', `${base}/ask`, 'ask'], 6, false],
    'an input request quoting -H, --json': [
      () => [...header, '--json', 'call', `${base}/ask`, 'ask'],
      6,
      true,
    ],
    'a bare input request quoting -H': [
      () => [...header, 'call', `${base}/ask`, 'ask', '-d', '{"bare":true}'],
      6,
      true,
    ],
    'an input request quoting mcp.json ${VAR}': [() => ['call', 'rask', 'ask'], 6, false],
    'a retried call failing with -H, --respond': [
      () => [...header, '--respond', '{"answer":"y"}', 'call', `${base}/ask`, 'ask'],
      5,
      false,
    ],
    'a retried call failing with -H, --respond, --json': [
      () => [...header, '--json', '--respond', '{"answer":"y"}', 'call', `${base}/ask`, 'ask'],
      5,
      true,
    ],
  };

  for (const [name, [args, status, json]] of Object.entries(inputCases)) {
    it(`redacts the value: ${name}`, async () => {
      const r = await run(args());
      const out = `${r.stdout}${r.stderr}`;
      assert.equal(r.status, status, out.slice(0, 600));
      assert.ok(!out.includes(MARK), `the secret leaked (exit ${r.status}):\n${out.slice(0, 600)}`);
      assert.ok(r.stderr.includes('[REDACTED]'), r.stderr.slice(0, 600));
      if (json) JSON.parse(r.stderr);
    });
  }

  const bearer = ['-H', 'Authorization: Bearer ${ROW_TOKEN}'];
  const SUFFIX = 'SuffixLeak77';
  const tokEnv = {
    ...env,
    ROW_ID: 'secrowIdPfx01',
    ROW_KEY2: `secrowIdPfx01${SUFFIX}`,
    ROW_HEAD: 'ShiftHeadQ7v',
    ROW_TAIL: 'JK',
    ROW_SHIFT: 'hiftHeadQ7vJK',
  };
  const tokenCases = {
    '-H Bearer ${VAR}, JSON-RPC error': () => [...bearer, 'call', `${base}/tok/mcp`, 'err'],
    '-H Bearer ${VAR}, JSON-RPC error, --json': () => [
      ...bearer,
      '--json',
      'call',
      `${base}/tok/mcp`,
      'err',
    ],
    '-H Bearer ${VAR}, JSON-RPC error, -v': () => [
      ...bearer,
      '-v',
      'call',
      `${base}/tok/mcp`,
      'err',
    ],
    '-H Bearer ${VAR}, HTTP 500': () => [...bearer, 'call', `${base}/tok/500`, 'echo'],
    '-H Bearer ${VAR}, input request': () => [...bearer, 'call', `${base}/tok/ask`, 'ask'],
    'mcp.json Bearer ${VAR}, JSON-RPC error': () => ['call', 'rtok', 'err'],
    'mcp.json Bearer ${VAR}, HTTP 500, -v': () => ['-v', 'call', 'rtok500', 'echo'],
    'mcp.json Bearer ${VAR}, input request, --json': () => ['--json', 'call', 'rtokask', 'ask'],
    'a ${VAR} value that extends another': () => [
      '-H',
      'X-Id: ${ROW_ID}',
      '-H',
      'X-Key: ${ROW_KEY2}',
      'call',
      `${base}/tok/mcp`,
      'err',
    ],
  };

  for (const flag of [[], ['-v'], ['--json']]) {
    it(`masks a ${'${VAR}'} value that overlaps another at a shift: ${flag.join(' ') || 'plain'}`, async () => {
      const argv = [
        '-H',
        'Authorization: Bearer ${ROW_HEAD}${ROW_TAIL}',
        '-H',
        'X-Shift: ${ROW_SHIFT}',
        ...flag,
        'call',
        `${base}/tok/mcp`,
        'err',
      ];
      const r = await kernel.run(['mcpcat', ...argv], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: tokEnv,
      });
      const out = `${r.stdout}${r.stderr}`;
      assert.ok(!/\[REDACTED\]JK/.test(out), out.slice(0, 600));
      assert.match(out, /token \[REDACTED\] key/);
    });
  }

  const resultCases = {
    'a call result': ['call', 'rtok', 'headers'],
    'a call result, --json': ['--json', 'call', 'rtok', 'rich'],
    'a structured call result': ['call', 'rtok', 'structured'],
  };

  for (const [name, argv] of Object.entries(resultCases)) {
    it(`redacts the value: ${name}`, async () => {
      const r = await run(argv);
      const out = `${r.stdout}${r.stderr}`;
      assert.equal(r.status, 0, out.slice(0, 600));
      assert.ok(!out.includes(MARK), `the secret leaked:\n${out.slice(0, 600)}`);
      assert.ok(r.stdout.includes('[REDACTED]'), r.stdout.slice(0, 600));
    });
  }

  for (const [name, args] of Object.entries(tokenCases)) {
    it(`redacts the ${'${VAR}'} value: ${name}`, async () => {
      const r = await kernel.run(['mcpcat', ...args()], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: tokEnv,
      });
      const out = `${r.stdout}${r.stderr}`;
      assert.ok(!out.includes(MARK), `the secret leaked (exit ${r.status}):\n${out.slice(0, 600)}`);
      assert.ok(!out.includes(SUFFIX), `a suffix leaked (exit ${r.status}):\n${out.slice(0, 600)}`);
      assert.ok(out.includes('[REDACTED]'), out.slice(0, 600));
    });
  }

  const pad = (n) => (n === 0 ? [] : ['-H', `X-A: ${'p'.repeat(n)}`]);
  const cutCases = {
    'call /401, -v': ['/401', (u) => ['-v', 'call', u, 'echo']],
    'call /500': ['/500', (u) => ['call', u, 'echo'], [0, 560, 7]],
    'call /403, --json': ['/403', (u) => ['--json', 'call', u, 'echo']],
    'add /401': ['/401', null],
    'add /403': ['/403', null],
  };

  for (const [name, [path, argv, [from, to, step] = [0, 32, 1]]] of Object.entries(cutCases)) {
    it(`redacts before it truncates the error body: ${name}`, async () => {
      for (let n = from; n < to; n += step) {
        const r = argv
          ? await run([...pad(n), ...header, ...argv(`${base}${path}`)])
          : await run([
              'add',
              '--config',
              `${AGENT_DIR}/cut-${n}.json`,
              'p',
              `${base}${path}`,
              ...pad(n),
              ...header,
            ]);
        const out = `${r.stdout}${r.stderr}`;
        assert.ok(
          !out.includes(MARK.slice(0, 6)),
          `a prefix leaked (pad ${n}):\n${out.slice(0, 600)}`
        );
      }
    });
  }

  const addCases = {
    '/500': [['-H', 'X-Api: ${ROW_TOKEN}'], '/500'],
    '/tok/401': [bearer, '/tok/401'],
    '/tok/403': [bearer, '/tok/403'],
    '/tok/500': [bearer, '/tok/500'],
    'a value that extends another': [
      ['-H', 'X-Id: ${ROW_ID}', '-H', 'X-Key: ${ROW_KEY2}'],
      '/tok/401',
    ],
  };

  for (const [name, [h, path]] of Object.entries(addCases)) {
    it(`redacts the probe failure of add: ${name}`, async () => {
      const file = `${AGENT_DIR}/add-${name.replaceAll('/', '-')}.json`;
      const r = await kernel.run(['mcpcat', 'add', '--config', file, 'p', `${base}${path}`, ...h], {
        stdout: 'pipe',
        stderr: 'pipe',
        env: tokEnv,
      });
      const out = `${r.stdout}${r.stderr}`;
      assert.equal(r.status, 3, out.slice(0, 600));
      assert.ok(!out.includes(MARK), `the secret leaked:\n${out.slice(0, 600)}`);
      assert.ok(!out.includes(SUFFIX), `a suffix leaked:\n${out.slice(0, 600)}`);
      assert.match(r.stderr, /probe failed: [^\n]*\[REDACTED\]/);
    });
  }

  it('delivers the expanded value to the server', async () => {
    const r = await run([...header, 'call', `${base}/mcp`, 'echo', '-d', '{"message":"x"}']);
    assert.equal(r.status, 0, r.stderr);
    const seen = await (await fetch(`http://127.0.0.1:${srv.port}/seen`)).json();
    assert.ok(seen.some((e) => e.headers['x-api'] === MARK));
  });
});
