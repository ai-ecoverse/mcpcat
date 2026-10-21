import './helpers/isolate.mjs';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { installLeakProbe } from './fixtures/leak-probe.mjs';
import { isStandalone, mcpcatBin } from './helpers/bin.mjs';
import { attachKernel, createNodeKernel } from './helpers/kernel.mjs';
import { waitUntil } from './helpers/wait.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const fixturesDir = join(root, 'test/integration/fixtures');
const kernelBundle = join(root, 'dist/kernel/mcpcat.mjs');
const preload = join(fixturesDir, 'leak-probe-preload.mjs');
const serveCli = join(fixturesDir, 'serve-cli.mjs');
const hangCli = join(fixturesDir, 'serve-hang-cli.mjs');
const slowDiscoveryCli = join(fixturesDir, 'serve-slow-discovery-cli.mjs');
const termCli = join(fixturesDir, 'serve-term-cli.mjs');
const stdinCli = join(fixturesDir, 'serve-stdin-cli.mjs');
const bigStdin = 'x'.repeat(4 << 20);
const longTimeout = 30;
const longTimeoutMs = longTimeout * 1000;
const callGraceMs = 5000;
const shutdownGraceMs = 2000;
const callTimeout = 3;
const callTimeoutMs = callTimeout * 1000;
const discoveryTimeoutMs = 10_000;
const cliCount = 12;

const home = mkdtempSync(join(tmpdir(), 'mcpcat-call-timeout-'));
after(() => rmSync(home, { recursive: true, force: true }));

const call = (id, name, args = {}) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: args },
});

function probeOf(stderr) {
  const line = stderr
    .split('\n')
    .reverse()
    .find((l) => l.startsWith('leak-probe '));
  assert.ok(line, `no leak-probe report: ${stderr}`);
  return JSON.parse(line.slice('leak-probe '.length));
}

function replies(stdout) {
  return new Map(
    stdout
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l))
      .map((r) => [r.id, r])
  );
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function readPid(file) {
  return existsSync(file) && Number(readFileSync(file, 'utf8').trim());
}

function startHost(args, env = {}) {
  const child = spawn(process.execPath, ['--import', preload, mcpcatBin, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, NODE_NO_WARNINGS: '1', HOME: home, ...env },
  });
  const out = { stdout: '', stderr: '' };
  child.stdout.on('data', (c) => {
    out.stdout += c;
  });
  child.stderr.on('data', (c) => {
    out.stderr += c;
  });
  const killer = setTimeout(() => child.kill('SIGKILL'), 40_000);
  out.exited = new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      clearTimeout(killer);
      resolve({ code, signal });
    });
  });
  out.child = child;
  return out;
}

function assertNoCallTimer(probe, ms, stderr) {
  assert.ok(!probe.timers.includes(ms), `a ${ms} ms call timer outlived serve: ${stderr}`);
}

function startHostHttp(tools, clis = []) {
  const serve = startHost([
    'serve',
    '--http',
    '0',
    '--no-auth',
    '--call-timeout',
    String(longTimeout),
    ...tools.flatMap((t) => ['--tool', t]),
    ...clis,
  ]);
  serve.url = waitUntil(
    () => /listening on (http:\/\/\S+)/.exec(serve.stderr)?.[1],
    'serve to listen'
  );
  return serve;
}

function post(url, body, signal) {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify(body),
    signal,
  });
}

function rawRequest(url, body) {
  const json = JSON.stringify(body);
  return [
    'POST /mcp HTTP/1.1',
    `host: ${new URL(url).host}`,
    'content-type: application/json',
    'accept: application/json, text/event-stream',
    `content-length: ${Buffer.byteLength(json)}`,
    '',
    json,
  ].join('\r\n');
}

function openSocket(url) {
  const { hostname, port } = new URL(url);
  const socket = connect(Number(port), hostname);
  socket.received = '';
  socket.on('data', (c) => {
    socket.received += c;
  });
  socket.on('error', () => {});
  return new Promise((resolve) => socket.on('connect', () => resolve(socket)));
}

function splitResponses(text) {
  const out = [];
  let rest = text;
  for (;;) {
    const end = rest.indexOf('\r\n\r\n');
    if (end < 0) return out;
    const head = rest.slice(0, end);
    const length = Number(/content-length:\s*(\d+)/i.exec(head)?.[1] ?? 0);
    const body = rest.slice(end + 4, end + 4 + length);
    if (body.length < length) return out;
    const data = body.startsWith('{') ? body : /^data: (.*)$/m.exec(body)?.[1];
    out.push({ status: Number(head.split(' ')[1]), message: JSON.parse(data) });
    rest = rest.slice(end + 4 + length);
  }
}

function assertPipelined(text, secondText) {
  const responses = splitResponses(text);
  assert.equal(responses.length, 2, text.slice(0, 2000));
  const [first, second] = responses;
  assert.equal(first.status, 200);
  assert.equal(first.message.id, 1);
  assert.notEqual(first.message.result?.isError, true, JSON.stringify(first.message));
  assert.equal(second.status, 200);
  assert.equal(second.message.id, 2);
  assert.notEqual(
    second.message.result?.isError,
    true,
    JSON.stringify(second.message).slice(0, 2000)
  );
  assert.equal(second.message.result?.content?.[0]?.text?.trim(), secondText);
}

const pipelinedText = `two-${'y'.repeat(60_000)}-end`;

async function assertKilledWithin(pid, started, withinMs) {
  await waitUntil(() => !pidAlive(pid), `tool ${pid} to be killed on disconnect`, withinMs);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < withinMs, `tool outlived its disconnected client by ${elapsed} ms`);
}

async function stopClean(serve) {
  serve.child.kill('SIGTERM');
  const { signal } = await serve.exited;
  assert.equal(signal, null, serve.stderr);
  const probe = probeOf(serve.stderr);
  assertNoCallTimer(probe, longTimeoutMs, serve.stderr);
  assertNoCallTimer(probe, callGraceMs, serve.stderr);
  assert.equal(probe.abortListeners, 0, `abort listeners left behind: ${serve.stderr}`);
}

async function hostDisconnectKills(cli, label, withinMs) {
  const pidFile = join(home, `${label}.pid`);
  const serve = startHostHttp([
    `held: ${process.execPath} ${cli} ${pidFile}`,
    `say: ${process.execPath} ${serveCli} echo {text}`,
  ]);
  const url = await serve.url;
  const abort = new AbortController();
  const held = post(url, call(1, 'held'), abort.signal).catch((err) => err);
  const pid = await waitUntil(() => readPid(pidFile), 'the tool to record its pid');
  const started = Date.now();
  abort.abort();
  assert.equal((await held).name, 'AbortError');
  await waitUntil(() => !pidAlive(pid), `tool ${pid} to be killed on disconnect`, withinMs);
  const elapsed = Date.now() - started;
  assert.ok(elapsed < withinMs, `tool outlived its disconnected client by ${elapsed} ms`);
  const res = await post(url, call(2, 'say', { text: 'still serving' }));
  assert.equal(res.status, 200);
  assert.match(await res.text(), /still serving/);
  serve.child.kill('SIGTERM');
  const { signal } = await serve.exited;
  assert.equal(signal, null, serve.stderr);
  const probe = probeOf(serve.stderr);
  assertNoCallTimer(probe, longTimeoutMs, serve.stderr);
  assertNoCallTimer(probe, callGraceMs, serve.stderr);
  assert.equal(probe.abortListeners, 0, `abort listeners left behind: ${serve.stderr}`);
}

describe('serve on the host: --call-timeout and abort paths clear their timers (#381)', {
  skip: isStandalone && 'needs node --import to load the leak probe',
  timeout: 120_000,
}, () => {
  it('stdio: a hung tool is SIGTERMed then SIGKILLed, replies timed out, and the next call leaves no timer', async () => {
    const pidFile = join(home, 'stdio-hang.pid');
    const serve = startHost([
      'serve',
      '--call-timeout',
      String(callTimeout),
      '--tool',
      `hang: ${process.execPath} ${hangCli} ${pidFile}`,
      '--tool',
      `say: ${process.execPath} ${serveCli} echo {text}`,
    ]);
    serve.child.stdin.write(`${JSON.stringify(call(1, 'hang'))}\n`);
    const pid = await waitUntil(() => readPid(pidFile), 'the hung tool to record its pid');
    serve.child.stdin.end(`${JSON.stringify(call(2, 'say', { text: 'after' }))}\n`);
    const started = Date.now();
    const { code, signal } = await serve.exited;
    const elapsed = Date.now() - started;
    assert.equal(signal, null, serve.stderr);
    assert.equal(code, 0, serve.stderr);
    const byId = replies(serve.stdout);
    assert.equal(byId.get(1)?.result?.isError, true, serve.stdout);
    assert.equal(byId.get(1)?.result?.structuredContent?.exitCode, 124, serve.stdout);
    assert.match(byId.get(1)?.result?.content?.[0]?.text ?? '', /timed out/);
    assert.match(byId.get(2)?.result?.content?.[0]?.text ?? '', /after/, serve.stdout);
    assert.ok(!pidAlive(pid), `hung tool ${pid} survived the timeout`);
    assert.ok(elapsed < callTimeoutMs + 9_000, `serve took ${elapsed} ms after stdin EOF`);
    assertNoCallTimer(probeOf(serve.stderr), callTimeoutMs, serve.stderr);
  });

  it('http: a client that disconnects mid-call still gets the child killed, later calls are served, no timer left', async () => {
    const pidFile = join(home, 'http-hang.pid');
    const serve = startHost([
      'serve',
      '--http',
      '0',
      '--no-auth',
      '--call-timeout',
      String(callTimeout),
      '--tool',
      `hang: ${process.execPath} ${hangCli} ${pidFile}`,
      '--tool',
      `say: ${process.execPath} ${serveCli} echo {text}`,
    ]);
    const url = await waitUntil(
      () => /listening on (http:\/\/\S+)/.exec(serve.stderr)?.[1],
      'serve to listen'
    );
    const post = (body, signal) =>
      fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify(body),
        signal,
      });
    const abort = new AbortController();
    const hung = post(call(1, 'hang'), abort.signal).catch((err) => err);
    const pid = await waitUntil(() => readPid(pidFile), 'the hung tool to record its pid');
    abort.abort();
    assert.equal((await hung).name, 'AbortError');
    await waitUntil(() => !pidAlive(pid), `hung tool ${pid} to be killed`, callTimeoutMs + 9_000);
    const res = await post(call(2, 'say', { text: 'still serving' }));
    assert.equal(res.status, 200);
    assert.match(await res.text(), /still serving/);
    serve.child.kill('SIGTERM');
    const { signal } = await serve.exited;
    assert.equal(signal, null, serve.stderr);
    assertNoCallTimer(probeOf(serve.stderr), callTimeoutMs, serve.stderr);
  });

  it('http: a client disconnect aborts its call and kills a SIGTERM-honouring tool at once (#384)', () =>
    hostDisconnectKills(termCli, 'http-term', 3_000));

  it('http: a client disconnect SIGKILLs a SIGTERM-ignoring tool after the grace, not at --call-timeout (#384)', () =>
    hostDisconnectKills(hangCli, 'http-ignore', callGraceMs + 4_000));

  it('http: a disconnect while the tool is still being fed stdin kills it (#384)', async () => {
    const pidFile = join(home, 'http-stdin.pid');
    const serve = startHostHttp([], [`s=${stdinCli}`]);
    const url = await serve.url;
    const abort = new AbortController();
    const args = { argv: ['hold', pidFile], stdin: bigStdin };
    const held = post(url, call(1, 's_invoke', args), abort.signal).catch((err) => err);
    const pid = await waitUntil(() => readPid(pidFile), 'the tool to record its pid');
    const started = Date.now();
    abort.abort();
    assert.equal((await held).name, 'AbortError');
    await assertKilledWithin(pid, started, 3_000);
    await stopClean(serve);
  });

  it('http: a disconnect after the client sent more bytes still kills the tool (#384)', async () => {
    const pidFile = join(home, 'http-extra.pid');
    const serve = startHostHttp([`held: ${process.execPath} ${termCli} ${pidFile}`]);
    const url = await serve.url;
    const socket = await openSocket(url);
    socket.write(rawRequest(url, call(1, 'held')));
    const pid = await waitUntil(() => readPid(pidFile), 'the tool to record its pid');
    socket.write('POST /mcp HTTP/1.1\r\n');
    await new Promise((r) => setTimeout(r, 200));
    const started = Date.now();
    socket.destroy();
    await assertKilledWithin(pid, started, 3_000);
    await stopClean(serve);
  });

  it('http: a request pipelined behind a running call is parked and answered after it, in order (#393)', async () => {
    const pidFile = join(home, 'http-pipelined.pid');
    const serve = startHostHttp([
      `slow: ${process.execPath} ${termCli} ${pidFile} 1500`,
      `say: ${process.execPath} ${serveCli} echo {text}`,
    ]);
    const url = await serve.url;
    const socket = await openSocket(url);
    socket.write(rawRequest(url, call(1, 'slow')));
    await waitUntil(() => readPid(pidFile), 'the slow tool to record its pid');
    const second = rawRequest(url, call(2, 'say', { text: pipelinedText }));
    const split = second.indexOf('\r\n\r\n') + 4;
    const middle = split + Math.floor((second.length - split) / 2);
    socket.write(second.slice(0, split));
    await new Promise((r) => setTimeout(r, 200));
    socket.write(second.slice(split, middle));
    await new Promise((r) => setTimeout(r, 200));
    socket.write(second.slice(middle));
    await waitUntil(
      () => splitResponses(socket.received).length === 2,
      'both pipelined responses',
      10_000
    );
    socket.destroy();
    assertPipelined(socket.received, pipelinedText);
    await stopClean(serve);
  });

  it('http: a call queued behind another whose client disconnects never spawns (#389)', async () => {
    const firstPid = join(home, 'http-queue-first.pid');
    const queuedPid = join(home, 'http-queue-second.pid');
    const serve = startHostHttp([
      `first: ${process.execPath} ${termCli} ${firstPid} 1500`,
      `queued: ${process.execPath} ${termCli} ${queuedPid}`,
    ]);
    const url = await serve.url;
    const first = post(url, call(1, 'first')).then((r) => r.text());
    await waitUntil(() => readPid(firstPid), 'the first tool to record its pid');
    const abort = new AbortController();
    const queued = post(url, call(2, 'queued'), abort.signal).catch((err) => err);
    await new Promise((r) => setTimeout(r, 200));
    abort.abort();
    assert.equal((await queued).name, 'AbortError');
    await first;
    await new Promise((r) => setTimeout(r, 500));
    assert.ok(!existsSync(queuedPid), 'the queued call spawned after its client left');
    await stopClean(serve);
  });

  it('http: a request on a kept-alive socket after SIGTERM never spawns and does not hold serve (#384)', async () => {
    const pidFile = join(home, 'http-late-stubborn.pid');
    const latePid = join(home, 'http-late.pid');
    const serve = startHostHttp([
      `stubborn: ${process.execPath} ${hangCli} ${pidFile}`,
      `late: ${process.execPath} ${termCli} ${latePid}`,
      `say: ${process.execPath} ${serveCli} echo {text}`,
    ]);
    const url = await serve.url;
    const idle = await openSocket(url);
    idle.write(rawRequest(url, call(1, 'say', { text: 'warm' })));
    await waitUntil(() => /warm/.test(idle.received), 'the kept-alive socket to be served');
    const busy = await openSocket(url);
    busy.write(rawRequest(url, call(2, 'stubborn')));
    await waitUntil(() => readPid(pidFile), 'the stubborn tool to record its pid');
    const started = Date.now();
    serve.child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 100));
    idle.write(rawRequest(url, call(3, 'late')));
    await serve.exited;
    const elapsed = Date.now() - started;
    idle.destroy();
    busy.destroy();
    assert.ok(!existsSync(latePid), 'a request after shutdown spawned its tool');
    assert.ok(elapsed < shutdownGraceMs + 1_500, `serve took ${elapsed} ms to exit`);
    const probe = probeOf(serve.stderr);
    assertNoCallTimer(probe, longTimeoutMs, serve.stderr);
    assert.equal(probe.abortListeners, 0, `abort listeners left behind: ${serve.stderr}`);
  });

  it('http: SIGTERM with a call in flight exits at once and leaves no kill-grace timer (#386)', async () => {
    const pidFile = join(home, 'http-shutdown.pid');
    const serve = startHostHttp([`held: ${process.execPath} ${termCli} ${pidFile}`]);
    const url = await serve.url;
    const held = post(url, call(1, 'held')).catch((err) => err);
    const pid = await waitUntil(() => readPid(pidFile), 'the tool to record its pid');
    const started = Date.now();
    serve.child.kill('SIGTERM');
    const { signal } = await serve.exited;
    const elapsed = Date.now() - started;
    await held;
    assert.equal(signal, null, serve.stderr);
    assert.ok(!pidAlive(pid), `tool ${pid} survived shutdown`);
    assert.ok(elapsed < shutdownGraceMs - 500, `serve took ${elapsed} ms to exit`);
    const probe = probeOf(serve.stderr);
    assertNoCallTimer(probe, shutdownGraceMs, serve.stderr);
    assertNoCallTimer(probe, longTimeoutMs, serve.stderr);
    assert.equal(probe.abortListeners, 0, `abort listeners left behind: ${serve.stderr}`);
  });

  it('discovery: SIGTERM aborts the in-flight discovery call, kills its child, and clears its timer', async () => {
    const pidFile = join(home, 'discovery.pid');
    const serve = startHost(['serve', '--env', 'PID_RECORD_FILE', `slow=${slowDiscoveryCli}`], {
      PID_RECORD_FILE: pidFile,
    });
    const pid = await waitUntil(() => readPid(pidFile), 'the discovery child to record its pid');
    serve.child.kill('SIGTERM');
    const { code, signal } = await serve.exited;
    assert.equal(signal, null, serve.stderr);
    assert.equal(code, 143, serve.stderr);
    await waitUntil(() => !pidAlive(pid), `discovery child ${pid} to be gone`, 5_000);
    assertNoCallTimer(probeOf(serve.stderr), discoveryTimeoutMs, serve.stderr);
  });

  it(`discovery: ${cliCount} CLIs leave no abort listener and no discovery timer behind`, async () => {
    const clis = Array.from({ length: cliCount }, (_, i) => `c${i}=${serveCli}`);
    const serve = startHost(['serve', ...clis]);
    serve.child.stdin.end(`${JSON.stringify(call(1, 'c0_echo', { text: 'discovered' }))}\n`);
    const { code, signal } = await serve.exited;
    assert.equal(signal, null, serve.stderr);
    assert.equal(code, 0, serve.stderr);
    assert.match(serve.stdout, /discovered/);
    const probe = probeOf(serve.stderr);
    assert.equal(
      probe.abortListeners,
      0,
      `abort listeners left on the discovery signal: ${serve.stderr}`
    );
    assertNoCallTimer(probe, discoveryTimeoutMs, serve.stderr);
  });
});

function probedKernelBundle() {
  const source = readFileSync(kernelBundle, 'utf8');
  const tail = /export\s*\{\s*main as default\s*\};\s*$/;
  assert.match(source, tail, 'kernel bundle should end with export { main as default }');
  return [
    installLeakProbe.toString(),
    'const __leakReport = installLeakProbe(globalThis);',
    source.replace(tail, ''),
    'export default async function probed(ctx) {',
    '  const code = await main(ctx);',
    '  await ctx.write(2, new TextEncoder().encode(`leak-probe ${JSON.stringify(__leakReport())}\\n`));',
    '  return code;',
    '}',
  ].join('\n');
}

const kernelCommands = [
  ['mcpcat-test-hang', 'kernel-hang-cli.mjs'],
  ['mcpcat-test-serve-cli', 'kernel-serve-cli.mjs'],
  ['mcpcat-test-slow-discovery', 'kernel-slow-discovery-cli.mjs'],
  ['mcpcat-test-term', 'kernel-term-cli.mjs'],
  ['mcpcat-test-http-call', 'kernel-http-call-client.mjs'],
  ['mcpcat-test-stdin', 'kernel-stdin-cli.mjs'],
];

describe('serve in the kernel: --call-timeout and abort paths clear their timers (#381)', {
  timeout: 120_000,
}, () => {
  let kernel;
  let client;

  async function installPackage(name, module, data) {
    await kernel.writeFile(`/node_modules/@ai-ecoverse/${name}/${module}`, data);
    await kernel.writeFile(
      `/node_modules/@ai-ecoverse/${name}/package.json`,
      JSON.stringify({
        name: `@ai-ecoverse/${name}`,
        version: '0.0.0',
        type: 'module',
        slicc: { commands: { [name]: { abi: 'js', module } } },
      })
    );
  }

  before(async () => {
    kernel = await createNodeKernel({});
    await installPackage('mcpcat', 'dist/kernel/mcpcat.mjs', probedKernelBundle());
    for (const [name, file] of kernelCommands) {
      await installPackage(name, 'dist/main.mjs', readFileSync(join(fixturesDir, file)));
    }
    client = await attachKernel(await kernel.connect());
  });

  after(() => {
    client?.close();
    kernel?.terminate();
  });

  async function kernelPid(file) {
    try {
      return Number(new TextDecoder().decode(await kernel.readFile(file)).trim());
    } catch {
      return 0;
    }
  }

  async function kernelExists(file) {
    try {
      await kernel.readFile(file);
      return true;
    } catch {
      return false;
    }
  }

  async function kernelAlive(pid) {
    return (await client.ps()).some((p) => p.pid === pid && p.state !== 'Z');
  }

  it('stdio: a hung tool is killed, replies timed out, and the next call leaves no timer', async () => {
    const pidFile = '/tmp/kernel-hang.pid';
    const requests = [call(1, 'hang'), call(2, 'say', { text: 'after' })]
      .map((r) => `${JSON.stringify(r)}\n`)
      .join('');
    const run = kernel.run(
      [
        'mcpcat',
        'serve',
        '--call-timeout',
        String(callTimeout),
        '--tool',
        `hang: mcpcat-test-hang ${pidFile}`,
        '--tool',
        'say: mcpcat-test-serve-cli echo {text}',
      ],
      { stdin: requests, stdout: 'pipe', stderr: 'pipe' }
    );
    const pid = await waitUntil(() => kernelPid(pidFile), 'the hung tool to record its pid');
    const { status, stdout, stderr } = await run;
    assert.equal(status, 0, stderr);
    const byId = replies(stdout);
    assert.equal(byId.get(1)?.result?.structuredContent?.exitCode, 124, stdout);
    assert.match(byId.get(1)?.result?.content?.[0]?.text ?? '', /timed out/);
    assert.match(byId.get(2)?.result?.content?.[0]?.text ?? '', /after/, stdout);
    await waitUntil(async () => !(await kernelAlive(pid)), `hung tool ${pid} to be gone`, 5_000);
    assertNoCallTimer(probeOf(stderr), callTimeoutMs, stderr);
  });

  async function spawnHttpServe(tools, clis = []) {
    const out = { stderr: '' };
    out.sp = await client.spawn(
      [
        'mcpcat',
        'serve',
        '--http',
        '0',
        '--no-auth',
        '--call-timeout',
        String(longTimeout),
        ...tools.flatMap((t) => ['--tool', t]),
        ...clis,
      ],
      {
        stdin: 'pipe',
        onStdout() {},
        onStderr(chunk) {
          out.stderr += new TextDecoder().decode(chunk);
        },
      }
    );
    out.port = await waitUntil(
      () => /listening on http:\/\/(\d+)\.kernel\.localhost/.exec(out.stderr)?.[1],
      'serve to listen'
    );
    return out;
  }

  async function stopKernelClean(serve) {
    serve.sp.signal('SIGTERM');
    await serve.sp.exited;
    const probe = probeOf(serve.stderr);
    assertNoCallTimer(probe, longTimeoutMs, serve.stderr);
    assertNoCallTimer(probe, callGraceMs, serve.stderr);
    assert.equal(probe.abortListeners, 0, `abort listeners left behind: ${serve.stderr}`);
  }

  async function kernelDisconnectKills(command, label, withinMs, options = {}) {
    const pidFile = `/tmp/kernel-${label}.pid`;
    const serve = await spawnHttpServe(
      options.clis ? [] : [`held: ${command} ${pidFile}`],
      options.clis ?? []
    );
    const sent = await kernel.run(
      [
        'mcpcat-test-http-call',
        serve.port,
        options.tool ?? 'held',
        pidFile,
        options.mode ?? 'close',
        JSON.stringify(options.args?.(pidFile) ?? {}),
      ],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    assert.equal(sent.status, 0, sent.stderr);
    const pid = await kernelPid(pidFile);
    assert.ok(pid, 'the tool should have recorded its pid');
    const started = Date.now();
    await waitUntil(
      async () => !(await kernelAlive(pid)),
      `tool ${pid} to be killed on disconnect`,
      withinMs
    );
    const elapsed = Date.now() - started;
    assert.ok(elapsed < withinMs, `tool outlived its disconnected client by ${elapsed} ms`);
    serve.sp.signal('SIGTERM');
    await serve.sp.exited;
    const probe = probeOf(serve.stderr);
    assertNoCallTimer(probe, longTimeoutMs, serve.stderr);
    assertNoCallTimer(probe, callGraceMs, serve.stderr);
    assert.equal(probe.abortListeners, 0, `abort listeners left behind: ${serve.stderr}`);
  }

  it('http: a client disconnect aborts its call and kills a SIGTERM-honouring tool at once (#384)', () =>
    kernelDisconnectKills('mcpcat-test-term', 'http-term', 3_000));

  it('http: a client disconnect kills a SIGTERM-ignoring tool after the grace, not at --call-timeout (#384)', () =>
    kernelDisconnectKills('mcpcat-test-hang', 'http-ignore', callGraceMs + 4_000));

  it('http: a disconnect while the tool is still being fed stdin kills it (#384)', () =>
    kernelDisconnectKills('', 'http-stdin', 3_000, {
      clis: ['s=mcpcat-test-stdin'],
      tool: 's_invoke',
      args: (pidFile) => ({ argv: ['hold', pidFile], stdin: bigStdin }),
    }));

  it('http: a disconnect after the client sent more bytes still kills the tool (#384)', () =>
    kernelDisconnectKills('mcpcat-test-term', 'http-extra', 3_000, { mode: 'extra' }));

  it('http: a request pipelined behind a running call is parked and answered after it, in order (#393)', async () => {
    const pidFile = '/tmp/kernel-pipelined.pid';
    const serve = await spawnHttpServe([
      `slow: mcpcat-test-term ${pidFile} 1500`,
      'say: mcpcat-test-serve-cli echo {text}',
    ]);
    const sent = await kernel.run(
      [
        'mcpcat-test-http-call',
        serve.port,
        'slow',
        pidFile,
        'pipeline',
        JSON.stringify({ text: pipelinedText }),
        'say',
      ],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    assert.equal(sent.status, 0, sent.stderr);
    assertPipelined(sent.stdout, pipelinedText);
    await stopKernelClean(serve);
  });

  it('http: a call queued behind another whose client disconnects never spawns (#389)', async () => {
    const firstPid = '/tmp/kernel-queue-first.pid';
    const queuedPid = '/tmp/kernel-queue-second.pid';
    const serve = await spawnHttpServe([
      `first: mcpcat-test-term ${firstPid} 1500`,
      `queued: mcpcat-test-term ${queuedPid}`,
    ]);
    const first = kernel.run(['mcpcat-test-http-call', serve.port, 'first', firstPid, 'hold'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const pid = await waitUntil(() => kernelPid(firstPid), 'the first tool to record its pid');
    const queued = await kernel.run(
      ['mcpcat-test-http-call', serve.port, 'queued', firstPid, 'close'],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    assert.equal(queued.status, 0, queued.stderr);
    await waitUntil(async () => !(await kernelAlive(pid)), 'the first tool to finish', 5_000);
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(await kernelPid(queuedPid), 0, 'the queued call spawned after its client left');
    await stopKernelClean(serve);
    await first;
  });

  it('http: a request on a kept-alive socket after SIGTERM never spawns and does not hold serve (#384)', async () => {
    const pidFile = '/tmp/kernel-late-stubborn.pid';
    const latePid = '/tmp/kernel-late.pid';
    const goFile = '/tmp/kernel-late.go';
    const serve = await spawnHttpServe([
      `stubborn: mcpcat-test-hang ${pidFile}`,
      `late: mcpcat-test-term ${latePid}`,
    ]);
    const clientRun = kernel.run(
      ['mcpcat-test-http-call', serve.port, 'stubborn', pidFile, 'late', '{}', 'late', goFile],
      { stdout: 'pipe', stderr: 'pipe' }
    );
    await waitUntil(() => kernelExists(`${pidFile}.ready`), 'the client to be ready');
    const started = Date.now();
    serve.sp.signal('SIGTERM');
    await new Promise((r) => setTimeout(r, 100));
    await kernel.writeFile(goFile, 'go');
    await serve.sp.exited;
    const elapsed = Date.now() - started;
    await clientRun;
    assert.equal(await kernelPid(latePid), 0, 'a request after shutdown spawned its tool');
    assert.ok(elapsed < shutdownGraceMs + 1_500, `serve took ${elapsed} ms to exit`);
    assertNoCallTimer(probeOf(serve.stderr), longTimeoutMs, serve.stderr);
  });

  it('http: SIGTERM with a call in flight exits at once and leaves no kill-grace timer (#386)', async () => {
    const pidFile = '/tmp/kernel-http-shutdown.pid';
    const serve = await spawnHttpServe([`held: mcpcat-test-term ${pidFile}`]);
    const held = kernel.run(['mcpcat-test-http-call', serve.port, 'held', pidFile, 'hold'], {
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const pid = await waitUntil(() => kernelPid(pidFile), 'the tool to record its pid');
    const started = Date.now();
    serve.sp.signal('SIGTERM');
    await serve.sp.exited;
    const elapsed = Date.now() - started;
    await held;
    await waitUntil(async () => !(await kernelAlive(pid)), `tool ${pid} to be gone`, 2_000);
    assert.ok(elapsed < shutdownGraceMs - 500, `serve took ${elapsed} ms to exit`);
    const probe = probeOf(serve.stderr);
    assertNoCallTimer(probe, shutdownGraceMs, serve.stderr);
    assertNoCallTimer(probe, longTimeoutMs, serve.stderr);
    assert.equal(probe.abortListeners, 0, `abort listeners left behind: ${serve.stderr}`);
  });

  it('discovery: SIGTERM aborts the in-flight discovery call, kills its child, and clears its timer', async () => {
    const pidFile = '/tmp/kernel-discovery.pid';
    let stderr = '';
    const sp = await client.spawn(
      ['mcpcat', 'serve', '--env', 'PID_RECORD_FILE', 'mcpcat-test-slow-discovery'],
      {
        stdin: 'pipe',
        env: { PID_RECORD_FILE: pidFile },
        onStdout() {},
        onStderr(chunk) {
          stderr += new TextDecoder().decode(chunk);
        },
      }
    );
    const pid = await waitUntil(() => kernelPid(pidFile), 'the discovery child to record its pid');
    sp.signal('SIGTERM');
    assert.equal(await sp.exited, 143, stderr);
    await waitUntil(
      async () => !(await kernelAlive(pid)),
      `discovery child ${pid} to be gone`,
      5_000
    );
    assertNoCallTimer(probeOf(stderr), discoveryTimeoutMs, stderr);
  });

  it(`discovery: ${cliCount} CLIs leave no abort listener and no discovery timer behind`, async () => {
    const clis = Array.from({ length: cliCount }, (_, i) => `c${i}=mcpcat-test-serve-cli`);
    const { status, stdout, stderr } = await kernel.run(['mcpcat', 'serve', ...clis], {
      stdin: `${JSON.stringify(call(1, 'c0_echo', { text: 'discovered' }))}\n`,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    assert.equal(status, 0, stderr);
    assert.match(stdout, /discovered/);
    const probe = probeOf(stderr);
    assert.equal(
      probe.abortListeners,
      0,
      `abort listeners left on the discovery signal: ${stderr}`
    );
    assertNoCallTimer(probe, discoveryTimeoutMs, stderr);
  });
});
