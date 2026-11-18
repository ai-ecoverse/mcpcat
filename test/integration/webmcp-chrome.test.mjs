import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { after, before, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { launch } from '@ai-ecoverse/slicc-shared-web/harness';
import { createNodeKernel } from './helpers/kernel.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
let chrome;
let kernel;

before(async () => {
  chrome = await launch({
    roots: [['/', join(root, 'test/integration/fixtures/webmcp-page')]],
    coverage: [],
    extension: false,
    args: ['--disable-blink-features=WebMCP'],
  });
  const [port, endpoint] = readFileSync(join(chrome.profile, 'DevToolsActivePort'), 'utf8')
    .trim()
    .split('\n');
  kernel = await createNodeKernel({
    cdp: () =>
      new Promise((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}${endpoint}`);
        const connection = {
          send: (message) => socket.send(message),
          onmessage: null,
          onclose: null,
          close: () => socket.close(),
        };
        socket.onmessage = (event) => connection.onmessage?.(String(event.data));
        socket.onclose = () => connection.onclose?.();
        socket.onerror = reject;
        socket.onopen = () => resolve(connection);
      }),
  });
  for (const name of ['mcpcat', 'slicc-cdp']) {
    const base = name === 'mcpcat' ? root : join(root, 'node_modules/@ai-ecoverse/slicc-cdp');
    const file = name === 'mcpcat' ? 'dist/kernel/mcpcat.mjs' : 'bin/playwright-cli.wasm';
    const slicc =
      name === 'mcpcat'
        ? { commands: { mcpcat: { abi: 'js', module: file } } }
        : { abi: 'wasi', commands: { 'playwright-cli': { wasm: file } } };
    await kernel.writeFile(
      `/node_modules/@ai-ecoverse/${name}/${file}`,
      readFileSync(join(base, file))
    );
    await kernel.writeFile(
      `/node_modules/@ai-ecoverse/${name}/package.json`,
      JSON.stringify({ name: `@ai-ecoverse/${name}`, version: '1.52.0', type: 'module', slicc })
    );
  }
});

after(async () => {
  kernel?.terminate();
  await chrome?.close();
});

it('warms up the first Chrome page', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  await page.until(() => document.title === 'ready');
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await page.press('a');
    if (await page.evaluate(() => document.getElementById('warm').value.length > 0)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail('keyboard input never reached the warm-up page');
});

it('lists and calls a tool registered by the first inline head script through serve --webmcp', {
  timeout: 60000,
}, async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  await page.until(() => document.title === 'ready');
  assert.equal(await page.evaluate(() => window.parseTimeWebMcp), false);
  const { targetInfos } = await chrome.cdp.send('Target.getTargets');
  const tab = targetInfos.find((target) => target.url === new URL('/', chrome.url).href).targetId;
  const messages = [
    { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
    {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'head_tool', arguments: { value: 'from head' } },
    },
  ];
  const result = await kernel.run(
    ['mcpcat', 'serve', '--webmcp', '--webmcp-reload', '--tab', tab, '--call-timeout', '10'],
    {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: `${messages.map((message) => JSON.stringify(message)).join('\n')}\n`,
    }
  );
  assert.equal(result.status, 0, result.stderr);
  const replies = result.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    replies.find((reply) => reply.id === 1).result.tools.map((tool) => tool.name),
    ['head_tool'],
    result.stderr
  );
  const called = replies.find((reply) => reply.id === 2);
  assert.match(called.result.content[0].text, /^<<untrusted-page-content/);
  assert.match(called.result.content[0].text, /"echoed":"from head","atParseTime":true/);
  assert.equal(await page.evaluate(() => window.parseTimeWebMcp), true);
});

async function servePage(t, path, messages) {
  const page = await chrome.page(t);
  await page.goto(path);
  await page.until(() => document.title === 'ready');
  const { targetInfos } = await chrome.cdp.send('Target.getTargets');
  const tab = targetInfos.find((target) => target.url === new URL(path, chrome.url).href).targetId;
  const result = await kernel.run(
    [
      'mcpcat',
      'serve',
      '--webmcp',
      '--webmcp-reload',
      '--webmcp-ttl',
      '0',
      '--tab',
      tab,
      '--call-timeout',
      '10',
    ],
    {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: `${messages.map((message, i) => JSON.stringify({ jsonrpc: '2.0', id: i + 1, ...message })).join('\n')}\n`,
    }
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

it('merges same-origin child tools and routes their calls in the main-world page bridge', async (t) => {
  const { webMcpScript } = await import('../../src/serve/webmcp-attach.ts');
  const page = await chrome.page(t);
  await page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => { const send = () => {}; ${webMcpScript('testPageBridge', true)} })()`,
  });
  await page.goto('/frames.html');
  await page.until(() => document.title === 'ready');
  const reply = await page.evaluate(async () => {
    await document.modelContext.executeTool('parent_ready', {});
    const tools = (await globalThis.testPageBridge.refresh()).tools;
    const called = await globalThis.testPageBridge.call(
      'child_tool',
      { message: 'from child' },
      false,
      location.origin
    );
    return { tools, called };
  });
  assert.deepEqual(
    reply.tools.map((tool) => tool.name),
    ['child_tool', 'parent_ready']
  );
  assert.equal(reply.called.__webmcp_result, '{"child":"from child"}');
});

it('switches listings and calls to a page replacement without executing detached registrations', async (t) => {
  const replies = await servePage(t, '/replacement.html', [
    { method: 'tools/list', params: {} },
    { method: 'tools/call', params: { name: 'replacement', arguments: {} } },
    { method: 'tools/call', params: { name: 'detached', arguments: {} } },
  ]);
  assert.deepEqual(
    replies[0].result.tools.map((tool) => tool.name),
    ['replacement']
  );
  assert.match(replies[1].result.content[0].text, /current API/);
  assert.ok(replies[2].error || replies[2].result.isError);
});
