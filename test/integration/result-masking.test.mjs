import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fixtures, homeEnv, run, scratchHome, startFixture } from './helpers/rows.mjs';

const MARK = 'resultMaskSecretT6p2Lx';
const ODD = 'odd"token\\value9';
const MASK = '[REDACTED]';

function forms(value) {
  const once = JSON.stringify(value).slice(1, -1);
  const twice = JSON.stringify(once).slice(1, -1);
  return [value, once, twice, JSON.stringify(twice).slice(1, -1)];
}

function assertHidden({ stdout, stderr }, value) {
  for (const text of [stdout, stderr]) {
    for (const form of forms(value)) assert.ok(!text.includes(form), text);
  }
}

describe('results are masked like errors', () => {
  let srv;
  let home;
  let target;

  const env = (vars) => ({ env: homeEnv(home, vars) });
  const client = (args, value = MARK) => run(args, env({ RESULT_TOKEN: value }));
  const auth = ['-H', 'Authorization: Bearer ${RESULT_TOKEN}'];

  before(async () => {
    srv = await startFixture('reflect-server.mjs');
    home = scratchHome('result-masking');
    target = `${srv.base}/tok/mcp`;
    writeFileSync(
      join(home, '.pi/agent/mcp.json'),
      JSON.stringify({
        mcpServers: {
          s: { url: target, headers: { Authorization: 'Bearer ${RESULT_TOKEN}' } },
          modern: {
            url: `${srv.base}/tok/ask`,
            headers: { Authorization: 'Bearer ${RESULT_TOKEN}' },
          },
          ok: {
            url: `${srv.base}/tok/ask-ok`,
            headers: { Authorization: 'Bearer ${RESULT_TOKEN}' },
          },
        },
      })
    );
  });

  after(() => srv?.child.kill('SIGTERM'));

  for (const value of [MARK, ODD]) {
    const label = value === MARK ? 'plain value' : 'value that needs escaping';

    for (const tool of ['headers', 'rich', 'structured', 'nested']) {
      it(`call ${tool}, text: ${label}`, () => {
        const r = client(['call', 's', tool], value);
        assert.equal(r.status, 0, r.stderr);
        assertHidden(r, value);
        assert.ok(r.stdout.includes(MASK), r.stdout);
      });

      it(`call ${tool}, --json: ${label}`, () => {
        const r = client(['--json', 'call', 's', tool], value);
        assert.equal(r.status, 0, r.stderr);
        assertHidden(r, value);
        assert.ok(r.stdout.includes(MASK), r.stdout);
        JSON.parse(r.stdout);
      });

      it(`call ${tool}, -H: ${label}`, () => {
        const r = client([...auth, 'call', target, tool], value);
        assert.equal(r.status, 0, r.stderr);
        assertHidden(r, value);
      });
    }

    it(`call -o, text: ${label}`, () => {
      const path = join(home, 'out.txt');
      const r = client(['-o', path, 'call', 's', 'rich'], value);
      assert.equal(r.status, 0, r.stderr);
      const text = readFileSync(path, 'utf8');
      assertHidden({ stdout: text, stderr: '' }, value);
      assert.ok(text.includes(MASK), text);
    });

    it(`call -o, --json: ${label}`, () => {
      const path = join(home, 'out.json');
      const r = client(['--json', '-o', path, 'call', 's', 'rich'], value);
      assert.equal(r.status, 0, r.stderr);
      const text = readFileSync(path, 'utf8');
      assertHidden({ stdout: text, stderr: '' }, value);
      JSON.parse(text);
    });

    it(`a result flagged isError: ${label}`, () => {
      const r = client(['call', 's', 'failed'], value);
      assert.equal(r.status, 1, r.stderr);
      assertHidden(r, value);
      assert.ok(r.stderr.includes(MASK), r.stderr);
    });

    const verbs = {
      info: ['info', 's'],
      read: ['read', 's', 'mem://r'],
      'read --json': ['--json', 'read', 's', 'mem://r'],
      resources: ['resources', 's'],
      'resources --json': ['--json', 'resources', 's'],
      prompts: ['prompts', 's'],
      'prompts --json': ['--json', 'prompts', 's'],
      prompt: ['prompt', 's', 'p'],
      'prompt --json': ['--json', 'prompt', 's', 'p'],
      complete: ['complete', 's', 'prompt', 'p', 'a=b'],
      'complete --json': ['--json', 'complete', 's', 'prompt', 'p', 'a=b'],
      'task get': ['task', 'get', 'modern', 'task-1'],
      'task get --json': ['--json', 'task', 'get', 'modern', 'task-1'],
    };

    for (const [name, args] of Object.entries(verbs)) {
      it(`${name}: ${label}`, () => {
        const r = client(args, value);
        assert.equal(r.status, 0, r.stderr);
        assertHidden(r, value);
        assert.ok(r.stdout.includes(MASK), r.stdout);
        if (name.endsWith('--json')) JSON.parse(r.stdout);
      });
    }

    it(`a call retried with --respond: ${label}`, () => {
      const r = client(['--respond', '{"answer":"y"}', 'call', 'ok', 'ask'], value);
      assert.equal(r.status, 0, r.stderr);
      assertHidden(r, value);
      assert.ok(r.stdout.includes(MASK), r.stdout);
    });

    it(`read -o: ${label}`, () => {
      const path = join(home, 'resource.txt');
      const r = client(['-o', path, 'read', 's', 'mem://r'], value);
      assert.equal(r.status, 0, r.stderr);
      const text = readFileSync(path, 'utf8');
      assertHidden({ stdout: text, stderr: '' }, value);
      assert.ok(text.includes(MASK), text);
    });

    it(`task get -o --json: ${label}`, () => {
      const path = join(home, 'task.json');
      const r = client(['--json', '-o', path, 'task', 'get', 'modern', 'task-1'], value);
      assert.equal(r.status, 0, r.stderr);
      assertHidden({ stdout: readFileSync(path, 'utf8'), stderr: '' }, value);
    });
  }

  it('a progress line is masked', () => {
    const script = join(fixtures, 'server-stdio-progress.mjs');
    const r = run(
      [
        '-v',
        '-H',
        'X-Word: step',
        'call',
        `stdio:node ${script}`,
        'progress-finish',
        '-d',
        '{"intervalMs":1,"steps":1}',
      ],
      env({})
    );
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stderr.includes(`* progress: 100% ${MASK} 1`), r.stderr);
  });

  it('tools and describe mask a listing', () => {
    const listed = `${srv.base}/tok/listed`;
    for (const args of [
      ['tools', listed],
      ['--json', 'tools', listed],
      ['describe', listed],
      ['--json', 'describe', listed],
    ]) {
      const r = client([...auth, ...args]);
      assert.equal(r.status, 0, r.stderr);
      assertHidden(r, MARK);
      assert.ok(r.stdout.includes(MASK), r.stdout);
    }
  });

  it('a whole header value is masked at any length', () => {
    const r = run(
      ['-H', 'X-Key: ${RESULT_SHORT}', 'call', target, 'headers'],
      env({ RESULT_SHORT: 'abc1234' })
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, `token  key ${MASK}\n`);
  });

  it('a ${VAR} value under 8 characters stays inside a longer header', () => {
    const r = run(
      ['-H', 'X-Key: id-${RESULT_SHORT}', 'call', target, 'echo', '--message', 'abc1234 stays'],
      env({ RESULT_SHORT: 'abc1234' })
    );
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'abc1234 stays\n');
  });

  it('content without a secret stays byte-identical', () => {
    const message = 'plain "quoted" \\ back\tslash é ✓';
    const args = ['call', target, 'echo', '--message', message];
    const text = client([...auth, ...args]);
    assert.equal(text.stdout, `${message}\n`);
    const plain = run(['--json', ...args], env({}));
    const json = client([...auth, '--json', ...args]);
    assert.equal(json.stdout, plain.stdout);
  });

  it('--json stays valid when a header value matches a number', () => {
    const r = run(['-H', 'X-Debug: 1', '--json', 'call', target, 'count'], env({}));
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).structuredContent, { count: MASK, label: 'plain' });
  });
});
