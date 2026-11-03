import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { isGuardRefusal } from '../../src/serve/webmcp-polyfill.ts';

test('the exact shipped renderer crash refusal remains restartable under every recognized prefix', () => {
  for (const prefix of [
    '',
    'Runtime.evaluate: ',
    'webmcp-polyfill: Runtime.evaluate: ',
    'playwright-cli webmcp-polyfill: Runtime.evaluate: ',
    'playwright-cli webmcp-polyfill: ',
  ])
    assert.equal(isGuardRefusal(`${prefix}slicc: refused: renderer crashed`), false, prefix);
});

test('renderer restart exception does not turn policy or version refusals into retries', () => {
  for (const body of [
    'renderer crashed again',
    'renderer crashed; protected document',
    'seven’s own pages and the vault are out of reach',
  ])
    assert.equal(isGuardRefusal(`slicc: refused: ${body}`), false, body);
  for (const body of [
    "target is on seven's origin",
    'seven’s own pages and the vault are out of reach of browser automation',
    'update the browser guard and client',
  ])
    assert.equal(isGuardRefusal(`slicc: refused: ${body}`), true, body);
  assert.equal(isGuardRefusal('page says "slicc: refused: renderer crashed"'), false);
});
