import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch } from '@ai-ecoverse/slicc-shared-web/harness';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const WORLD = 'mcpcat-annotations-previews';
let chrome;
let scripts;

before(async () => {
  const mod = await import(pathToFileURL(join(root, 'src/serve/annotations.ts')).href);
  scripts = mod.pageScripts('mcpcat-annotations-previews', true);
  chrome = await launch({
    roots: [['/', join(root, 'test/integration/fixtures/annotations-page/')]],
    coverage: [],
  });
});

after(() => chrome?.close());

async function open(t) {
  const page = await chrome.page(t);
  const sent = [];
  await page.expose('__mcpcatSend', (message) => sent.push(message));
  await page.send('Runtime.addBinding', { name: '__mcpcatSend', executionContextName: WORLD });
  await page.send('Page.addScriptToEvaluateOnNewDocument', { source: scripts.api });
  await page.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => { const send = (m) => __mcpcatSend(JSON.stringify(m)); ${scripts.editor} })();`,
    worldName: WORLD,
    runImmediately: true,
  });
  await page.goto('/previews.html');
  await page.until(() => document.title === 'ready');
  await page.evaluate(() => document.oai.annotation.toggle(true));
  await page.until(() => document.oai.annotation.isActive());
  return { page, sent };
}

async function arrived(sent, type, count) {
  const deadline = Date.now() + 5000;
  while (sent.filter((m) => m.type === type).length < count && Date.now() < deadline)
    await new Promise((r) => setTimeout(r, 25));
  assert.equal(sent.filter((m) => m.type === type).length, count);
}

async function adjust(page, id, moves) {
  await page.evaluate((target) => {
    document.oai.annotation.request(document.getElementById(target));
  }, id);
  await page.until(() => document.activeElement?.localName === 'mcpcat-annotations');
  for (const [back, right] of moves) {
    for (let i = 0; i < back; i++) await page.press('Tab', 'shift');
    for (let i = 0; i < right; i++) await page.press('ArrowRight');
    for (let i = 0; i < back; i++) await page.press('Tab');
  }
}

async function save(page, sent, id, moves) {
  const before = sent.filter((m) => m.type === 'annotation').length;
  await adjust(page, id, moves);
  await page.press('Enter', 'ctrl');
  await arrived(sent, 'annotation', before + 1);
}

function find(node, label) {
  if (node.localName === 'button' && node.children?.some((c) => c.nodeValue === label)) return node;
  for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) {
    const found = find(child, label);
    if (found) return found;
  }
  return undefined;
}

async function click(page, label) {
  const { root: doc } = await page.send('DOM.getDocument', { depth: -1, pierce: true });
  const button = find(doc, label);
  assert.ok(button, `no ${label} button`);
  const { model } = await page.send('DOM.getBoxModel', { nodeId: button.nodeId });
  const x = (model.content[0] + model.content[2]) / 2;
  const y = (model.content[1] + model.content[5]) / 2;
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  for (const type of ['mousePressed', 'mouseReleased'])
    await page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
}

const previews = (page) => page.evaluate(() => window.previews);

async function settled(page, count) {
  await page.until((n) => window.previews.length >= n, count);
  await new Promise((r) => setTimeout(r, 100));
  const list = await previews(page);
  assert.equal(list.length, count, JSON.stringify(list));
  return list;
}

describe('annotation previews in Chrome', () => {
  it('warms up keyboard input on a first page', async (t) => {
    const page = await chrome.page(t);
    await page.goto('/warm.html');
    await page.until(() => document.title === 'ready');
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      await page.press('a');
      if (await page.evaluate(() => document.getElementById('warm').value.length > 0)) return;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.fail('keyboard input never reached the warm-up page');
  });

  it('resets every saved preview once on Exit, and re-entry and a later Send add nothing else', async (t) => {
    const { page, sent } = await open(t);
    await save(page, sent, 'multi', [
      [2, 1],
      [3, 1],
    ]);
    assert.deepEqual((await settled(page, 2)).sort(), [
      'multi:tall:preview:20',
      'multi:wide:preview:20',
    ]);
    await click(page, 'Exit');
    await page.until(() => !document.oai.annotation.isActive());
    assert.deepEqual((await settled(page, 4)).slice(2).sort(), [
      'multi:tall:reset:10',
      'multi:wide:reset:10',
    ]);
    await page.evaluate(() => document.oai.annotation.toggle(true));
    await page.until(() => document.oai.annotation.isActive());
    assert.deepEqual((await settled(page, 6)).slice(4).sort(), [
      'multi:tall:preview:20',
      'multi:wide:preview:20',
    ]);
    await click(page, 'Exit');
    await page.until(() => !document.oai.annotation.isActive());
    assert.deepEqual((await settled(page, 8)).slice(6).sort(), [
      'multi:tall:reset:10',
      'multi:wide:reset:10',
    ]);
    await click(page, 'Send 1 to agent');
    await arrived(sent, 'submit', 1);
    await settled(page, 8);
  });

  it('does not reset again on Exit after Discard', async (t) => {
    const { page, sent } = await open(t);
    await save(page, sent, 'pad', [[1, 1]]);
    await click(page, 'Discard');
    await arrived(sent, 'discard', 1);
    await click(page, 'Exit');
    await page.until(() => !document.oai.annotation.isActive());
    assert.deepEqual(await settled(page, 2), ['pad:pad:preview:20', 'pad:pad:reset:10']);
  });

  it('keeps a saved preview when a later edit of the same control is cancelled, and resets it once', async (t) => {
    const { page, sent } = await open(t);
    await save(page, sent, 'pad', [[1, 1]]);
    await adjust(page, 'pad', [[1, 2]]);
    await page.press('Escape');
    await settled(page, 3);
    await save(page, sent, 'pad', [[1, 3]]);
    await click(page, 'Exit');
    await page.until(() => !document.oai.annotation.isActive());
    assert.deepEqual(await settled(page, 6), [
      'pad:pad:preview:20',
      'pad:pad:preview:30',
      'pad:pad:preview:20',
      'pad:pad:preview:30',
      'pad:pad:preview:40',
      'pad:pad:reset:10',
    ]);
  });

  it('resets a control the page unregistered once', async (t) => {
    const { page, sent } = await open(t);
    await save(page, sent, 'gone', [[1, 1]]);
    await page.evaluate(() => window.unregister());
    await click(page, 'Exit');
    await page.until(() => !document.oai.annotation.isActive());
    await click(page, 'Send 1 to agent');
    await arrived(sent, 'submit', 1);
    assert.deepEqual(await settled(page, 2), ['gone:size:preview:20', 'gone:size:reset:10']);
  });
});
