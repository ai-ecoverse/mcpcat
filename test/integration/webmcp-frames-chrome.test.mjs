import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { launch, serve } from '@ai-ecoverse/slicc-shared-web/harness';
import { mcpcatArgs } from './helpers/bin.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const scratch = mkdtempSync(join(tmpdir(), 'mcpcat-frames-chrome-'));
let chrome;
let second;
let cli = 'playwright-cli';
let endpoint;

before(async () => {
  try {
    assert.match(
      execFileSync(cli, ['--version'], { encoding: 'utf8' }),
      /playwright-cli 1\.(?:5[4-9]|[6-9]\d)\./
    );
  } catch {
    const arch = process.arch === 'x64' ? 'amd64' : process.arch;
    const asset = `playwright-cli-${process.platform}-${arch}${process.platform === 'win32' ? '.exe' : ''}`;
    const base = 'https://github.com/ai-ecoverse/slicc-cdp/releases/download/v1.54.0';
    const response = await fetch(`${base}/${asset}`);
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    const sums = await fetch(`${base}/SHA256SUMS`).then((r) => r.text());
    const line = sums.split('\n').find((line) => line.trim().endsWith(` ${asset}`));
    assert.ok(line, asset);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), line.split(/\s+/)[0]);
    cli = join(scratch, asset);
    writeFileSync(cli, bytes);
    chmodSync(cli, 0o700);
  }
  const roots = [['/', join(root, 'test/integration/fixtures/webmcp-page')]];
  second = await serve({ roots });
  chrome = await launch({
    roots,
    coverage: [],
    extension: false,
    args: ['--enable-blink-features=WebMCP'],
  });
  const [port, path] = readFileSync(join(chrome.profile, 'DevToolsActivePort'), 'utf8')
    .trim()
    .split('\n');
  endpoint = `ws://127.0.0.1:${port}${path}`;
});

after(async () => {
  await chrome?.close();
  await second?.close();
  rmSync(scratch, { recursive: true, force: true });
});

it('warms up the first Chrome page before the frame test', async (t) => {
  const page = await chrome.page(t);
  await page.goto('/');
  await page.until(() => document.title === 'ready');
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    await page.press('a');
    if (await page.evaluate(() => document.querySelector('input').value.length > 0)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail('keyboard input never reached the warm-up page');
});

it('lists and calls requested child tools and excludes unrequested and policy-denied tools', {
  timeout: 60000,
}, async (t) => {
  const page = await chrome.page(t);
  const path = `/cross.html?other=${encodeURIComponent(second.url)}`;
  await page.goto(path);
  await page.until(() => document.title === 'ready');
  const requested = new URL(second.url);
  const { targetInfos } = await chrome.cdp.send('Target.getTargets');
  const tab = targetInfos.find((target) => target.url === new URL(path, chrome.url).href).targetId;
  const bin = mcpcatArgs([
    'serve',
    '--webmcp',
    '--webmcp-polyfill',
    'off',
    '--webmcp-from-origin',
    requested.origin,
    '--tab',
    tab,
    '--cdp',
    endpoint,
    '--playwright-cli',
    cli,
    '--call-timeout',
    '10',
  ]);
  const child = spawn(bin.cmd, bin.args, { env: { ...process.env, TMPDIR: scratch } });
  t.after(() => child.kill('SIGKILL'));
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  let buffer = '';
  const replies = [];
  let wake;
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) >= 0) {
      replies.push(JSON.parse(buffer.slice(0, at)));
      buffer = buffer.slice(at + 1);
    }
    wake?.();
  });
  const rpc = async (id, method, params = {}) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    while (!replies.some((reply) => reply.id === id))
      await new Promise((resolve) => {
        wake = resolve;
      });
    return replies.find((reply) => reply.id === id);
  };
  await rpc(0, 'initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'chrome-test' },
  });
  let listedReply;
  const until = Date.now() + 20000;
  let id = 10;
  do {
    listedReply = await rpc(++id, 'tools/list');
  } while (!listedReply.result?.tools?.length && Date.now() < until);
  listedReply.id = 1;
  await rpc(2, 'tools/call', {
    name: 'requested_tool',
    arguments: { value: 'private child input' },
  });
  child.stdin.end();
  assert.equal(await new Promise((resolve) => child.once('close', resolve)), 0, stderr);
  const listed = replies.find((reply) => reply.id === 1);
  assert.deepEqual(
    listed.result.tools.map((tool) => tool.name),
    ['requested_tool'],
    stderr
  );
  assert.equal(listed.result.tools[0].annotations.late, true);
  const called = replies.find((reply) => reply.id === 2);
  assert.equal(called.result.isError, false, JSON.stringify(called));
  assert.match(called.result.content[0].text, /^<<untrusted-page-content/);
  assert.ok(called.result.content[0].text.includes('private child input'));
  assert.ok(called.result.content[0].text.includes(requested.origin));
});
