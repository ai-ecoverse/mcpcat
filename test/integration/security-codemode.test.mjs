import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { describe, it } from 'node:test';
import { homeEnv, run, scratchHome } from './helpers/rows.mjs';

const GLOBALS = [
  'ALL_TOOLS',
  'AggregateError',
  'Array',
  'ArrayBuffer',
  'AsyncDisposableStack',
  'BigInt',
  'BigInt64Array',
  'BigUint64Array',
  'Boolean',
  'DOMException',
  'DataView',
  'Date',
  'DisposableStack',
  'Error',
  'EvalError',
  'FinalizationRegistry',
  'Float16Array',
  'Float32Array',
  'Float64Array',
  'Function',
  'Infinity',
  'Int16Array',
  'Int32Array',
  'Int8Array',
  'InternalError',
  'Iterator',
  'JSON',
  'Map',
  'Math',
  'NaN',
  'Number',
  'Object',
  'Promise',
  'Proxy',
  'RangeError',
  'ReferenceError',
  'Reflect',
  'RegExp',
  'Set',
  'SharedArrayBuffer',
  'String',
  'SuppressedError',
  'Symbol',
  'SyntaxError',
  'TypeError',
  'URIError',
  'Uint16Array',
  'Uint32Array',
  'Uint8Array',
  'Uint8ClampedArray',
  'WeakMap',
  'WeakRef',
  'WeakSet',
  'atob',
  'btoa',
  'console',
  'decodeURI',
  'decodeURIComponent',
  'describeNamespace',
  'describeTool',
  'encodeURI',
  'encodeURIComponent',
  'escape',
  'eval',
  'exit',
  'globalThis',
  'image',
  'isFinite',
  'isNaN',
  'load',
  'parseFloat',
  'parseInt',
  'performance',
  'queueMicrotask',
  'searchTools',
  'store',
  'text',
  'tools',
  'undefined',
  'unescape',
];
const GLOBALS_SHA256 = 'caa531137fdd8ea55ae67152588b3e93c80f3f9d7e3e787bdd44449f45ca4015';

const env = homeEnv(scratchHome('codemode'));
const code = (script, extra = []) => run([...extra, 'code', '--json', '-e', script], { env });
const value = (r) => JSON.parse(r.stdout).value;

describe('security: the code-mode sandbox', () => {
  it('exposes exactly the pinned globals', () => {
    const r = code('return Object.getOwnPropertyNames(globalThis).sort().join(",")');
    assert.equal(r.status, 0, r.stderr);
    const names = value(r);
    assert.deepEqual(names.split(','), GLOBALS);
    assert.equal(createHash('sha256').update(names).digest('hex'), GLOBALS_SHA256);
  });

  for (const [name, script] of [
    [
      'the Function constructor',
      'return (function(){}).constructor("return [typeof process, typeof require, typeof fetch, typeof Deno, typeof Bun].join()")()',
    ],
    [
      'Function()',
      'return Function("return [typeof process, typeof require, typeof fetch, typeof Deno, typeof Bun].join()")()',
    ],
    [
      'eval',
      'return eval("[typeof process, typeof require, typeof fetch, typeof Deno, typeof Bun].join()")',
    ],
    [
      'an async function constructor',
      'return await (async function(){}).constructor("return [typeof process, typeof require, typeof fetch, typeof Deno, typeof Bun].join()")()',
    ],
  ]) {
    it(`gives ${name} no host objects`, () => {
      const r = code(script);
      assert.equal(r.status, 0, r.stderr);
      assert.equal(value(r), 'undefined,undefined,undefined,undefined,undefined');
    });
  }

  for (const spec of [
    'fs',
    'node:fs',
    'node:child_process',
    'http://127.0.0.1:1/x.js',
    'data:text/javascript,export default 1',
  ]) {
    it(`blocks import("${spec}")`, () => {
      const r = code(`const m = await import(${JSON.stringify(spec)}); return typeof m`);
      assert.notEqual(r.status, 0, r.stdout);
      assert.equal(JSON.parse(r.stdout).ok, false);
    });
  }

  it('bounds a busy loop by -m', () => {
    const r = run(['-m', '2', 'code', '-e', 'for(;;){}'], { env, timeout: 20_000 });
    assert.notEqual(r.status, 0);
    assert.notEqual(r.status, null, 'mcpcat had to be killed');
    assert.ok(r.ms < 10_000, `took ${r.ms} ms`);
  });

  it('bounds memory', () => {
    const r = run(
      ['-m', '20', 'code', '-e', 'const a=[]; for(;;){ a.push(new Array(1e6).fill(1)); }'],
      {
        env,
        timeout: 30_000,
      }
    );
    assert.notEqual(r.status, 0);
    assert.notEqual(r.status, null, 'mcpcat had to be killed');
  });
});
