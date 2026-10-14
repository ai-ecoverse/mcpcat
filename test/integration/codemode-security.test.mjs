import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { mcpcatArgs } from './helpers/bin.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const alphaServer = join(root, 'test/integration/fixtures/server-codemode-alpha.mjs');

const tmpDir = join(tmpdir(), `mcpcat-sandbox-test-${Date.now()}`);
const agentDir = join(tmpDir, '.pi', 'agent');
const stateDir = join(tmpDir, 'state');
const configPath = join(agentDir, 'mcp.json');

function setup() {
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    configPath,
    JSON.stringify(
      {
        mcpServers: { alpha: { command: 'node', args: [alphaServer] } },
      },
      null,
      2
    )
  );
}

function cleanup() {
  rmSync(tmpDir, { recursive: true, force: true });
}

function runCode(script) {
  const env = {
    ...process.env,
    NODE_NO_WARNINGS: '1',
    PI_CODING_AGENT_DIR: agentDir,
    XDG_STATE_HOME: stateDir,
    HOME: tmpDir,
  };
  const { cmd, args } = mcpcatArgs(['code', '--json', '-s', 'alpha', '-e', script]);
  try {
    const result = execFileSync(cmd, args, {
      encoding: 'utf8',
      timeout: 30_000,
      env,
    });
    return JSON.parse(result);
  } catch (err) {
    const stdout = err.stdout ?? '';
    try {
      return JSON.parse(stdout);
    } catch {
      return { ok: false, error: { message: err.stderr ?? 'failed' } };
    }
  }
}

describe('codemode sandbox security (homescoop cert item 6)', () => {
  before(setup);
  after(cleanup);

  it('script cannot access globalThis of the host realm', () => {
    const result = runCode(
      'try { return typeof globalThis.process; } catch(e) { return "blocked: " + e.message; }'
    );
    assert.ok(result.ok);
    assert.equal(result.value, 'undefined');
  });

  it('script cannot access process', () => {
    const result = runCode(
      'try { return typeof process; } catch(e) { return "blocked: " + e.message; }'
    );
    assert.ok(result.ok);
    assert.equal(result.value, 'undefined');
  });

  it('script cannot access fetch', () => {
    const result = runCode(
      'try { return typeof fetch; } catch(e) { return "blocked: " + e.message; }'
    );
    assert.ok(result.ok);
    assert.equal(result.value, 'undefined');
  });

  it('script cannot access require', () => {
    const result = runCode(
      'try { return typeof require; } catch(e) { return "blocked: " + e.message; }'
    );
    assert.ok(result.ok);
    assert.equal(result.value, 'undefined');
  });

  it('script cannot access fs module', () => {
    const result = runCode(
      'try { const fs = require("fs"); return "leaked"; } catch(e) { return "blocked"; }'
    );
    assert.ok(result.ok);
    assert.equal(result.value, 'blocked');
  });

  it('script cannot access ctx', () => {
    const result = runCode(
      'try { return typeof ctx; } catch(e) { return "blocked: " + e.message; }'
    );
    assert.ok(result.ok);
    assert.equal(result.value, 'undefined');
  });

  it('script cannot use import()', () => {
    const result = runCode(
      'try { await import("fs"); return "leaked"; } catch(e) { return "blocked"; }'
    );
    assert.ok(result.ok);
    assert.equal(result.value, 'blocked');
  });
});
