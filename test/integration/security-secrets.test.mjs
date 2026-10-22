import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { isStandalone, mcpcatArgs, mcpcatBin } from './helpers/bin.mjs';
import { filesUnder, homeEnv, root, run, scratchHome, startFixture } from './helpers/rows.mjs';

const MARK = 'secrowSecretQ7v3Zk9';

describe('security: secrets redaction', () => {
  let srv;
  let home;
  let env;
  const header = ['-H', 'X-Api: ${ROW_TOKEN}'];

  before(async () => {
    srv = await startFixture('reflect-server.mjs');
    home = scratchHome('secrets');
    env = homeEnv(home, { ROW_TOKEN: MARK });
    writeFileSync(
      join(home, '.pi/agent/mcp.json'),
      JSON.stringify({
        mcpServers: {
          r: { url: `${srv.base}/mcp`, headers: { 'X-Api': '${ROW_TOKEN}' } },
          r500: { url: `${srv.base}/500`, headers: { 'X-Api': '${ROW_TOKEN}' } },
          r403: { url: `${srv.base}/403`, headers: { 'X-Api': '${ROW_TOKEN}' } },
          r401: { url: `${srv.base}/401`, headers: { 'X-Api': '${ROW_TOKEN}' } },
          rask: { url: `${srv.base}/ask`, headers: { 'X-Api': '${ROW_TOKEN}' } },
          rtok: {
            url: `${srv.base}/tok/mcp`,
            headers: { Authorization: 'Bearer ${ROW_TOKEN}' },
          },
          rtok500: {
            url: `${srv.base}/tok/500`,
            headers: { Authorization: 'Bearer ${ROW_TOKEN}' },
          },
          rtokask: {
            url: `${srv.base}/tok/ask`,
            headers: { Authorization: 'Bearer ${ROW_TOKEN}' },
          },
        },
      })
    );
  });

  after(() => srv?.child.kill('SIGTERM'));

  const cases = {
    'a JSON-RPC error quoting -H': () => [...header, 'call', `${srv.base}/mcp`, 'err'],
    'a JSON-RPC error quoting -H, --json': () => [
      ...header,
      '--json',
      'call',
      `${srv.base}/mcp`,
      'err',
    ],
    'a JSON-RPC error quoting -H, -v': () => [...header, '-v', 'call', `${srv.base}/mcp`, 'err'],
    'a successful call with -H, -v': () => [
      ...header,
      '-v',
      'call',
      `${srv.base}/mcp`,
      'echo',
      '-d',
      '{"message":"hi"}',
    ],
    'tools with -H, -v': () => [...header, '-v', 'tools', `${srv.base}/mcp`],
    'HTTP 500 quoting -H': () => [...header, 'call', `${srv.base}/500`, 'echo'],
    'HTTP 500 quoting -H, --json': () => [...header, '--json', 'call', `${srv.base}/500`, 'echo'],
    'HTTP 500 quoting -H, -v': () => [...header, '-v', 'call', `${srv.base}/500`, 'echo'],
    'HTTP 403 quoting -H': () => [...header, 'call', `${srv.base}/403`, 'echo'],
    'HTTP 403 quoting -H, --json': () => [...header, '--json', 'call', `${srv.base}/403`, 'echo'],
    'HTTP 403 quoting -H, -v info': () => [...header, '-v', 'info', `${srv.base}/403`],
    'HTTP 401 quoting -H, -v': () => [...header, '-v', 'call', `${srv.base}/401`, 'echo'],
    'mcp.json ${VAR}, JSON-RPC error': () => ['call', 'r', 'err'],
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
    'mcp.json ${VAR}, HTTP 500, -v': () => ['-v', 'call', 'r500', 'echo'],
    'mcp.json ${VAR}, HTTP 403': () => ['call', 'r403', 'echo'],
    'mcp.json ${VAR}, HTTP 403, --json': () => ['--json', 'call', 'r403', 'echo'],
    'mcp.json ${VAR}, HTTP 401, -v': () => ['-v', 'call', 'r401', 'echo'],
  };

  for (const [name, args] of Object.entries(cases)) {
    it(`never prints the value: ${name}`, () => {
      const r = run(args(), { env });
      assert.notEqual(r.status, null, `mcpcat did not exit: ${r.signal}`);
      const out = r.stdout + r.stderr;
      assert.ok(!out.includes(MARK), `the secret leaked (exit ${r.status}):\n${out.slice(0, 600)}`);
    });
  }

  const inputCases = {
    'an input request quoting -H': [() => [...header, 'call', `${srv.base}/ask`, 'ask'], 6, false],
    'an input request quoting -H, --json': [
      () => [...header, '--json', 'call', `${srv.base}/ask`, 'ask'],
      6,
      true,
    ],
    'a bare input request quoting -H': [
      () => [...header, 'call', `${srv.base}/ask`, 'ask', '-d', '{"bare":true}'],
      6,
      true,
    ],
    'an input request quoting mcp.json ${VAR}': [() => ['call', 'rask', 'ask'], 6, false],
    'a retried call failing with -H, --respond': [
      () => [...header, '--respond', '{"answer":"y"}', 'call', `${srv.base}/ask`, 'ask'],
      5,
      false,
    ],
    'a retried call failing with -H, --respond, --json': [
      () => [...header, '--json', '--respond', '{"answer":"y"}', 'call', `${srv.base}/ask`, 'ask'],
      5,
      true,
    ],
  };

  for (const [name, [args, status, json]] of Object.entries(inputCases)) {
    it(`redacts the value: ${name}`, async () => {
      const r = run(args(), { env });
      const out = `${r.stdout}${r.stderr}`;
      assert.equal(r.status, status, out.slice(0, 600));
      assert.ok(!out.includes(MARK), `the secret leaked (exit ${r.status}):\n${out.slice(0, 600)}`);
      assert.ok(r.stderr.includes('[REDACTED]'), r.stderr.slice(0, 600));
      if (json) JSON.parse(r.stderr);
    });
  }

  const ttyCases = {
    'the input prompt quoting -H': () => [...header, 'call', `${srv.base}/ask`, 'ask'],
    'the input prompt quoting mcp.json ${VAR}': () => ['call', 'rask', 'ask'],
  };

  for (const [name, args] of Object.entries(ttyCases)) {
    it(`redacts the value: ${name}`, { skip: isStandalone }, () => {
      const r = spawnSync(
        process.execPath,
        ['--import', join(root, 'test/integration/helpers/fake-tty.mjs'), mcpcatBin, ...args()],
        { env, input: 'y\n', timeout: 30_000, encoding: 'utf8' }
      );
      const out = `${r.stdout}${r.stderr}`;
      assert.equal(r.status, 5, out.slice(0, 600));
      assert.ok(!out.includes(MARK), `the secret leaked (exit ${r.status}):\n${out.slice(0, 600)}`);
      assert.match(r.stderr, /need input [^\n]*\[REDACTED\]/);
      assert.match(r.stderr, /answer - about [^\n]*\[REDACTED\]/);
    });
  }

  it('retries when the value matches a protocol key', () => {
    const r = run(
      ['-H', 'X-Api: ${ROW_KEY}', '--respond', '{"answer":"y"}', 'call', `${srv.base}/ask`, 'ask'],
      { env: { ...env, ROW_KEY: 'input' } }
    );
    assert.equal(r.status, 5, r.stderr.slice(0, 600));
    assert.ok(r.stderr.includes('retry failed'), r.stderr.slice(0, 600));
  });

  for (const [name, path, tool] of [
    ['an input request', 'ask', 'ask'],
    ['a JSON-RPC error', 'mcp', 'err'],
  ]) {
    it(`terminates when the value is the marker: ${name}`, () => {
      const { cmd, args } = mcpcatArgs([
        '-H',
        'X-Api: ${ROW_KEY}',
        'call',
        `${srv.base}/${path}`,
        tool,
      ]);
      const r = spawnSync(cmd, args, {
        env: { ...env, ROW_KEY: 'REDACTED' },
        timeout: 10_000,
        killSignal: 'SIGKILL',
        encoding: 'utf8',
      });
      assert.notEqual(r.status, null, `mcpcat did not exit: ${r.signal}`);
      assert.ok(r.stderr.includes('[REDACTED]'), r.stderr.slice(0, 600));
    });
  }

  const bearer = ['-H', 'Authorization: Bearer ${ROW_TOKEN}'];
  const SUFFIX = 'SuffixLeak77';
  const tokEnv = () => ({
    ...env,
    ROW_ID: 'secrowIdPfx01',
    ROW_KEY2: `secrowIdPfx01${SUFFIX}`,
    ROW_HEAD: 'ShiftHeadQ7v',
    ROW_TAIL: 'JK',
    ROW_SHIFT: 'hiftHeadQ7vJK',
  });
  const tokenCases = {
    '-H Bearer ${VAR}, JSON-RPC error': () => [...bearer, 'call', `${srv.base}/tok/mcp`, 'err'],
    '-H Bearer ${VAR}, JSON-RPC error, --json': () => [
      ...bearer,
      '--json',
      'call',
      `${srv.base}/tok/mcp`,
      'err',
    ],
    '-H Bearer ${VAR}, JSON-RPC error, -v': () => [
      ...bearer,
      '-v',
      'call',
      `${srv.base}/tok/mcp`,
      'err',
    ],
    '-H Bearer ${VAR}, HTTP 500': () => [...bearer, 'call', `${srv.base}/tok/500`, 'echo'],
    '-H Bearer ${VAR}, input request': () => [...bearer, 'call', `${srv.base}/tok/ask`, 'ask'],
    'mcp.json Bearer ${VAR}, JSON-RPC error': () => ['call', 'rtok', 'err'],
    'mcp.json Bearer ${VAR}, HTTP 500, -v': () => ['-v', 'call', 'rtok500', 'echo'],
    'mcp.json Bearer ${VAR}, input request, --json': () => ['--json', 'call', 'rtokask', 'ask'],
    'a ${VAR} value that extends another': () => [
      '-H',
      'X-Id: ${ROW_ID}',
      '-H',
      'X-Key: ${ROW_KEY2}',
      'call',
      `${srv.base}/tok/mcp`,
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
        `${srv.base}/tok/mcp`,
        'err',
      ];
      const r = run(argv, { env: tokEnv() });
      const out = `${r.stdout}${r.stderr}`;
      assert.ok(!/\[REDACTED\]JK/.test(out), out.slice(0, 600));
      assert.match(out, /token \[REDACTED\] key/);
    });
  }

  for (const [name, args] of Object.entries(tokenCases)) {
    it(`redacts the ${'${VAR}'} value: ${name}`, async () => {
      const r = run(args(), { env: tokEnv() });
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
          ? run([...pad(n), ...header, ...argv(`${srv.base}${path}`)], { env })
          : run(
              [
                'add',
                '--config',
                join(home, `cut-${n}.json`),
                'p',
                `${srv.base}${path}`,
                ...pad(n),
                ...header,
              ],
              { env }
            );
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
    it(`redacts the probe failure of add: ${name}`, () => {
      const file = join(home, `add-${name.replaceAll('/', '-')}.json`);
      const r = run(['add', '--config', file, 'p', `${srv.base}${path}`, ...h], { env: tokEnv() });
      const out = `${r.stdout}${r.stderr}`;
      assert.equal(r.status, 3, out.slice(0, 600));
      assert.ok(!out.includes(MARK), `the secret leaked:\n${out.slice(0, 600)}`);
      assert.ok(!out.includes(SUFFIX), `a suffix leaked:\n${out.slice(0, 600)}`);
      assert.match(r.stderr, /probe failed: [^\n]*\[REDACTED\]/);
    });
  }

  it('delivers the expanded value to the server', async () => {
    const r = run([...header, 'call', `${srv.base}/mcp`, 'echo', '-d', '{"message":"x"}'], { env });
    assert.equal(r.status, 0, r.stderr);
    const seen = await (await fetch(`${srv.base}/seen`)).json();
    assert.ok(seen.some((e) => e.headers['x-api'] === MARK));
  });

  it('refuses an unset ${VAR} with exit 2', () => {
    const r = run(['-H', 'X-Api: ${ROW_UNSET}', 'call', `${srv.base}/mcp`, 'echo'], { env });
    assert.equal(r.status, 2, r.stderr);
  });

  it('writes the value to no file and keeps ${VAR} in mcp.json', () => {
    const hits = filesUnder(home).filter((p) => readFileSync(p).includes(MARK));
    assert.deepEqual(hits, []);
    assert.ok(readFileSync(join(home, '.pi/agent/mcp.json'), 'utf8').includes('${ROW_TOKEN}'));
  });
});
