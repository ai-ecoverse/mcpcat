import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { homeEnv, launch, scratchHome, startFixture } from './helpers/rows.mjs';

const MARK = 'proxyVarSecretQ7v3Zk9';
const ID = 'proxyIdPfx01';
const SUFFIX = 'SuffixLeak77';
const vars = {
  PROXY_TOK: MARK,
  PROXY_ID: ID,
  PROXY_KEY: `${ID}${SUFFIX}`,
  PROXY_HEAD: 'ShiftHeadQ7v',
  PROXY_TAIL: 'JK',
  PROXY_SHIFT: 'hiftHeadQ7vJK',
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
  const proxies = {};

  before(async () => {
    up = await startFixture('cert-reflect.mjs');
    const home = scratchHome('proxy-vars');
    writeFileSync(
      join(home, '.pi/agent/mcp.json'),
      JSON.stringify({
        mcpServers: {
          tok: { url: `${up.base}/tok/mcp`, headers: { Authorization: 'Bearer ${PROXY_TOK}' } },
        },
      })
    );
    const env = homeEnv(home, vars);
    const target = `${up.base}/tok/mcp`;
    proxies.header = await startProxy([target, '-H', 'Authorization: Bearer ${PROXY_TOK}'], env);
    proxies.config = await startProxy(['tok'], env);
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

  it('sends the expanded mcp.json header upstream', async () => {
    const seen = await (await fetch(`${up.base}/seen`)).json();
    assert.ok(seen.some((e) => e.headers.authorization === `Bearer ${MARK}`));
    assert.ok(!seen.some((e) => (e.headers.authorization ?? '').includes('${')));
  });
});
