import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { homeEnv, launch, scratchHome, startFixture } from './helpers/rows.mjs';

const MARK = 'proxyVarSecretQ7v3Zk9';
const ID = 'proxyIdPfx01';
const SUFFIX = 'SuffixLeak77';
const SHORT = 'zq7';
const LONG = 'zq7longer9';
const vars = {
  PROXY_TOK: MARK,
  PROXY_ID: ID,
  PROXY_KEY: `${ID}${SUFFIX}`,
  PROXY_HEAD: 'ShiftHeadQ7v',
  PROXY_TAIL: 'JK',
  PROXY_SHIFT: 'hiftHeadQ7vJK',
  PROXY_SHORT: 'abc1234',
};

async function startProxy(args, env) {
  const child = launch(['serve', '--proxy', ...args, '--http', '0', '--no-auth', '--json'], {
    env,
  });
  const line = await new Promise((resolve, reject) => {
    child.stdout.on('data', () => {
      const nl = child.out.indexOf('\n');
      if (nl >= 0) resolve(child.out.slice(0, nl));
    });
    child.on('exit', (code) => reject(new Error(`proxy exited ${code}: ${child.err}`)));
  });
  return { child, url: JSON.parse(line).url };
}

async function call(url, name) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name } }),
  });
  return res.text();
}

describe('proxy: hides each ${VAR} value of a header', () => {
  let up;
  let envUsed;
  const proxies = {};

  before(async () => {
    up = await startFixture('reflect-server.mjs');
    const home = scratchHome('proxy-vars');
    writeFileSync(
      join(home, '.pi/agent/mcp.json'),
      JSON.stringify({
        mcpServers: {
          tok: { url: `${up.base}/tok/mcp`, headers: { Authorization: 'Bearer ${PROXY_TOK}' } },
          short: { url: `${up.base}/tok/mcp`, headers: { 'X-Key': '${PROXY_SHORT}' } },
          'rule-plain': { url: `${up.base}/mcp`, headers: { 'X-Debug': SHORT } },
          'rule-credential': { url: `${up.base}/mcp`, headers: { 'X-Api-Key': SHORT } },
          'rule-long': { url: `${up.base}/mcp`, headers: { 'X-Debug': LONG } },
          unset: {
            url: `${up.base}/tok/mcp`,
            headers: { Authorization: 'Bearer ${PROXY_UNSET}', 'X-Other': '${PROXY_ID}' },
          },
        },
      })
    );
    const env = homeEnv(home, vars);
    envUsed = env;
    const target = `${up.base}/tok/mcp`;
    proxies.header = await startProxy([target, '-H', 'Authorization: Bearer ${PROXY_TOK}'], env);
    proxies.config = await startProxy(['tok'], env);
    for (const n of [0, 4, 8, 12, 16]) {
      const pad = n === 0 ? [] : ['-H', `X-A: ${'p'.repeat(n)}`];
      proxies[`cut${n}`] = await startProxy(
        [`${up.base}/401`, ...pad, '-H', 'X-Api: ${PROXY_TOK}'],
        env
      );
    }
    proxies.short = await startProxy(['short'], env);
    proxies.shifted = await startProxy(
      [
        target,
        '-H',
        'Authorization: Bearer ${PROXY_HEAD}${PROXY_TAIL}',
        '-H',
        'X-Shift: ${PROXY_SHIFT}',
      ],
      env
    );
    proxies.nested = await startProxy(
      [target, '-H', 'X-Id: ${PROXY_ID}', '-H', 'X-Key: ${PROXY_KEY}'],
      env
    );
    const open = `${up.base}/mcp`;
    proxies.plainHeader = await startProxy([open, '-H', `X-Debug: ${SHORT}`], env);
    proxies.credentialHeader = await startProxy([open, '-H', `X-Api-Key: ${SHORT}`], env);
    proxies.longHeader = await startProxy([open, '-H', `X-Debug: ${LONG}`], env);
    proxies.plainConfig = await startProxy(['rule-plain'], env);
    proxies.credentialConfig = await startProxy(['rule-credential'], env);
    proxies.longConfig = await startProxy(['rule-long'], env);
  });

  after(() => {
    for (const p of Object.values(proxies)) p.child.kill('SIGTERM');
    up?.child.kill('SIGTERM');
  });

  for (const via of ['header', 'config']) {
    for (const tool of ['headers', 'err']) {
      it(`never returns the token: ${via}, ${tool}`, async () => {
        const text = await call(proxies[via].url, tool);
        assert.ok(!text.includes(MARK), text);
        assert.ok(text.includes('token ***'), text);
      });
    }
  }

  for (const tool of ['headers', 'err']) {
    it(`never returns the suffix of a longer value: ${tool}`, async () => {
      const text = await call(proxies.nested.url, tool);
      assert.ok(!text.includes(SUFFIX), text);
      assert.ok(text.includes('key ***'), text);
    });
  }

  for (const tool of ['headers', 'err']) {
    it(`never returns the tail of a value that overlaps another: ${tool}`, async () => {
      const text = await call(proxies.shifted.url, tool);
      assert.ok(text.includes('token *** key'), text);
    });
  }

  it('never returns the token in a structured result, as a value or a key', async () => {
    const text = await call(proxies.header.url, 'rich');
    assert.ok(!text.includes(MARK), text);
    assert.ok(text.includes('token ***'), text);
  });

  it('redacts an upstream error body before it truncates it', async () => {
    for (const n of [0, 4, 8, 12, 16]) {
      const text = await call(proxies[`cut${n}`].url, 'echo');
      assert.ok(text.includes('authentication required'), text);
      assert.ok(!text.includes(MARK.slice(0, 6)), `a prefix leaked (pad ${n}):\n${text}`);
    }
  });

  for (const tool of ['headers', 'err']) {
    it(`never returns a short mcp.json header value: ${tool}`, async () => {
      const text = await call(proxies.short.url, tool);
      assert.ok(!text.includes('abc1234'), text);
      assert.ok(text.includes('key ***'), text);
    });
  }

  for (const via of ['Header', 'Config']) {
    for (const tool of ['headers', 'err']) {
      it(`shows a short value under a plain name: ${via}, ${tool}`, async () => {
        const text = await call(proxies[`plain${via}`].url, tool);
        assert.ok(text.includes(SHORT), text);
        assert.ok(!text.includes('***'), text);
      });

      it(`masks a short value under a credential-like name: ${via}, ${tool}`, async () => {
        const text = await call(proxies[`credential${via}`].url, tool);
        assert.ok(!text.includes(SHORT), text);
        assert.ok(text.includes('***'), text);
      });

      it(`masks a plain value of 8 or more characters: ${via}, ${tool}`, async () => {
        const text = await call(proxies[`long${via}`].url, tool);
        assert.ok(!text.includes(LONG), text);
        assert.ok(text.includes('***'), text);
      });
    }
  }

  const unsetCases = {
    'mcp.json': () => ['unset'],
    '-H': () => [
      `${up.base}/tok/mcp`,
      '-H',
      'Authorization: Bearer ${PROXY_UNSET}',
      '-H',
      'X-Other: ${PROXY_ID}',
    ],
  };

  for (const [via, args] of Object.entries(unsetCases)) {
    it(`refuses a header with an unset \${VAR}: ${via}`, async () => {
      const before = (await (await fetch(`${up.base}/seen`)).json()).length;
      const child = launch(['serve', '--proxy', ...args(), '--http', '0', '--no-auth', '--json'], {
        env: envUsed,
      });
      const timer = setTimeout(() => child.kill('SIGTERM'), 10_000);
      const { code } = await child.done;
      clearTimeout(timer);
      assert.equal(code, 2, child.err);
      assert.match(child.err, /unset variable PROXY_UNSET in header 'Authorization'/);
      assert.ok(!child.err.includes(ID), child.err);
      assert.equal(child.out, '');
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
