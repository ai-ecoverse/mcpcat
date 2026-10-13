import { containsPlaceholders, expandPlaceholdersStrict } from '../config/expand.ts';
import { MergedConfigSource } from '../config/index.ts';
import { stateDir } from '../config/paths.ts';
import type { Platform, SpawnResult } from '../platform/types.ts';
import {
  argvForCommand,
  attachGlobalFlags,
  buildTools,
  type CliCommand,
  cliPrefix,
  isGroupCandidate,
  nestGroup,
  parseHelp,
  parseMcpOverride,
  parseToolTemplate,
  readToolArguments,
  type ServeTool,
  templateToArgv,
} from './catalog.ts';
import { type HttpRequest, type HttpResponse, handleConnection } from './http.ts';
import { handleJsonRpc, type RpcTool, type ToolRunResult } from './jsonrpc.ts';
import {
  buildAllowedHosts,
  buildServerOrigins,
  checkHost,
  checkOrigin,
  isLoopbackBind,
} from './origin.ts';
import { createProxyHandler } from './proxy.ts';

const CALL_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_DEFAULT = 1_048_576;
const ALLOWED_ENV_KEYS = new Set(['PATH', 'HOME', 'LANG']);

export interface ServeOptions {
  transport: 'stdio' | 'http';
  host: string;
  port: number;
  commands: { path: string; name?: string }[];
  proxy?: string;
  proxyCommand?: string[];
  onListening?: (port: number) => Promise<void>;
  toolTemplates: string[];
  bearer?: string;
  noAuth: boolean;
  allowOrigins: string[];
  allowHosts: string[];
  envAllow: string[];
  callTimeout: number;
  concurrency: number;
  maxOutput: number;
  cwd?: string;
  json: boolean;
  proxyHeaders: Array<[string, string]>;
  _resolvedBearer?: string;
}

function parseHttpFlag(args: string[], i: number): { host: string; port: number; next: number } {
  const next = args[i + 1];
  if (!next || next.startsWith('-')) return { host: '127.0.0.1', port: 0, next: i };
  const colonIdx = next.lastIndexOf(':');
  if (colonIdx > 0 && colonIdx < next.length - 1) {
    return { host: next.slice(0, colonIdx), port: Number(next.slice(colonIdx + 1)), next: i + 1 };
  }
  return { host: '127.0.0.1', port: Number(next), next: i + 1 };
}

function parseCommandTarget(arg: string): { path: string; name?: string } {
  const eqIdx = arg.indexOf('=');
  if (eqIdx > 0 && !arg.slice(0, eqIdx).includes('/')) {
    return { name: arg.slice(0, eqIdx), path: arg.slice(eqIdx + 1) };
  }
  return { path: arg };
}

function parseSingleFlag(
  args: string[],
  i: number,
  opts: {
    transport: 'stdio' | 'http';
    host: string;
    port: number;
    bearer?: string;
    noAuth: boolean;
    allowOrigins: string[];
    allowHosts: string[];
    envAllow: string[];
    toolTemplates: string[];
    callTimeout: number;
    concurrency: number;
    maxOutput: number;
    cwd?: string;
    json: boolean;
    commands: { path: string; name?: string }[];
    proxy?: string;
    proxyHeaders: Array<[string, string]>;
  }
): number {
  const arg = args[i];
  if (arg === '--stdio') {
    opts.transport = 'stdio';
  } else if (arg === '--http') {
    opts.transport = 'http';
    const parsed = parseHttpFlag(args, i);
    opts.host = parsed.host;
    opts.port = parsed.port;
    return parsed.next;
  } else if (arg === '--json') {
    opts.json = true;
  } else if (arg === '--no-auth') {
    opts.noAuth = true;
  } else if (!arg.startsWith('-')) {
    opts.commands.push(parseCommandTarget(arg));
  } else {
    return parseValueFlag(args, i, opts);
  }
  return i;
}

function parseValueFlag(
  args: string[],
  i: number,
  opts: {
    bearer?: string;
    allowOrigins: string[];
    allowHosts: string[];
    envAllow: string[];
    toolTemplates: string[];
    callTimeout: number;
    concurrency: number;
    maxOutput: number;
    cwd?: string;
    proxy?: string;
    proxyHeaders: Array<[string, string]>;
  }
): number {
  const arg = args[i];
  if (!args[i + 1]) return i;
  switch (arg) {
    case '--proxy':
      opts.proxy = args[++i];
      break;
    case '--bearer':
      opts.bearer = args[++i];
      break;
    case '--allow-origin':
      opts.allowOrigins.push(args[++i]);
      break;
    case '--allow-host':
      opts.allowHosts.push(args[++i]);
      break;
    case '--env':
      opts.envAllow.push(args[++i]);
      break;
    case '--tool':
      opts.toolTemplates.push(args[++i]);
      break;
    case '--call-timeout':
      opts.callTimeout = Number(args[++i]) * 1000;
      break;
    case '--concurrency':
      opts.concurrency = Number(args[++i]);
      break;
    case '--max-output':
      opts.maxOutput = Number(args[++i]);
      break;
    case '--cwd':
      opts.cwd = args[++i];
      break;
    case '-H':
    case '--header': {
      const hdr = args[++i];
      const colonIdx = hdr.indexOf(':');
      if (colonIdx > 0) {
        opts.proxyHeaders.push([hdr.slice(0, colonIdx).trim(), hdr.slice(colonIdx + 1).trim()]);
      }
      break;
    }
    default:
      break;
  }
  return i;
}

export function parseServeFlags(args: string[]): ServeOptions {
  const opts = {
    transport: 'stdio' as 'stdio' | 'http',
    host: '127.0.0.1',
    port: 0,
    bearer: undefined as string | undefined,
    noAuth: false,
    allowOrigins: [] as string[],
    allowHosts: [] as string[],
    envAllow: [] as string[],
    toolTemplates: [] as string[],
    callTimeout: CALL_TIMEOUT_MS,
    concurrency: 1,
    maxOutput: MAX_OUTPUT_DEFAULT,
    cwd: undefined as string | undefined,
    json: false,
    commands: [] as { path: string; name?: string }[],
    proxy: undefined as string | undefined,
    proxyHeaders: [] as Array<[string, string]>,
  };

  for (let i = 0; i < args.length; i++) {
    i = parseSingleFlag(args, i, opts);
  }

  return opts;
}

function expandBearerToken(
  template: string,
  env: Record<string, string | undefined>
): string | undefined {
  if (!containsPlaceholders(template)) return undefined;
  return expandPlaceholdersStrict(template, env);
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function checkContentType(ct: string | undefined): boolean {
  if (!ct) return false;
  return ct.toLowerCase().startsWith('application/json');
}

function checkAcceptHeader(accept: string | undefined): boolean {
  if (!accept) return false;
  const lower = accept.toLowerCase();
  return (
    lower.includes('application/json') ||
    lower.includes('text/event-stream') ||
    lower.includes('*/*')
  );
}

function buildChildEnv(platform: Platform, envAllow: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ALLOWED_ENV_KEYS) {
    if (platform.env[key]) env[key] = platform.env[key]!;
  }
  for (const entry of envAllow) {
    const eqIdx = entry.indexOf('=');
    if (eqIdx > 0) {
      env[entry.slice(0, eqIdx)] = entry.slice(eqIdx + 1);
    } else if (platform.env[entry]) {
      env[entry] = platform.env[entry]!;
    }
  }
  return env;
}

function capOutput(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const half = Math.floor(limit / 2);
  const cut = value.length - limit;
  return `${value.slice(0, half)}\n… ${cut} characters cut …\n${value.slice(value.length - half)}`;
}

const inflightProcs = new Set<SpawnResult>();

async function runCommand(
  platform: Platform,
  cmdPath: string,
  argv: string[],
  childEnv: Record<string, string>,
  stdin: string | undefined,
  timeoutMs: number,
  maxOutput: number,
  cwd: string,
  signal?: AbortSignal
): Promise<ToolRunResult> {
  let proc: SpawnResult;
  try {
    proc = await platform.spawn({
      argv: [cmdPath, ...argv],
      env: childEnv,
      cwd,
    });
  } catch (err) {
    return { stdout: '', stderr: `spawn failed: ${(err as Error).message}`, exitCode: 127 };
  }

  inflightProcs.add(proc);

  if (stdin !== undefined) {
    const writer = proc.stdin.getWriter();
    await writer.write(new TextEncoder().encode(stdin));
    await writer.close();
  } else {
    try {
      await proc.stdin.getWriter().close();
    } catch {}
  }

  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];

  const readStream = async (stream: ReadableStream<Uint8Array>, into: Uint8Array[]) => {
    const r = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await r.read();
        if (done) break;
        into.push(value);
      }
    } finally {
      r.releaseLock();
    }
  };

  const timer = new Promise<'timeout'>((resolve) =>
    setTimeout(() => resolve('timeout'), timeoutMs)
  );

  const abortPromise = signal
    ? new Promise<'timeout'>((resolve) => {
        if (signal.aborted) {
          resolve('timeout');
          return;
        }
        signal.addEventListener('abort', () => resolve('timeout'), { once: true });
      })
    : null;

  const work = Promise.all([
    readStream(proc.stdout, stdoutChunks),
    readStream(proc.stderr, stderrChunks),
    proc.wait(),
  ]);

  const racers: Promise<[void, void, { status: number; signal?: string }] | 'timeout'>[] = [
    work,
    timer,
  ];
  if (abortPromise !== null) racers.push(abortPromise);
  const result = await Promise.race(racers);

  if (result === 'timeout') {
    await proc.kill('SIGTERM');
    if (!signal?.aborted) {
      await new Promise<void>((resolve) => setTimeout(resolve, 5000));
      try {
        await proc.kill('SIGKILL');
      } catch {}
    }
    inflightProcs.delete(proc);
    return { stdout: '', stderr: 'timed out', exitCode: 124 };
  }

  inflightProcs.delete(proc);
  try {
    await proc.kill('SIGTERM');
  } catch {}
  const [, , exitResult] = result;
  const dec = new TextDecoder();
  return {
    stdout: capOutput(dec.decode(concat(stdoutChunks)), maxOutput),
    stderr: capOutput(dec.decode(concat(stderrChunks)), maxOutput),
    exitCode: exitResult.status,
  };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

const KILL_GRACE_MS = 2000;

async function killInflight(): Promise<void> {
  const procs = [...inflightProcs];
  if (procs.length === 0) return;
  await Promise.all(
    procs.map(async (proc) => {
      try {
        await proc.kill('SIGTERM');
      } catch {}
      const exited = await Promise.race([
        proc.wait().then(() => true as const),
        new Promise<false>((r) => setTimeout(() => r(false), KILL_GRACE_MS)),
      ]);
      if (!exited) {
        try {
          await proc.kill('SIGKILL');
        } catch {}
      }
    })
  );
  inflightProcs.clear();
}

async function runHelpForCli(
  platform: Platform,
  filePath: string,
  childEnv: Record<string, string>,
  cwd: string,
  signal?: AbortSignal
): Promise<string> {
  const dashed = await runCommand(
    platform,
    filePath,
    ['--help'],
    childEnv,
    undefined,
    10_000,
    MAX_OUTPUT_DEFAULT,
    cwd,
    signal
  );
  if (dashed.exitCode === 0 && dashed.stdout.trim()) return dashed.stdout;
  if (signal?.aborted) return '';
  const plain = await runCommand(
    platform,
    filePath,
    ['help'],
    childEnv,
    undefined,
    10_000,
    MAX_OUTPUT_DEFAULT,
    cwd,
    signal
  );
  if (plain.exitCode === 0 && plain.stdout.trim()) return plain.stdout;
  return dashed.stdout.trim() ? dashed.stdout : '';
}

async function expandGroupCommands(
  platform: Platform,
  filePath: string,
  commands: CliCommand[],
  childEnv: Record<string, string>,
  cwd: string
): Promise<CliCommand[]> {
  const topNames = new Set(commands.map((c) => c.path[0] ?? ''));
  let current = commands;
  for (const command of commands) {
    if (!isGroupCandidate(command)) continue;
    const group = command.path[0] ?? '';
    const nested = await runCommand(
      platform,
      filePath,
      [group, '--help'],
      childEnv,
      undefined,
      10_000,
      MAX_OUTPUT_DEFAULT,
      cwd
    );
    if (nested.exitCode !== 0 || !nested.stdout.trim()) continue;
    const replaced = nestGroup(current, group, parseHelp(nested.stdout), topNames);
    if (replaced) current = replaced;
  }
  return current;
}

interface PublishedCli {
  name: string;
  path: string;
  commands: CliCommand[];
}

async function discoverCli(
  platform: Platform,
  filePath: string,
  explicitName: string | undefined,
  childEnv: Record<string, string>,
  cwd: string,
  signal?: AbortSignal
): Promise<PublishedCli> {
  const mcp = await runCommand(
    platform,
    filePath,
    ['--mcp'],
    childEnv,
    undefined,
    10_000,
    MAX_OUTPUT_DEFAULT,
    cwd,
    signal
  );
  const override = mcp.exitCode === 0 ? parseMcpOverride(mcp.stdout) : null;
  const helpText =
    override || signal?.aborted
      ? ''
      : await runHelpForCli(platform, filePath, childEnv, cwd, signal);

  if (!override && !helpText.trim()) {
    throw new Error(`${filePath} did not print help or --mcp descriptor`);
  }

  const parsed = override ?? parseHelp(helpText);
  let commands = parsed.commands;

  if (!override) {
    commands = attachGlobalFlags(commands, parsed.globalFlags);
    commands = await expandGroupCommands(platform, filePath, commands, childEnv, cwd);
  }

  return { name: cliPrefix(helpText, filePath, explicitName), path: filePath, commands };
}

interface ToolExecutor {
  invoke: (name: string, args: unknown) => Promise<ToolRunResult>;
  rpcTools: RpcTool[];
}

function createToolExecutor(
  platform: Platform,
  clis: PublishedCli[],
  allTools: ServeTool[],
  childEnv: Record<string, string>,
  options: ServeOptions,
  serveCwd: string
): ToolExecutor {
  const rpcTools: RpcTool[] = allTools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));

  const queues = new Map<string, Promise<unknown>>();

  function enqueue<T>(key: string, job: () => Promise<T>): Promise<T> {
    const previous = queues.get(key) ?? Promise.resolve();
    const run = previous.then(job, job);
    queues.set(
      key,
      run.then(
        () => undefined,
        () => undefined
      )
    );
    return run;
  }

  function invokeTemplateTool(tool: ServeTool, args: unknown): Promise<ToolRunResult> {
    const templateArgs: Record<string, string> = {};
    if (args && typeof args === 'object') {
      for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
        templateArgs[k] = String(v);
      }
    }
    const argv = templateToArgv(tool.description, templateArgs);
    return enqueue('__template__', () =>
      runCommand(
        platform,
        argv[0],
        argv.slice(1),
        childEnv,
        undefined,
        options.callTimeout,
        options.maxOutput,
        serveCwd
      )
    );
  }

  async function executeTool(
    tool: ServeTool,
    cli: PublishedCli,
    args: unknown
  ): Promise<ToolRunResult> {
    if (tool.kind === 'help') {
      const result = await runCommand(
        platform,
        cli.path,
        ['--help'],
        childEnv,
        undefined,
        options.callTimeout,
        options.maxOutput,
        serveCwd
      );
      if (result.exitCode === 0) return result;
      return runCommand(
        platform,
        cli.path,
        ['help'],
        childEnv,
        undefined,
        options.callTimeout,
        options.maxOutput,
        serveCwd
      );
    }

    if (tool.kind === 'invoke') {
      const parsed = readToolArguments(args ?? {});
      if (parsed.error) return { stdout: '', stderr: parsed.error, exitCode: 2 };
      if (!parsed.argv) return { stdout: '', stderr: 'argv is required', exitCode: 2 };
      return runCommand(
        platform,
        cli.path,
        parsed.argv,
        childEnv,
        parsed.stdin,
        options.callTimeout,
        options.maxOutput,
        serveCwd
      );
    }

    const parsed = readToolArguments(args ?? {});
    const command = cli.commands.find((c) => c.path.join('_') === tool.commandPath.join('_'));
    if (!command) return { stdout: '', stderr: `unknown command ${tool.name}`, exitCode: 2 };
    const planned = argvForCommand(command, parsed);
    if ('error' in planned) return { stdout: '', stderr: planned.error, exitCode: 2 };
    return runCommand(
      platform,
      cli.path,
      planned.argv,
      childEnv,
      planned.stdin,
      options.callTimeout,
      options.maxOutput,
      serveCwd
    );
  }

  async function invoke(name: string, args: unknown): Promise<ToolRunResult> {
    const tool = allTools.find((t) => t.name === name);
    if (!tool) return { stdout: '', stderr: `unknown tool ${name}`, exitCode: 1 };

    if (tool.cli === '' && tool.commandPath.length === 0) {
      return invokeTemplateTool(tool, args);
    }

    const cli = clis.find((c) => c.name === tool.cli);
    if (!cli) return { stdout: '', stderr: `unknown cli ${tool.cli}`, exitCode: 1 };

    return enqueue(cli.name, () => executeTool(tool, cli, args));
  }

  return { invoke, rpcTools };
}

async function discoverWithSignal(
  platform: Platform,
  commands: { path: string; name?: string }[],
  childEnv: Record<string, string>,
  cwd: string
): Promise<{ clis: PublishedCli[] } | { exitCode: number; inflightDone?: Promise<void> }> {
  const clis: PublishedCli[] = [];
  let earlyShutdown = false;
  let inflightDone: Promise<void> | undefined;
  const earlyAbort = new AbortController();
  const onShutdown = () => {
    earlyShutdown = true;
    earlyAbort.abort();
    inflightDone = killInflight();
  };
  platform.onSignal?.('SIGTERM', onShutdown);
  platform.onSignal?.('SIGINT', onShutdown);
  for (const cmd of commands) {
    try {
      const cli = await discoverCli(platform, cmd.path, cmd.name, childEnv, cwd, earlyAbort.signal);
      clis.push(cli);
    } catch (err) {
      if (earlyShutdown) return { exitCode: 143, inflightDone };
      await platform.write(2, `mcpcat serve: ${(err as Error).message}\n`);
      return { exitCode: 2 };
    }
  }
  if (earlyShutdown) return { exitCode: 143, inflightDone };
  return { clis };
}

export async function runServe(
  platform: Platform,
  options: ServeOptions,
  version: string
): Promise<number> {
  let resolvedBearer: string | undefined;
  let generatedBearer = false;

  if (options._resolvedBearer) {
    resolvedBearer = options._resolvedBearer;
  } else if (options.bearer) {
    const expanded = expandBearerToken(options.bearer, platform.env);
    if (!expanded) {
      await platform.write(
        2,
        'mcpcat serve: --bearer requires a ${NAME} variable reference, not a literal token. ' +
          "Use --bearer '${MY_TOKEN}' and set MY_TOKEN in the environment.\n"
      );
      return 2;
    }
    resolvedBearer = expanded;
  } else if (options.noAuth) {
    if (options.transport === 'http' && !isLoopbackBind(options.host)) {
      await platform.write(2, 'mcpcat serve: --no-auth is only allowed on loopback\n');
      return 2;
    }
    if (options.transport === 'http') {
      await platform.write(
        2,
        'mcpcat serve: warning: running without authentication on loopback\n'
      );
    }
    resolvedBearer = undefined;
  } else if (options.transport === 'http') {
    if (platform.kind === 'kernel') {
      await platform.write(
        2,
        "mcpcat serve: kernel HTTP serve requires --bearer '${VAR}' or --no-auth\n"
      );
      return 2;
    }
    resolvedBearer = generateToken();
    generatedBearer = true;
  }

  if (options.proxy) {
    return runProxyServe(platform, options, version, resolvedBearer, generatedBearer);
  }

  const serveCwd = options.cwd ?? platform.cwd;
  const childEnv = buildChildEnv(platform, options.envAllow);

  const discovery = await discoverWithSignal(platform, options.commands, childEnv, serveCwd);
  if ('exitCode' in discovery) {
    if (discovery.inflightDone !== undefined) {
      try {
        await discovery.inflightDone;
      } catch {}
    }
    return discovery.exitCode;
  }
  const { clis } = discovery;

  const allTools: ServeTool[] = clis.flatMap((cli) => buildTools(cli.name, cli.commands));

  for (const spec of options.toolTemplates) {
    const tool = parseToolTemplate(spec);
    if (!tool) {
      await platform.write(2, `mcpcat serve: invalid --tool spec: ${spec}\n`);
      return 2;
    }
    allTools.push(tool);
  }

  const executor = createToolExecutor(platform, clis, allTools, childEnv, options, serveCwd);

  const serverName = 'mcpcat-serve';

  if (options.transport === 'stdio') {
    return runStdioServer(platform, executor.rpcTools, executor.invoke, serverName, version);
  }

  return runHttpServer(
    platform,
    options,
    executor.rpcTools,
    executor.invoke,
    serverName,
    version,
    resolvedBearer,
    generatedBearer
  );
}

interface ProxyHandle {
  handle: (raw: string) => Promise<{ status: number; contentType: string; body: string }>;
  shutdown: () => Promise<void>;
}

async function publishBearer(
  platform: Platform,
  token: string,
  port: number,
  listenUrl: string,
  json: boolean
): Promise<string | undefined> {
  if (!json && platform.isatty(2)) {
    await platform.write(2, `mcpcat serve: bearer ${token}\n`);
    return undefined;
  }
  const dir = stateDir(platform);
  await platform.fs.mkdir(dir, { mode: 0o700 });
  const tokenPath = `${dir}/serve-${port}.token`;
  try {
    await platform.fs.unlink?.(tokenPath);
  } catch {}
  await platform.fs.writeFile(tokenPath, token, { mode: 0o600 });
  await platform.write(2, `mcpcat serve: bearer saved to ${tokenPath}\n`);
  if (json) {
    await platform.write(1, `${JSON.stringify({ url: listenUrl, bearerFile: tokenPath })}\n`);
  }
  return tokenPath;
}

import type { ConnectOptions } from '../client/connect.ts';
import { splitShellStyle } from '../client/targets.ts';

function resolveProxyStdio(target: string, version: string): ConnectOptions {
  const rest = target.slice(6);
  const parts = splitShellStyle(rest);
  return { command: parts[0], args: parts.slice(1), version };
}

function resolveProxyUrl(
  target: string,
  headers: Record<string, string>,
  version: string
): ConnectOptions {
  const url = target.startsWith('http') ? target : `https://${target}`;
  return { url, headers, version };
}

async function resolveProxyConfig(
  platform: Platform,
  target: string,
  connectHeaders: Record<string, string>,
  hiddenValues: Set<string>,
  version: string
): Promise<ConnectOptions | string> {
  const config = await MergedConfigSource.load(platform);
  const entry = await config.get(target);
  if (!entry) return `unknown target '${target}'`;
  if ('url' in entry && entry.url) {
    const merged = { ...entry.headers, ...connectHeaders };
    if (entry.headers) {
      for (const v of Object.values(entry.headers)) hiddenValues.add(v);
    }
    return { url: entry.url, headers: merged, version };
  }
  if ('command' in entry && entry.command) {
    return {
      command: entry.command,
      args: (entry as { args?: string[] }).args,
      env: (entry as { env?: Record<string, string> }).env,
      cwd: (entry as { cwd?: string }).cwd,
      version,
    };
  }
  return `target '${target}' has no url or command`;
}

async function buildProxyConnectOpts(
  platform: Platform,
  options: ServeOptions,
  version: string
): Promise<{ connectOpts: ConnectOptions; hiddenValues: Set<string> } | { error: string }> {
  const target = options.proxy!;
  const connectHeaders: Record<string, string> = {};
  const hiddenValues = new Set<string>();

  for (const [k, v] of options.proxyHeaders) {
    const expanded = expandPlaceholdersStrict(v, platform.env);
    if (expanded === undefined) return { error: `unset variable in header '${k}'` };
    const key = k.toLowerCase() === 'authorization' ? 'Authorization' : k;
    connectHeaders[key] = expanded;
    hiddenValues.add(expanded);
  }

  const isUrl =
    target.startsWith('http://') || target.startsWith('https://') || target.includes('.');

  let connectOpts: ConnectOptions;
  if (options.proxyCommand && options.proxyCommand.length > 0) {
    connectOpts = {
      command: options.proxyCommand[0],
      args: options.proxyCommand.slice(1),
      version,
    };
  } else if (target.startsWith('stdio:')) {
    connectOpts = resolveProxyStdio(target, version);
  } else if (isUrl) {
    connectOpts = resolveProxyUrl(target, connectHeaders, version);
  } else {
    const result = await resolveProxyConfig(
      platform,
      target,
      connectHeaders,
      hiddenValues,
      version
    );
    if (typeof result === 'string') return { error: result };
    connectOpts = result;
  }

  if (connectOpts.headers) {
    for (const v of Object.values(connectOpts.headers)) {
      if (v) hiddenValues.add(v);
    }
  }

  return { connectOpts, hiddenValues };
}

async function runProxyServe(
  platform: Platform,
  options: ServeOptions,
  version: string,
  resolvedBearer: string | undefined,
  generatedBearer: boolean
): Promise<number> {
  const built = await buildProxyConnectOpts(platform, options, version);
  if ('error' in built) {
    await platform.write(2, `mcpcat serve --proxy: ${built.error}\n`);
    return 2;
  }

  const { connectOpts, hiddenValues } = built;
  if (resolvedBearer) hiddenValues.add(resolvedBearer);

  const proxy = createProxyHandler({
    target: options.proxy!,
    connectOpts,
    platform,
    hiddenHeaders: hiddenValues,
  });

  if (options.transport === 'stdio') {
    return runProxyStdio(platform, proxy);
  }

  return runProxyHttp(platform, options, proxy, resolvedBearer, generatedBearer);
}

async function runProxyStdio(platform: Platform, proxy: ProxyHandle): Promise<number> {
  const reader = platform.stdin.getReader();
  let buffer = '';
  const dec = new TextDecoder();
  const enc = new TextEncoder();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += dec.decode(value, { stream: true });

      let nlIdx: number;
      while ((nlIdx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nlIdx).trim();
        buffer = buffer.slice(nlIdx + 1);
        if (!line) continue;

        const outcome = await proxy.handle(line);
        if (outcome.status === 202) continue;
        const writer = platform.stdout.getWriter();
        await writer.write(enc.encode(`${outcome.body}\n`));
        writer.releaseLock();
      }
    }
  } finally {
    reader.releaseLock();
    await proxy.shutdown();
  }

  return 0;
}

async function runProxyHttp(
  platform: Platform,
  options: ServeOptions,
  proxy: ProxyHandle,
  resolvedBearer: string | undefined,
  generatedBearer: boolean
): Promise<number> {
  if (!platform.listen) {
    await platform.write(2, 'mcpcat serve --proxy: HTTP transport requires platform.listen\n');
    return 3;
  }

  const boundLoopback = isLoopbackBind(options.host);
  if (!boundLoopback && !resolvedBearer) {
    await platform.write(
      2,
      'mcpcat serve --proxy: --bearer is required when binding off loopback\n'
    );
    return 2;
  }

  const allowedOrigins = new Set(options.allowOrigins);
  const listener = await platform.listen({
    host: options.host,
    port: options.port,
  });
  const actualPort = listener.port;

  const serverOrigins = buildServerOrigins(options.host, actualPort);
  const allowedHosts = buildAllowedHosts(options.host, actualPort, options.allowHosts);

  const listenUrl = `http://${options.host}:${actualPort}/mcp`;
  let tokenFilePath: string | undefined;

  if (generatedBearer && resolvedBearer) {
    tokenFilePath = await publishBearer(
      platform,
      resolvedBearer,
      actualPort,
      listenUrl,
      options.json
    );
  } else {
    if (options.json) {
      await platform.write(1, `${JSON.stringify({ url: listenUrl })}\n`);
    }
  }
  await platform.write(2, `mcpcat serve --proxy: listening on ${listenUrl}\n`);

  if (options.onListening) {
    await options.onListening(actualPort);
  }

  let shutdownRequested = false;

  const shutdown = () => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    listener.close();
    void proxy.shutdown();
    if (tokenFilePath) {
      platform.fs.unlink?.(tokenFilePath).catch(() => {});
    }
  };

  if (platform.onSignal) {
    platform.onSignal('SIGINT', shutdown);
    platform.onSignal('SIGTERM', shutdown);
  }

  const handler = (request: HttpRequest): Promise<HttpResponse> =>
    handleProxyMcpRequest(
      request,
      proxy,
      serverOrigins,
      allowedOrigins,
      allowedHosts,
      resolvedBearer
    );

  try {
    for await (const connection of listener) {
      if (shutdownRequested) break;
      const conn = connection as {
        readonly readable: ReadableStream<Uint8Array>;
        readonly writable: WritableStream<Uint8Array>;
        close(): void;
      };
      handleConnection(conn.readable, conn.writable, handler)
        .catch(() => {})
        .finally(() => {
          try {
            conn.close();
          } catch {}
        });
    }
  } catch {
    if (!shutdownRequested) throw new Error('listener closed unexpectedly');
  }

  return 0;
}

async function handleProxyMcpRequest(
  request: HttpRequest,
  proxy: ProxyHandle,
  serverOrigins: Set<string>,
  allowedOrigins: Set<string>,
  allowedHosts: Set<string>,
  resolvedBearer: string | undefined
): Promise<HttpResponse> {
  if (request.target !== '/mcp') {
    return {
      status: 404,
      reason: 'Not Found',
      headers: { 'content-type': 'text/plain' },
      body: 'Not Found',
    };
  }

  if (request.method !== 'POST') {
    return {
      status: 405,
      reason: 'Method Not Allowed',
      headers: { 'content-type': 'text/plain', allow: 'POST' },
      body: 'Method Not Allowed',
    };
  }

  if (!checkContentType(request.headers['content-type'])) {
    return {
      status: 415,
      reason: 'Unsupported Media Type',
      headers: { 'content-type': 'text/plain' },
      body: 'Content-Type must be application/json',
    };
  }

  if (!checkAcceptHeader(request.headers.accept)) {
    return {
      status: 406,
      reason: 'Not Acceptable',
      headers: { 'content-type': 'text/plain' },
      body: 'Accept must include application/json or text/event-stream',
    };
  }

  const originCheck = checkOrigin(request.headers.origin, serverOrigins, allowedOrigins);
  if (!originCheck.ok) {
    return {
      status: 403,
      reason: 'Forbidden',
      headers: { 'content-type': 'text/plain' },
      body: originCheck.reason ?? 'Forbidden',
    };
  }

  const hostCheck = checkHost(request.headers.host, allowedHosts);
  if (!hostCheck.ok) {
    return {
      status: 403,
      reason: 'Forbidden',
      headers: { 'content-type': 'text/plain' },
      body: hostCheck.reason ?? 'Forbidden',
    };
  }

  if (resolvedBearer) {
    const authHeader = request.headers.authorization;
    const provided = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!provided || !constantTimeEqual(provided, resolvedBearer)) {
      return {
        status: 401,
        reason: 'Unauthorized',
        headers: { 'content-type': 'text/plain' },
        body: 'Unauthorized',
      };
    }
  }

  const outcome = await proxy.handle(request.body);
  return {
    status: outcome.status,
    reason: outcome.status === 200 ? 'OK' : 'Accepted',
    headers: { 'content-type': outcome.contentType },
    body: outcome.body,
  };
}

async function runStdioServer(
  platform: Platform,
  tools: RpcTool[],
  call: (name: string, args: unknown) => Promise<ToolRunResult>,
  serverName: string,
  version: string
): Promise<number> {
  const reader = platform.stdin.getReader();
  let buffer = '';
  const dec = new TextDecoder();
  const enc = new TextEncoder();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += dec.decode(value, { stream: true });

      let nlIdx: number;
      while ((nlIdx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nlIdx).trim();
        buffer = buffer.slice(nlIdx + 1);
        if (!line) continue;

        const outcome = await handleJsonRpc(line, tools, call, serverName, version);
        if (outcome.status === 202) continue;
        const writer = platform.stdout.getWriter();
        await writer.write(enc.encode(`${outcome.body}\n`));
        writer.releaseLock();
      }
    }
  } finally {
    reader.releaseLock();
  }

  return 0;
}

async function runHttpServer(
  platform: Platform,
  options: ServeOptions,
  tools: RpcTool[],
  call: (name: string, args: unknown) => Promise<ToolRunResult>,
  serverName: string,
  version: string,
  resolvedBearer: string | undefined,
  generatedBearer: boolean
): Promise<number> {
  if (!platform.listen) {
    await platform.write(2, 'mcpcat serve: HTTP transport requires platform.listen\n');
    return 3;
  }

  const boundLoopback = isLoopbackBind(options.host);
  if (!boundLoopback && !resolvedBearer) {
    await platform.write(2, 'mcpcat serve: --bearer is required when binding off loopback\n');
    return 2;
  }

  const allowedOrigins = new Set(options.allowOrigins);
  const listener = await platform.listen({ host: options.host, port: options.port });
  const actualPort = listener.port;

  const serverOrigins = buildServerOrigins(options.host, actualPort);
  const allowedHosts = buildAllowedHosts(options.host, actualPort, options.allowHosts);

  const listenUrl = `http://${options.host}:${actualPort}/mcp`;
  let tokenFilePath: string | undefined;

  if (generatedBearer && resolvedBearer) {
    tokenFilePath = await publishBearer(
      platform,
      resolvedBearer,
      actualPort,
      listenUrl,
      options.json
    );
  } else {
    if (options.json) {
      await platform.write(1, `${JSON.stringify({ url: listenUrl })}\n`);
    }
  }
  await platform.write(2, `mcpcat serve: listening on ${listenUrl}\n`);

  let shutdownRequested = false;
  let inflightDone: Promise<void> | undefined;

  const shutdown = () => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    listener.close();
    inflightDone = killInflight();
    if (tokenFilePath) {
      platform.fs.unlink?.(tokenFilePath).catch(() => {});
    }
  };

  if (platform.onSignal) {
    platform.onSignal('SIGINT', shutdown);
    platform.onSignal('SIGTERM', shutdown);
  }

  const handler = (request: HttpRequest): Promise<HttpResponse> =>
    handleMcpRequest(
      request,
      tools,
      call,
      serverName,
      version,
      serverOrigins,
      allowedOrigins,
      allowedHosts,
      resolvedBearer
    );

  try {
    for await (const connection of listener) {
      if (shutdownRequested) break;
      const conn = connection as {
        readonly readable: ReadableStream<Uint8Array>;
        readonly writable: WritableStream<Uint8Array>;
        close(): void;
      };
      handleConnection(conn.readable, conn.writable, handler)
        .catch(() => {})
        .finally(() => {
          try {
            conn.close();
          } catch {}
        });
    }
  } catch {
    if (!shutdownRequested) throw new Error('listener closed unexpectedly');
  }

  if (inflightDone !== undefined) {
    try {
      await inflightDone;
    } catch {}
  }

  return 0;
}

async function handleMcpRequest(
  request: HttpRequest,
  tools: RpcTool[],
  call: (name: string, args: unknown) => Promise<ToolRunResult>,
  serverName: string,
  version: string,
  serverOrigins: Set<string>,
  allowedOrigins: Set<string>,
  allowedHosts: Set<string>,
  resolvedBearer: string | undefined
): Promise<HttpResponse> {
  if (request.target !== '/mcp') {
    return {
      status: 404,
      reason: 'Not Found',
      headers: { 'content-type': 'text/plain' },
      body: 'Not Found',
    };
  }

  if (request.method !== 'POST') {
    return {
      status: 405,
      reason: 'Method Not Allowed',
      headers: { 'content-type': 'text/plain', allow: 'POST' },
      body: 'Method Not Allowed',
    };
  }

  if (!checkContentType(request.headers['content-type'])) {
    return {
      status: 415,
      reason: 'Unsupported Media Type',
      headers: { 'content-type': 'text/plain' },
      body: 'Content-Type must be application/json',
    };
  }

  if (!checkAcceptHeader(request.headers.accept)) {
    return {
      status: 406,
      reason: 'Not Acceptable',
      headers: { 'content-type': 'text/plain' },
      body: 'Accept must include application/json or text/event-stream',
    };
  }

  const originCheck = checkOrigin(request.headers.origin, serverOrigins, allowedOrigins);
  if (!originCheck.ok) {
    return {
      status: 403,
      reason: 'Forbidden',
      headers: { 'content-type': 'text/plain' },
      body: originCheck.reason ?? 'Forbidden',
    };
  }

  const hostCheck = checkHost(request.headers.host, allowedHosts);
  if (!hostCheck.ok) {
    return {
      status: 403,
      reason: 'Forbidden',
      headers: { 'content-type': 'text/plain' },
      body: hostCheck.reason ?? 'Forbidden',
    };
  }

  if (resolvedBearer) {
    const authHeader = request.headers.authorization;
    const provided = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!provided || !constantTimeEqual(provided, resolvedBearer)) {
      return {
        status: 401,
        reason: 'Unauthorized',
        headers: { 'content-type': 'text/plain' },
        body: 'Unauthorized',
      };
    }
  }

  const outcome = await handleJsonRpc(request.body, tools, call, serverName, version);
  return {
    status: outcome.status,
    reason: outcome.status === 200 ? 'OK' : 'Accepted',
    headers: { 'content-type': outcome.contentType },
    body: outcome.body,
  };
}
