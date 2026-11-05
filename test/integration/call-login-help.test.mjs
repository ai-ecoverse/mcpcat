import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fixtures, run } from './helpers/rows.mjs';

describe('call and login per-verb help', () => {
  it('call --help documents flag and -d forms, not bare key=value', () => {
    const r = run(['call', '--help']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^mcpcat \S+ – call\n/);
    assert.match(r.stdout, /--name value/);
    assert.match(r.stdout, /--name=value/);
    assert.match(r.stdout, /-d <json>/);
    assert.match(r.stdout, /Bare key=value.*is not accepted/);
    assert.doesNotMatch(r.stdout, /a curl for the Model Context Protocol/);
  });

  it('help call matches call --help', () => {
    const a = run(['call', '--help']);
    const b = run(['help', 'call']);
    assert.equal(a.status, 0, a.stderr);
    assert.equal(b.status, 0, b.stderr);
    assert.equal(a.stdout, b.stdout);
  });

  it('login --help documents targets and --no-browser', () => {
    const r = run(['login', '--help']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /^mcpcat \S+ – login\n/);
    assert.match(r.stdout, /mcpcat login <target>/);
    assert.match(r.stdout, /--no-browser/);
    assert.doesNotMatch(r.stdout, /a curl for the Model Context Protocol/);
  });

  it('help login matches login --help', () => {
    const a = run(['login', '--help']);
    const b = run(['help', 'login']);
    assert.equal(a.status, 0, a.stderr);
    assert.equal(b.status, 0, b.stderr);
    assert.equal(a.stdout, b.stdout);
  });

  it('general --help points at help call and help login', () => {
    const r = run(['--help']);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /help call/);
    assert.match(r.stdout, /help login/);
    assert.match(r.stdout, /call --help/);
    assert.match(r.stdout, /login --help/);
  });
});

describe('call key=value is rejected with a hint', () => {
  it('bare key=value exits 2 and suggests --key forms', () => {
    const target = `stdio:node ${join(fixtures, 'server-stdio-2026.mjs')}`;
    const r = run(['call', target, 'echo', 'message=hi']);
    assert.equal(r.status, 2, r.stderr + r.stdout);
    assert.match(r.stderr, /unexpected positional argument "message=hi"/);
    assert.match(r.stderr, /--message hi|--message=hi/);
    assert.match(r.stderr, /bare key=value is not accepted/);
  });

  it('accepts --key value for the same tool', () => {
    const target = `stdio:node ${join(fixtures, 'server-stdio-2026.mjs')}`;
    const r = run(['call', target, 'echo', '--message', 'hi']);
    assert.equal(r.status, 0, r.stderr + r.stdout);
  });
});
