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
  await page.goto('/');
  await page.until(() => document.title === 'ready');
  return { page, sent };
}

describe('annotations in Chrome', () => {
  it('keeps what the user types in the editor from page key and input listeners', async (t) => {
    const { page, sent } = await open(t);
    const accepted = await page.evaluate(() => {
      const el = document.getElementById('target');
      return document.oai.annotation.request(el, { initialComment: '' }).accepted;
    });
    assert.equal(accepted, true);
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

  it('resets saved control previews on exit and reapplies them on re-entry', async (t) => {
    const { page, sent } = await open(t);
    await page.evaluate(() => document.oai.annotation.toggle(true));
    await page.evaluate(() => document.oai.annotation.request(document.getElementById('control')));
    const ok = await page.evaluate(() => {
      const host = document.querySelector('mcpcat-annotations');
      return Boolean(host);
    });
    assert.equal(ok, true);
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
