import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { startHolder } from '../../src/serve/webmcp-polyfill.ts';

const terminal = [
  "slicc: refused: target is on seven's origin",
  'slicc: refused: seven’s own pages and the vault are out of reach of browser automation',
  'Debugger.enable: slicc: refused: breakpoints could run in seven’s pages or the vault, so the guard doesn’t offer the Debugger domains',
  'playwright-cli webmcp-polyfill: slicc: refused: update the browser guard and client',
  'slicc: refused: WebMCP installation could not verify the document; update the browser guard and client',
  'Runtime.evaluate: slicc: refused: WebMCP installation could not verify a usable guard and document; update the browser guard and client',
  'slicc: refused: WebMCP instrumentation is unavailable; update the browser guard and client',
  'webmcp-polyfill: other-extension fallback could not verify the reloaded document; tools are unavailable',
  'webmcp-polyfill: other-extension fallback could not verify the document',
  'webmcp: no tools are available through the other-extension fallback; page startup or parse-time checks may have happened before installation',
];
const retryable = [
  'webmcp-polyfill: Runtime.evaluate: slicc: refused: WebMCP target closed, changed or was refused by the guard; tools cannot be verified',
  'slicc: refused: WebMCP holder disappeared',
  'Runtime.evaluate: slicc: refused: renderer crashed',
  'slicc: refused: some other temporary check',
];
const turn = () => new Promise((resolve) => setImmediate(resolve));
const stream = (text) => new Blob([text]).stream();

for (const ready of [false, true]) {
  for (const [final, lines] of [
    [true, terminal],
    [false, retryable],
  ]) {
    for (const line of lines) {
      test(`holder ${final ? 'stops' : 'restarts with backoff'} with ready=${ready}: ${line}`, async (t) => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const reports = [];
        const starts = [];
        let secondExit;
        const holder = startHolder(
          {
            async spawn(options) {
              starts.push(options.argv);
              const first = starts.length === 1;
              return {
                stdin: new WritableStream(),
                stdout: stream(ready || !first ? '{"event":"ready","mode":"polyfill"}\n' : ''),
                stderr: stream(first ? `${line}\n` : ''),
                wait: first
                  ? async () => ({ status: 1 })
                  : () =>
                      new Promise((resolve) => {
                        secondExit = resolve;
                      }),
              };
            },
          },
          {
            playwrightCli: 'memory-only',
            tab: 'ordinary',
            reload: true,
            readyTimeoutMs: 100,
            report: (text) => reports.push(text),
          }
        );
        t.after(async () => {
          secondExit?.({ status: 0 });
          await holder.stop();
        });
        await holder.ready();
        await turn();
        assert.equal(starts.length, 1);
        if (final) {
          assert.equal(holder.status().refused, true);
          assert.equal(holder.status().error, line);
          t.mock.timers.tick(60000);
          await turn();
          assert.equal(starts.length, 1);
          assert.equal(reports.length, 1);
          assert.match(reports[0], /retrying won't help/);
        } else {
          assert.notEqual(holder.status().refused, true);
          t.mock.timers.tick(499);
          await turn();
          assert.equal(starts.length, 1);
          t.mock.timers.tick(1);
          await turn();
          assert.equal(starts.length, 2);
          assert.equal(starts[0].includes('--reload'), true);
          assert.equal(starts[1].includes('--reload'), false);
          assert.ok(reports.some((text) => /restarting in 1s/.test(text)));
          assert.ok(reports.every((text) => !text.includes("retrying won't help")));
        }
      });
    }
  }
}
