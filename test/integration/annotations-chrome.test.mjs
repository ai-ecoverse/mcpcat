import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { launch } from '@ai-ecoverse/slicc-shared-web/harness';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const WORLD = 'mcpcat-annotations-test';
let chrome;
let scripts;

before(async () => {
  const mod = await import(pathToFileURL(join(root, 'src/serve/annotations.ts')).href);
  scripts = mod.pageScripts('mcpcat-annotations-chrome', true);
  chrome = await launch({
    roots: [['/', join(root, 'test/integration/fixtures/annotations-page/')]],
    coverage: [],
  });
});

after(() => chrome?.close());

async function open(t, path = '/') {
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
  await page.goto(path);
  await page.until(() => document.title === 'ready');
  return { page, sent };
}

describe('annotations in Chrome', () => {
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

  it('keeps what the user types in the editor from page key and input listeners', async (t) => {
    const { page, sent } = await open(t);
    const accepted = await page.evaluate(() => {
      const el = document.getElementById('target');
      return document.oai.annotation.request(el, { initialComment: '' }).accepted;
    });
    assert.equal(accepted, true);
    await page.until(() => document.activeElement?.localName === 'mcpcat-annotations');
    await page.type('PRIVATE');
    await page.insert(' secret');
    const seen = await page.evaluate(() => window.seen);
    assert.deepEqual(seen, []);
    await page.press('Enter', 'meta');
    await page.press('Enter', 'ctrl');
    const deadline = Date.now() + 5000;
    while (!sent.some((m) => m.type === 'annotation') && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 50));
    const saved = sent.find((m) => m.type === 'annotation');
    assert.equal(saved?.annotation.comment, 'PRIVATE secret');
    await page.type('x');
    assert.ok((await page.evaluate(() => window.seen)).includes('keydown:x'));
  });

  it('holds a request the page makes before the editor attaches', async (t) => {
    const { page, sent } = await open(t, '/?startup');
    assert.deepEqual(await page.evaluate(() => window.early), { accepted: true });
    await page.until(() => document.activeElement?.localName === 'mcpcat-annotations');
    await page.press('Enter', 'ctrl');
    const deadline = Date.now() + 5000;
    while (!sent.some((m) => m.type === 'annotation') && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 50));
    const saved = sent.find((m) => m.type === 'annotation');
    assert.equal(saved?.annotation.comment, 'from startup');
    assert.equal(saved?.annotation.target.selector, 'p#target');
  });

  it('keeps text fields selectable in Annotation mode', async (t) => {
    const { page } = await open(t);
    await page.evaluate(() => document.oai.annotation.toggle(true));
    await page.until(() => document.oai.annotation.isActive());
    const box = await page.evaluate(() => {
      const r = document.getElementById('field').getBoundingClientRect();
      return { x: r.left + 4, y: r.top + r.height / 2, end: r.right - 4 };
    });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    await page.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: box.x,
      y: box.y,
      button: 'left',
      clickCount: 1,
    });
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: box.end,
      y: box.y,
      button: 'left',
    });
    await page.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: box.end,
      y: box.y,
      button: 'left',
      clickCount: 1,
    });
    const state = await page.evaluate(() => {
      const f = document.getElementById('field');
      return { focused: document.activeElement === f, selected: f.selectionEnd - f.selectionStart };
    });
    assert.equal(state.focused, true);
    assert.ok(state.selected > 0);
  });

  it('resets saved control previews on exit and reapplies them on re-entry', async (t) => {
    const { page, sent } = await open(t);
    await page.evaluate(() => document.oai.annotation.toggle(true));
    await page.evaluate(() => document.oai.annotation.request(document.getElementById('control')));
    const ok = await page.evaluate(() => {
      const host = document.querySelector('mcpcat-annotations');
      return Boolean(host);
    });
    assert.equal(ok, true);
    await page.until(() => document.activeElement?.localName === 'mcpcat-annotations');
    await page.press('Tab', 'shift');
    await page.press('ArrowRight');
    await page.press('Tab');
    await page.insert('wider');
    await page.press('Enter', 'meta');
    await page.press('Enter', 'ctrl');
    const deadline = Date.now() + 5000;
    while (!sent.some((m) => m.type === 'annotation') && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 50));
    const saved = sent.find((m) => m.type === 'annotation');
    assert.deepEqual(
      saved?.annotation.controls.map((c) => [c.previous, c.value]),
      [[10, 20]]
    );
    await page.evaluate(() => document.oai.annotation.toggle(false));
    await page.until(() => !document.oai.annotation.isActive());
    assert.deepEqual(await page.evaluate(() => window.previews), ['preview:20', 'reset:10']);
    await page.evaluate(() => document.oai.annotation.toggle(true));
    await page.until(() => document.oai.annotation.isActive());
    assert.deepEqual(await page.evaluate(() => window.previews), [
      'preview:20',
      'reset:10',
      'preview:20',
    ]);
  });
});
