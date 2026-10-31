import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { startHolder } from '../../src/serve/webmcp-polyfill.ts';

const refused =
  'Debugger.setInstrumentationBreakpoint: slicc: refused: a browser extension runs scripts in this page';

test('675 a terminal refusal after readiness stops the actual holder restart loop', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let starts = 0;
  let fail;
  let finish;
  const reports = [];
  const encoder = new TextEncoder();
  const platform = {
    async spawn() {
      starts++;
      return {
        stdin: new WritableStream(),
        stdout: new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode('{"event":"ready","mode":"polyfill"}\n'));
            controller.close();
          },
        }),
        stderr: new ReadableStream({
          start(controller) {
            fail = () => {
              controller.enqueue(encoder.encode(`${refused}\n`));
              controller.close();
            };
          },
        }),
        wait: () =>
          new Promise((resolve) => {
            finish = () => resolve({ status: 1 });
          }),
      };
    },
  };
  const holder = startHolder(platform, {
    playwrightCli: 'fixture',
    tab: 'ordinary',
    reload: true,
    readyTimeoutMs: 2000,
    report: (line) => reports.push(line),
  });
  t.after(() => holder.stop());
  await holder.ready();
  assert.equal(holder.status().mode, 'polyfill');
  fail();
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(holder.status().refused, true);
  assert.equal(holder.status().error, refused);
  t.mock.timers.tick(30000);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(starts, 1);
  assert.equal(reports.length, 1);
  assert.match(reports[0], /retrying won't help.*won't restart/);
  assert.doesNotMatch(reports[0], /restarting in/);
});

for (const ready of [false, true]) {
  test(`675 an anchored bare holder refusal is terminal with ready=${ready}`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const line =
      'playwright-cli webmcp-polyfill: slicc: refused: update the browser guard and client';
    let starts = 0;
    const reports = [];
    const stream = (text) =>
      new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(text));
          controller.close();
        },
      });
    const holder = startHolder(
      {
        async spawn() {
          starts++;
          return {
            stdin: new WritableStream(),
            stdout: stream(ready ? '{"event":"ready","mode":"polyfill"}\n' : ''),
            stderr: stream(`${line}\n`),
            wait: async () => ({ status: 1 }),
          };
        },
      },
      {
        playwrightCli: 'fixture',
        tab: 'ordinary',
        reload: true,
        readyTimeoutMs: 2000,
        report: (text) => reports.push(text),
      }
    );
    t.after(() => holder.stop());
    await holder.ready();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(holder.status().refused, true);
    assert.equal(holder.status().error, line);
    t.mock.timers.tick(30000);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(starts, 1);
    assert.equal(reports.length, 1);
    assert.match(reports[0], /retrying won't help.*won't restart/);
    assert.doesNotMatch(reports[0], /restarting in/);
  });
}
