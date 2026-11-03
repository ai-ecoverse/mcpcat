import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createKernelPlatform } from '../../src/platform/kernel.ts';
import { startHolder } from '../../src/serve/webmcp-polyfill.ts';

const stream = (text) =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });

test('675 kernel holder reports only the exact PID returned by its own spawn', async () => {
  const reports = [];
  const starts = [];
  let finish;
  const platform = createKernelPlatform({
    env: {},
    cwd: '/',
    fs: {},
    async spawn(options) {
      starts.push(options);
      return {
        pid: 6751,
        stdin: new WritableStream(),
        stdout: stream('{"event":"ready","mode":"polyfill"}\n'),
        stderr: stream(''),
        wait: () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      };
    },
    async kill() {},
  });
  const holder = startHolder(platform, {
    playwrightCli: 'playwright-cli',
    tab: 'owned-tab',
    reload: true,
    readyTimeoutMs: 2000,
    report: (line) => reports.push(line),
  });
  try {
    await holder.ready();
    assert.equal(holder.status().mode, 'polyfill');
    assert.equal(starts.length, 1);
    assert.deepEqual(starts[0].argv, [
      'playwright-cli',
      'webmcp-polyfill',
      '--tab',
      'owned-tab',
      '--reload',
    ]);
    assert.ok(reports.some((line) => /holder-pid 6751 tab owned-tab\n$/.test(line)));
  } finally {
    finish({ status: 0 });
    await holder.stop();
  }
});
