import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { homeEnv, run, scratchHome, startFixture } from './helpers/rows.mjs';

describe('security: discovery follows no link, redirect or advertised endpoint', () => {
  let canary;
  let page;
  let env;

  before(async () => {
    canary = await startFixture('reflect-server.mjs');
    page = await startFixture('security-discovery-page.mjs', { CANARY: String(canary.port) });
    env = homeEnv(scratchHome('discovery'));
  });

  after(() => {
    canary?.child.kill('SIGTERM');
    page?.child.kill('SIGTERM');
  });

  for (const args of [
    (u) => ['discover', u],
    (u) => ['discover', '--json', u],
    (u) => ['--json', 'discover', u],
    (u) => ['-v', 'discover', u],
  ]) {
    it(`never reaches the canary: mcpcat ${args('<url>').join(' ')}`, async () => {
      const r = run(args(`${page.base}/`), { env });
      assert.notEqual(r.status, null, 'mcpcat had to be killed');
      const seen = await (await fetch(`${canary.base}/seen`)).json();
      assert.deepEqual(seen, [], `the canary saw ${JSON.stringify(seen)}`);
    });
  }

  it('uses no CDP port', () => {
    for (const port of [canary.port, page.port])
      assert.ok(port < 9222 || port > 9229, `port ${port}`);
  });
});
