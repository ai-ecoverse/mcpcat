import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebMcpHandler } from '../../src/serve/webmcp.ts';
import { startHolder } from '../../src/serve/webmcp-polyfill.ts';

const FALLBACK_UNVERIFIED =
  'webmcp: other-extension fallback could not verify the reloaded document; tools are unavailable';

const bytes = (text) => new Blob([text]).stream();

test('a terminal fallback replay refusal lists an empty array and the clear hint, never an unverified RPC error', async (t) => {
  let starts = 0;
  const holder = startHolder(
    {
      async spawn() {
        starts++;
        return {
          stdin: new WritableStream(),
          stdout: bytes(''),
          stderr: bytes(
            'webmcp-polyfill: other-extension fallback could not verify the reloaded document; tools are unavailable\nTarget.attachToTarget: slicc: refused: seven’s own pages and the vault are out of reach of browser automation\n'
          ),
          wait: async () => ({ status: 1 }),
        };
      },
    },
    { playwrightCli: 'fixture', tab: 'owned', reload: true, readyTimeoutMs: 100, report() {} }
  );
  t.after(() => holder.stop());
  const handler = createWebMcpHandler(
    {
      async spawn() {
        return {
          stdin: new WritableStream(),
          stdout: bytes(''),
          stderr: bytes('webmcp: unverified isolated context\n'),
          wait: async () => ({ status: 1 }),
        };
      },
    },
    {
      playwrightCli: 'fixture',
      allowConsequential: false,
      ttlMs: 0,
      callTimeoutMs: 100,
      maxOutput: 65536,
      beforeList: () => holder.ready(),
      emptyHint: () =>
        holder.status().refused && holder.status().fallbackUnavailable
          ? FALLBACK_UNVERIFIED
          : undefined,
    }
  );
  t.after(() => handler.close());
  await new Promise((resolve) => setImmediate(resolve));
  const listing = await handler.getRpcTools();
  assert.deepEqual(listing, { tools: [], hint: FALLBACK_UNVERIFIED });
  assert.doesNotMatch(JSON.stringify(listing), /unverified isolated context/);
  assert.equal(starts, 1);
  assert.equal(holder.status().refused, true);
});
