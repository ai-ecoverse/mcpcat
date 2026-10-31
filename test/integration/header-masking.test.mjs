import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fixtures, homeEnv, run, scratchHome, startFixture } from './helpers/rows.mjs';

const SHORT = 'zq7';
const LONG = 'zq7longer9';
const MASK = '[REDACTED]';
const CODE = 'console.log(await tools.mcp__s__headers({}));';

const CREDENTIAL_NAMES = [
  'Authorization',
  'Proxy-Authorization',
  'Cookie',
  'Set-Cookie',
  'X-Api-Key',
  'x-api-key',
  'X-Token',
  'X-SECRET-ID',
  'X-Password',
  'X-Passwd',
  'X-Credential',
  'X-Auth',
];

const PLAIN_NAMES = ['X-Debug', 'X-Tenant', 'X-Cookie-Consent'];

function assertShown(text) {
  assert.ok(text.includes(SHORT), text);
  assert.ok(!text.includes(MASK), text);
}

function assertMasked(text, value) {
  assert.ok(!text.includes(value), text);
  assert.ok(text.includes(MASK), text);
}

describe('one masking rule for header values', () => {
  let srv;
  let home;
  let target;

  const env = (vars) => ({ env: homeEnv(home, vars) });
  const output = ({ stdout, stderr }) => `${stdout}${stderr}`;

  before(async () => {
    srv = await startFixture('reflect-server.mjs');
    home = scratchHome('header-masking');
    target = `${srv.base}/mcp`;
    const entry = (headers) => ({ url: target, headers });
    writeFileSync(
      join(home, '.pi/agent/mcp.json'),
      JSON.stringify({
        mcpServers: {
          s: { url: target },
          listed: { url: `${srv.base}/listed` },
          plain: entry({ 'X-Debug': SHORT }),
          credential: entry({ 'X-Api-Key': SHORT }),
          long: entry({ 'X-Debug': LONG }),
          'short-var': entry({ 'X-Debug': '${MASK_SHORT}' }),
          'long-var': entry({ 'X-Debug': '${MASK_LONG}' }),
          'credential-var': entry({ 'X-Api-Key': '${MASK_SHORT}' }),
        },
      })
    );
  });

  after(() => srv?.child.kill('SIGTERM'));

  const channels = {
    'a call result': () => ['call', target, 'headers'],
    'a call result, --json': () => ['--json', 'call', target, 'headers'],
    'a structured result': () => ['call', target, 'structured'],
    'a JSON-RPC error': () => ['call', target, 'err'],
    'an HTTP error': () => ['call', `${srv.base}/500`, 'echo'],
    'a listing': () => ['tools', `${srv.base}/listed`],
    'describe --ts': () => ['describe', 'listed', '--ts'],
    'code console output': () => ['code', '-e', CODE, '--server', 's'],
    'code failing tool': () => ['code', '-e', 'await tools.mcp__s__err({});', '--server', 's'],
    'a -v trace': () => ['-v', 'call', target, 'headers'],
  };

  for (const [name, args] of Object.entries(channels)) {
    it(`a short value under a plain name is shown: ${name}`, () => {
      assertShown(output(run(['-H', `X-Debug: ${SHORT}`, ...args()], env({}))));
    });

    it(`a short value under a credential-like name is masked: ${name}`, () => {
      assertMasked(output(run(['-H', `X-Api-Key: ${SHORT}`, ...args()], env({}))), SHORT);
    });

    it(`a plain value of 8 or more characters is masked: ${name}`, () => {
      assertMasked(output(run(['-H', `X-Debug: ${LONG}`, ...args()], env({}))), LONG);
    });
  }

  it('an -o file follows the rule', () => {
    const path = join(home, 'out.txt');
    const write = (header) => {
      const r = run(['-H', header, '-o', path, 'call', target, 'headers'], env({}));
      assert.equal(r.status, 0, r.stderr);
      return readFileSync(path, 'utf8');
    };
    assertShown(write(`X-Debug: ${SHORT}`));
    assertMasked(write(`X-Api-Key: ${SHORT}`), SHORT);
    assertMasked(write(`X-Debug: ${LONG}`), LONG);
  });

  it('a progress line follows the rule', () => {
    const args = (header) => [
      '-v',
      '-H',
      header,
      'call',
      `stdio:node ${join(fixtures, 'server-stdio-progress.mjs')}`,
      'progress-finish',
      '-d',
      '{"intervalMs":1,"steps":1}',
    ];
    assert.ok(run(args('X-Word: step'), env({})).stderr.includes('* progress: 100% step 1'));
    const masked = run(args('X-Token: step'), env({}));
    assert.ok(masked.stderr.includes(`* progress: 100% ${MASK} 1`), masked.stderr);
  });

  for (const name of CREDENTIAL_NAMES) {
    it(`${name} is credential-like`, () => {
      const r = run(['-H', `${name}: ${SHORT}`, 'call', target, 'headers'], env({}));
      assert.equal(r.status, 0, r.stderr);
      assertMasked(r.stdout, SHORT);
    });
  }

  for (const name of PLAIN_NAMES) {
    it(`${name} is not credential-like`, () => {
      const r = run(['-H', `${name}: ${SHORT}`, 'call', target, 'headers'], env({}));
      assert.equal(r.status, 0, r.stderr);
      assertShown(r.stdout);
    });
  }

  it('a value of 7 characters under a plain name is shown', () => {
    const r = run(['-H', 'X-Debug: zq7long', 'call', target, 'headers'], env({}));
    assert.ok(r.stdout.includes('"x-debug":"zq7long"'), r.stdout);
  });

  it('a value under both a plain and a credential-like name is masked', () => {
    const r = run(
      ['-H', `X-Debug: ${SHORT}`, '-H', `X-Api-Key: ${SHORT}`, 'call', target, 'headers'],
      env({})
    );
    assertMasked(r.stdout, SHORT);
  });

  it('a short value leaves ordinary words alone', () => {
    const r = run(['-H', 'X-Tenant: us', 'call', target, 'echo', '--message', 'status'], env({}));
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, 'status\n');
  });

  it('a short value leaves --json numbers alone', () => {
    const r = run(['-H', 'X-Debug: 1', '--json', 'call', target, 'count'], env({}));
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout).structuredContent, { count: 1, label: 'plain' });
  });

  it('a -v trace still hides a session header by name', () => {
    const r = run(['-v', '-H', `X-Session: ${SHORT}`, 'call', target, 'headers'], env({}));
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stderr.includes(`> X-Session: ${MASK}`), r.stderr);
    assert.ok(r.stdout.includes(SHORT), r.stdout);
  });

  const vars = { MASK_SHORT: SHORT, MASK_LONG: LONG };

  it('-H: a short ${VAR} under a plain name is shown', () => {
    const r = run(['-H', 'X-Debug: ${MASK_SHORT}', 'call', target, 'headers'], env(vars));
    assertShown(r.stdout);
  });

  it('-H: a long ${VAR} under a plain name is masked', () => {
    const r = run(['-H', 'X-Debug: ${MASK_LONG}', 'call', target, 'headers'], env(vars));
    assertMasked(r.stdout, LONG);
  });

  it('-H: a short ${VAR} under a credential-like name is masked', () => {
    const r = run(['-H', 'X-Api-Key: ${MASK_SHORT}', 'call', target, 'headers'], env(vars));
    assertMasked(r.stdout, SHORT);
  });

  const configCases = {
    plain: assertShown,
    'short-var': assertShown,
    credential: (text) => assertMasked(text, SHORT),
    'credential-var': (text) => assertMasked(text, SHORT),
    long: (text) => assertMasked(text, LONG),
    'long-var': (text) => assertMasked(text, LONG),
  };

  for (const [server, check] of Object.entries(configCases)) {
    it(`mcp.json: ${server} in a result`, () => {
      const r = run(['call', server, 'headers'], env(vars));
      assert.equal(r.status, 0, r.stderr);
      check(r.stdout);
    });

    it(`mcp.json: ${server} in an error`, () => {
      check(run(['call', server, 'err'], env(vars)).stderr);
    });

    it(`mcp.json: ${server} in the code verb`, () => {
      const source = `console.log(await tools.mcp__${server.replace('-', '_')}__headers({}));`;
      const r = run(['code', '-e', source, '--server', server], env(vars));
      assert.equal(r.status, 0, r.stderr);
      check(output(r));
    });
  }
});
