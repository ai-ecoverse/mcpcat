import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const cli = join(root, 'test/integration/fixtures/serve-cli.mjs');
const runtimeModule = join(root, 'src/serve/runtime.ts');
const hostModule = join(root, 'src/platform/host.ts');
const calls = 50;

function runServeInProcess(serveArgs, requests) {
  const source = `
    import { parseServeFlags, runServe } from ${JSON.stringify(runtimeModule)};
    import { createHostPlatform } from ${JSON.stringify(hostModule)};
    const started = Date.now();
    const code = await runServe(createHostPlatform(), parseServeFlags(${JSON.stringify(serveArgs)}), '0.0.0');
    const timers = process.getActiveResourcesInfo().filter((r) => r === 'Timeout').length;
    process.stderr.write(JSON.stringify({ code, timers, served: Date.now() - started }) + '\\n');
  `;
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, NODE_NO_WARNINGS: '1' },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => {
      stdout += c;
    });
    child.stderr.on('data', (c) => {
      stderr += c;
    });
    const killer = setTimeout(() => child.kill('SIGKILL'), 30_000);
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      clearTimeout(killer);
      resolve({ code, signal, stdout, stderr, elapsed: Date.now() - started });
    });
    child.stdin.end(requests.map((r) => `${JSON.stringify(r)}\n`).join(''));
  });
}

function report(stderr) {
  const line = stderr.trim().split('\n').at(-1);
  return JSON.parse(line);
}

describe('serve: runCommand clears its per-call timer (#87)', () => {
  it('leaves no pending timers after discovery and many tool calls', async () => {
    const requests = [
      { jsonrpc: '2.0', id: 0, method: 'initialize', params: {} },
      ...Array.from({ length: calls }, (_, i) => ({
        jsonrpc: '2.0',
        id: i + 1,
        method: 'tools/call',
        params: { name: 'node_echo', arguments: { text: `call ${i}` } },
      })),
    ];
    const res = await runServeInProcess([`node=${cli}`], requests);
    assert.equal(res.signal, null, `killed after ${res.elapsed}ms: ${res.stderr}`);
    assert.equal(res.code, 0, res.stderr);
    const replies = res.stdout
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    const echoed = replies.filter((r) => r.result?.content?.[0]?.text?.includes('call '));
    assert.equal(echoed.length, calls);
    const { code, timers } = report(res.stderr);
    assert.equal(code, 0);
    assert.equal(timers, 0, `pending timers after serve returned: ${timers}`);
    assert.ok(res.elapsed < 20_000, `took ${res.elapsed}ms`);
  });

  it('leaves no pending timer after a templated tool call', async () => {
    const requests = [
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'say', arguments: { text: 'hi' } },
      },
    ];
    const res = await runServeInProcess(
      ['--tool', `say: ${process.execPath} ${cli} echo {text}`],
      requests
    );
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /hi/);
    assert.equal(report(res.stderr).timers, 0, res.stderr);
  });
});
