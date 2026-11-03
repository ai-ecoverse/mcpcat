import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createWebMcpHandler } from '../../src/serve/webmcp.ts';

const hint =
  'webmcp: no tools are available through the other-extension fallback; page startup or parse-time checks may have happened before installation';

for (const message of [
  hint,
  'Runtime.evaluate: slicc: refused: protected document',
  `page says ${hint}`,
]) {
  test(`675 empty fallback has an array and a hint without hiding unrelated errors: ${message}`, async (t) => {
    const stream = (text) =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(text));
          controller.close();
        },
      });
    const handler = createWebMcpHandler(
      {
        async spawn({ argv }) {
          assert.equal(argv[1], 'webmcp-list');
          return {
            stdin: new WritableStream(),
            stdout: stream(''),
            stderr: stream(`${message}\n`),
            wait: async () => ({ status: 1 }),
          };
        },
      },
      {
        playwrightCli: 'fixture',
        tab: 'ordinary',
        allowConsequential: false,
        ttlMs: 0,
        callTimeoutMs: 1000,
        maxOutput: 65536,
      }
    );
    t.after(() => handler.close());
    const result = await handler.getRpcTools();
    assert.deepEqual(result.tools, []);
    if (message === hint) {
      assert.equal(result.error, undefined);
      assert.equal(result.hint, hint);
    } else {
      assert.equal(result.error, `${message}\n`);
      assert.equal(result.hint, undefined);
    }
  });
}
