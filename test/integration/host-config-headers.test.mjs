import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { homeEnv, run, scratchHome, startFixture } from './helpers/rows.mjs';

const MARK = 'hostHeaderSecretR4t8Kw2';
const ODD = 'odd"token\\value9';
const CODE = 'console.log(await tools.mcp__s__headers({}));';
const TOKEN = 'Bearer ${MCP_S_TOKEN}';

const argv = {
  grep: () => ['grep', '.'],
  'describe --ts': (server) => ['describe', server, '--ts'],
  code: (server) => ['code', '-e', 'console.log("ran")', '--server', server],
};

const entry = (url) => ({ url, headers: { Authorization: TOKEN } });

function assertHidden({ stdout, stderr }, value = MARK) {
  const encoded = JSON.stringify(value).slice(1, -1);
  for (const text of [stdout, stderr]) {
    assert.ok(!text.includes(value), text);
    assert.ok(!text.includes(encoded), text);
    assert.ok(!text.includes('at file:'), text);
  }
}

describe('host: grep, describe --ts and code expand mcp.json headers', () => {
  let srv;
  let servers;

  const sent = async (path) => {
    const seen = await (await fetch(`${srv.base}/seen`)).json();
    return seen.filter((s) => s.url === path).map((s) => s.headers.authorization);
  };

  before(async () => {
    srv = await startFixture('reflect-server.mjs');
    servers = {
      s: entry(`${srv.base}/tok/mcp?plain`),
      modern: entry(`${srv.base}/tok/ask-modern`),
      listed: entry(`${srv.base}/tok/listed`),
      modernlisted: entry(`${srv.base}/tok/ask-listed`),
      badlist: entry(`${srv.base}/tok/badlist`),
      modernbad: entry(`${srv.base}/tok/ask-badlist`),
      down: entry(`${srv.base}/tok/500`),
      denied: entry(`${srv.base}/tok/401`),
      long: entry(`${srv.base}/tok/long500`),
      unset: { url: `${srv.base}/tok/mcp?unset`, headers: { Authorization: '${MCP_NOT_SET}' } },
      hdr: { url: `${srv.base}/mcp?hdr` },
      json: entry(`${srv.base}/mcp?json`),
      jsonlisted: entry(`${srv.base}/listed-json`),
      jsondown: entry(`${srv.base}/500-json`),
      jsonbad: entry(`${srv.base}/badlist-json`),
    };
  });

  const only = (names, token = MARK) => {
    const home = scratchHome('host-headers');
    const mcpServers = Object.fromEntries(names.map((name) => [name, servers[name]]));
    writeFileSync(join(home, '.pi/agent/mcp.json'), JSON.stringify({ mcpServers }));
    return { env: homeEnv(home, { MCP_S_TOKEN: token }) };
  };

  after(() => srv?.child.kill('SIGTERM'));

  for (const [verb, args] of Object.entries(argv)) {
    it(`${verb}: the server receives the expanded header`, async () => {
      const r = run(args('s'), only(['s']));
      assert.equal(r.status, 0, r.stderr);
      const headers = await sent('/tok/mcp?plain');
      assert.ok(headers.length > 0);
      assert.ok(headers.every((h) => h === `Bearer ${MARK}`));
      assertHidden(r);
    });

    it(`${verb}: a modern server receives the expanded header`, async () => {
      const r = run(args('modern'), only(['modern']));
      assert.equal(r.status, 0, r.stderr);
      const headers = await sent('/tok/ask-modern');
      assert.ok(headers.length > 0);
      assert.ok(headers.every((h) => h === `Bearer ${MARK}`));
      assertHidden(r);
    });

    it(`${verb}: an HTTP error quoting the header hides the value`, () => {
      const r = run(args('down'), only(['down']));
      assert.match(r.stderr, /connection to down failed/);
      assertHidden(r);
    });

    it(`${verb}: a long error body cut through the value hides all of it`, () => {
      const r = run(args('long'), only(['long']));
      assert.match(r.stderr, /connection to long failed/);
      assert.ok(!r.stderr.includes(MARK.slice(0, 4)), r.stderr);
      assertHidden(r);
    });

    it(`${verb}: a 401 quoting the header hides the value`, () => {
      const r = run(args('denied'), only(['denied']));
      assert.match(r.stderr, /connection to denied failed/);
      assertHidden(r);
    });

    for (const server of ['badlist', 'modernbad']) {
      it(`${verb}: a tools/list failure on ${server} hides the value and exits cleanly`, () => {
        const r = run(args(server), only([server]));
        assert.notEqual(r.status, 0);
        assert.notEqual(r.stderr, '');
        assertHidden(r);
      });
    }

    it(`${verb}: an unset variable warns and sends no header`, async () => {
      const r = run(args('unset'), only(['unset']));
      assert.match(r.stderr, /warning: header "Authorization": unset variable MCP_NOT_SET/);
      assert.ok((await sent('/tok/mcp?unset')).every((h) => h === undefined));
    });

    it(`${verb}: -H expands and hides like the other verbs`, async () => {
      const r = run(['-H', `Authorization: ${TOKEN}`, ...args('hdr')], only(['hdr']));
      assert.equal(r.status, 0, r.stderr);
      assert.ok((await sent('/mcp?hdr')).every((h) => h === `Bearer ${MARK}`));
      assertHidden(r);
    });

    it(`${verb}: -H with an unset variable exits 2 before any request`, async () => {
      const before = (await sent('/mcp?hdr')).length;
      const r = run(['-H', 'X-Api: ${MCP_NOT_SET}', ...args('hdr')], only(['hdr']));
      assert.equal(r.status, 2);
      assert.match(r.stderr, /unset variable in -H: MCP_NOT_SET/);
      assert.equal((await sent('/mcp?hdr')).length, before);
    });
  }

  for (const server of ['listed', 'modernlisted']) {
    it(`grep: a value in a tool name is hidden on ${server}`, () => {
      const r = run(['grep', 'echo'], only([server]));
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /\[REDACTED\]/);
      assertHidden(r);
    });

    it(`grep --rank: a value in a tool name is hidden on ${server}`, () => {
      const r = run(['grep', '--rank', 'echo'], only([server]));
      assert.equal(r.status, 0, r.stderr);
      assertHidden(r);
    });

    it(`describe --ts: a value in a tool listing is hidden on ${server}`, () => {
      for (const token of [MARK, ODD]) {
        const r = run(['describe', server, '--ts'], only([server], token));
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /\[REDACTED\]/);
        assertHidden(r, token);
      }
    });
  }

  it('code: a tool result quoting the header is hidden in text and --json', () => {
    const source = 'return await tools.mcp__s__headers({});';
    for (const token of [MARK, ODD]) {
      for (const extra of [[], ['--json']]) {
        const r = run(['code', ...extra, '-e', source, '--server', 's'], only(['s'], token));
        assert.equal(r.status, 0, r.stderr);
        assert.match(r.stdout, /\[REDACTED\]/);
        assertHidden(r, token);
      }
    }
  });

  describe('a value with characters JSON escapes', () => {
    const RETURNED = 'return await tools.mcp__json__headers({});';
    const LOGGED = 'console.log(await tools.mcp__json__headers({}));';
    const OBJECT = 'console.log({ h: await tools.mcp__json__headers({}) });';
    const WRAPPED = 'return JSON.stringify({ h: await tools.mcp__json__headers({}) });';
    const THROWN = 'throw new Error(await tools.mcp__json__headers({}));';
    const FAILED = 'await tools.mcp__json__err({});';

    const assertEncodingsHidden = ({ stdout, stderr }) => {
      for (const text of [stdout, stderr]) {
        assert.ok(!text.includes('token'), text);
        assert.ok(!text.includes('value9'), text);
      }
    };

    for (const [name, source] of Object.entries({
      'a returned string': RETURNED,
      'a logged string': LOGGED,
      'a logged object': OBJECT,
      'a string encoded again by the script': WRAPPED,
      'a thrown error': THROWN,
      'a failing tool': FAILED,
    })) {
      for (const extra of [[], ['--json']]) {
        it(`code ${extra.join('')}: ${name}`, () => {
          const r = run(['code', ...extra, '-e', source, '--server', 'json'], only(['json'], ODD));
          assert.match(`${r.stdout}${r.stderr}`, /\[REDACTED\]/);
          assertEncodingsHidden(r);
        });
      }
    }

    it('call: a failing tool in text and --json', () => {
      for (const extra of [[], ['--json']]) {
        const r = run([...extra, 'call', 'json', 'err'], only(['json'], ODD));
        assert.notEqual(r.status, 0);
        assert.match(r.stderr, /\[REDACTED\]/);
        assertEncodingsHidden(r);
      }
    });

    it('describe --ts: a tool listing', () => {
      const r = run(['describe', 'jsonlisted', '--ts'], only(['jsonlisted'], ODD));
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /\[REDACTED\]/);
      assertEncodingsHidden(r);
    });

    it('grep: an HTTP error and a listing failure', () => {
      for (const server of ['jsondown', 'jsonbad']) {
        const r = run(['grep', '.'], only([server], ODD));
        assert.match(r.stderr, /\[REDACTED\]/);
        assertEncodingsHidden(r);
      }
    });
  });

  it('code: console output quoting the header is hidden', () => {
    const r = run(['code', '-e', CODE, '--server', 's'], only(['s']));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /\[REDACTED\]/);
    assertHidden(r);
  });

  it('code: a failing tool quoting the header is hidden in text and --json', () => {
    for (const extra of [[], ['--json']]) {
      const source = 'await tools.mcp__s__err({});';
      const r = run(['code', ...extra, '-e', source, '--server', 's'], only(['s']));
      assert.equal(r.status, 1);
      assert.match(`${r.stdout}${r.stderr}`, /bad token \[REDACTED\]/);
      assertHidden(r);
    }
  });

  it('a value of one target stays hidden when a later target fails', () => {
    const r = run(['grep', '.'], only(['listed', 'down']));
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /connection to down failed/);
    assertHidden(r);
  });
});
