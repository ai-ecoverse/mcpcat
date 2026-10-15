import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { filesUnder, homeEnv, run, scratchHome, startFixture } from './helpers/rows.mjs';

const MARK = 'certrowSecretQ7v3Zk9';

describe('cert row: secrets redaction', () => {
  let srv;
  let home;
  let env;
  const header = ['-H', 'X-Api: ${CERT_ROW_TOKEN}'];

  before(async () => {
    srv = await startFixture('cert-reflect.mjs');
    home = scratchHome('secrets');
    env = homeEnv(home, { CERT_ROW_TOKEN: MARK });
    writeFileSync(
      join(home, '.pi/agent/mcp.json'),
      JSON.stringify({
        mcpServers: {
          r: { url: `${srv.base}/mcp`, headers: { 'X-Api': '${CERT_ROW_TOKEN}' } },
          r500: { url: `${srv.base}/500`, headers: { 'X-Api': '${CERT_ROW_TOKEN}' } },
          r403: { url: `${srv.base}/403`, headers: { 'X-Api': '${CERT_ROW_TOKEN}' } },
          r401: { url: `${srv.base}/401`, headers: { 'X-Api': '${CERT_ROW_TOKEN}' } },
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

  it('delivers the expanded value to the server', async () => {
    const r = run([...header, 'call', `${srv.base}/mcp`, 'echo', '-d', '{"message":"x"}'], { env });
    assert.equal(r.status, 0, r.stderr);
    const seen = await (await fetch(`${srv.base}/seen`)).json();
    assert.ok(seen.some((e) => e.headers['x-api'] === MARK));
  });

  it('refuses an unset ${VAR} with exit 2', () => {
    const r = run(['-H', 'X-Api: ${CERT_ROW_UNSET}', 'call', `${srv.base}/mcp`, 'echo'], { env });
    assert.equal(r.status, 2, r.stderr);
  });

  it('writes the value to no file and keeps ${VAR} in mcp.json', () => {
    const hits = filesUnder(home).filter((p) => readFileSync(p).includes(MARK));
    assert.deepEqual(hits, []);
    assert.ok(readFileSync(join(home, '.pi/agent/mcp.json'), 'utf8').includes('${CERT_ROW_TOKEN}'));
  });
});
