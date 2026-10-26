import { EVENTS_EXTENSION } from '../client/modern.ts';
import {
  containsPlaceholders,
  expandPlaceholders,
  expandPlaceholdersStrict,
  missingPlaceholders,
  placeholderValues,
} from '../config/expand.ts';
import { MergedConfigSource } from '../config/index.ts';
import { stateDir } from '../config/paths.ts';
import type { Listener, Platform, SpawnResult } from '../platform/types.ts';
import { sanitizeTerminal } from '../render/sanitize.ts';
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
import { EventHub } from './event-hub.ts';
import { handleEventsMessage } from './event-rpc.ts';
import { type EventSpec, logLine, parseEventSpec } from './events.ts';
import { type HttpRequest, type HttpResponse, handleConnection } from './http.ts';
import { handleJsonRpc, type RpcTool, type ToolListing, type ToolRunResult } from './jsonrpc.ts';
import {
  acknowledgedMessage,
  completedMessage,
  createNotifier,
  isInitialize,
  listChangedMessage,
  type Notifier,
  parseCancelled,
  parseListen,
  sseEvent,
  sseResponse,
} from './live.ts';
import {
  buildAllowedHosts,
  buildServerOrigins,
  checkHost,
  checkOrigin,
  isLoopbackBind,
} from './origin.ts';
import { createProxyHandler } from './proxy.ts';
import { createWebMcpHandler, playwrightCliVersion, resolveWebMcpTab } from './webmcp.ts';
import {
  DIALOG_HOLD_MIN_VERSION,
  DIALOG_MODES,
  type DialogHolder,
  startDialogHolder,
} from './webmcp-dialog.ts';
import {
  compareVersions,
  HOLDER_READY_MS,
  type Holder,
  POLYFILL_MIN_VERSION,
  parseCliVersion,
  startHolder,
  TOOLS_CHANGED_MIN_VERSION,
} from './webmcp-polyfill.ts';

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
  webmcp: boolean;
  webmcpTab?: string;
  webmcpTtl: number;
  webmcpAllowConsequential: boolean;
  webmcpPlaywrightCli?: string;
  webmcpCdp?: string;
  webmcpPolyfill: string;
  webmcpReload: boolean;
  webmcpFromOrigins: string[];
  webmcpDialog: string;
  events: string[];
  eventBuffer: number;
  eventHeartbeatMs: number;
  eventPollMs: number;
  webhookAllow: string[];
  webhookTtlMs: number;
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
    webmcp: boolean;
    webmcpAllowConsequential: boolean;
    webmcpTab?: string;
    webmcpTtl: number;
    webmcpPlaywrightCli?: string;
    webmcpCdp?: string;
    webmcpPolyfill: string;
    webmcpReload: boolean;
    webmcpFromOrigins: string[];
    webmcpDialog: string;
    events: string[];
    eventBuffer: number;
    eventHeartbeatMs: number;
    eventPollMs: number;
    webhookAllow: string[];
    webhookTtlMs: number;
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
  } else if (arg === '--webmcp') {
    opts.webmcp = true;
  } else if (arg === '--allow-consequential') {
    opts.webmcpAllowConsequential = true;
  } else if (arg === '--webmcp-reload') {
    opts.webmcpReload = true;
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
    webmcpTab?: string;
    webmcpTtl: number;
    webmcpPlaywrightCli?: string;
    webmcpCdp?: string;
    webmcpPolyfill: string;
    webmcpFromOrigins: string[];
    webmcpDialog: string;
    events: string[];
    eventBuffer: number;
    eventHeartbeatMs: number;
    eventPollMs: number;
    webhookAllow: string[];
    webhookTtlMs: number;
  }
): number {
  const arg = args[i];
  if (!args[i + 1]) return i;
  if (parseEventFlag(arg, args[i + 1], opts)) return i + 1;
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
    case '--tab':
      opts.webmcpTab = args[++i];
      break;
    case '--webmcp-ttl':
      opts.webmcpTtl = Number(args[++i]) * 1000;
      break;
    case '--playwright-cli':
      opts.webmcpPlaywrightCli = args[++i];
      break;
    case '--cdp':
      opts.webmcpCdp = args[++i];
      break;
    case '--webmcp-polyfill':
      opts.webmcpPolyfill = args[++i];
      break;
    case '--webmcp-from-origin':
      opts.webmcpFromOrigins.push(args[++i]);
      break;
    case '--webmcp-dialog':
      opts.webmcpDialog = args[++i];
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

function parseEventFlag(
  arg: string,
  value: string,
  opts: {
    events: string[];
    eventBuffer: number;
    eventHeartbeatMs: number;
    eventPollMs: number;
    webhookAllow: string[];
    webhookTtlMs: number;
  }
): boolean {
  if (arg === '--event') opts.events.push(value);
  else if (arg === '--webhook-allow') opts.webhookAllow.push(value);
  else if (arg === '--event-buffer') opts.eventBuffer = Number(value);
  else if (arg === '--event-heartbeat') opts.eventHeartbeatMs = Number(value) * 1000;
  else if (arg === '--event-poll') opts.eventPollMs = Number(value) * 1000;
  else if (arg === '--webhook-ttl') opts.webhookTtlMs = Number(value) * 1000;
  else return false;
  return true;
}

export function eventFlagsUsed(options: ServeOptions): boolean {
  return options.events.length > 0 || options.webhookAllow.length > 0;
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
    webmcp: false,
    webmcpTab: undefined as string | undefined,
    webmcpTtl: 5000,
    webmcpAllowConsequential: false,
    webmcpPlaywrightCli: undefined as string | undefined,
    webmcpCdp: undefined as string | undefined,
    webmcpPolyfill: 'auto',
    webmcpReload: false,
    webmcpFromOrigins: [] as string[],
    webmcpDialog: 'report',
    events: [] as string[],
    eventBuffer: 1000,
    eventHeartbeatMs: 15_000,
    eventPollMs: 5000,
    webhookAllow: [] as string[],
    webhookTtlMs: 3_600_000,
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

function acceptsEventStream(accept: string | undefined): boolean {
  return (accept ?? '').toLowerCase().includes('text/event-stream');
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
  signal?: AbortSignal,
  cancel?: AbortSignal
): Promise<ToolRunResult> {
  if (cancel?.aborted) return { stdout: '', stderr: 'cancelled', exitCode: 124 };
  let proc: SpawnResult;
  try {
    proc = await platform.spawn({
      argv: [cmdPath, ...argv],
      env: childEnv,
      cwd,
      dieWithParent: true,
    });
  } catch (err) {
    return { stdout: '', stderr: `spawn failed: ${(err as Error).message}`, exitCode: 127 };
  }

  inflightProcs.add(proc);

  const feedStdin = async () => {
    const writer = proc.stdin.getWriter();
    try {
      if (stdin !== undefined) await writer.write(new TextEncoder().encode(stdin));
      await writer.close();
    } catch {}
  };

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

  let timerId: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  let onCancel: (() => void) | undefined;
  const timer = new Promise<'timeout'>((resolve) => {
    timerId = setTimeout(() => resolve('timeout'), timeoutMs);
  });

  const abortPromise = signal
    ? new Promise<'timeout'>((resolve) => {
        if (signal.aborted) {
          resolve('timeout');
          return;
        }
        onAbort = () => resolve('timeout');
        signal.addEventListener('abort', onAbort, { once: true });
      })
    : null;

  const cancelPromise = cancel
    ? new Promise<'cancel'>((resolve) => {
        if (cancel.aborted) {
          resolve('cancel');
          return;
        }
        onCancel = () => resolve('cancel');
        cancel.addEventListener('abort', onCancel, { once: true });
      })
    : null;

  const work = Promise.all([
    readStream(proc.stdout, stdoutChunks),
    readStream(proc.stderr, stderrChunks),
    proc.wait(),
    feedStdin(),
  ]);

  const racers: Promise<
    [void, void, { status: number; signal?: string }, void] | 'timeout' | 'cancel'
  >[] = [work, timer];
  if (abortPromise !== null) racers.push(abortPromise);
  if (cancelPromise !== null) racers.push(cancelPromise);
  let result: Awaited<(typeof racers)[number]>;
  try {
    result = await Promise.race(racers);
  } finally {
    clearTimeout(timerId);
    if (onAbort) signal?.removeEventListener('abort', onAbort);
    if (onCancel) cancel?.removeEventListener('abort', onCancel);
  }

  if (result === 'timeout' || result === 'cancel') {
    if (signal?.aborted) {
      await proc.kill('SIGTERM');
    } else {
      await terminate(proc, CALL_KILL_GRACE_MS);
    }
    inflightProcs.delete(proc);
    const stderr = result === 'cancel' ? 'cancelled' : 'timed out';
    return { stdout: '', stderr, exitCode: 124 };
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
const CALL_KILL_GRACE_MS = 5000;

async function terminate(proc: SpawnResult, graceMs: number): Promise<void> {
  try {
    await proc.kill('SIGTERM');
  } catch {}
  let graceId: ReturnType<typeof setTimeout> | undefined;
  let exited: boolean;
  try {
    exited = await Promise.race([
      proc.wait().then(() => true as const),
      new Promise<false>((r) => {
        graceId = setTimeout(() => r(false), graceMs);
      }),
    ]);
  } finally {
    clearTimeout(graceId);
  }
  if (!exited) {
    try {
      await proc.kill('SIGKILL');
    } catch {}
  }
}

const SIGNAL_EXIT = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 } as const;

async function trapShutdown(
  platform: Platform,
  handler: (sig: keyof typeof SIGNAL_EXIT) => void
): Promise<void> {
  await Promise.all(
    (['SIGINT', 'SIGTERM', 'SIGHUP'] as const).map((sig) =>
      platform.onSignal?.(sig, () => handler(sig))
    )
  );
}

async function killInflight(): Promise<void> {
  const procs = [...inflightProcs];
  if (procs.length === 0) return;
  await Promise.all(procs.map((proc) => terminate(proc, KILL_GRACE_MS)));
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

type ToolCall = (name: string, args: unknown, cancel?: AbortSignal) => Promise<ToolRunResult>;

interface ToolExecutor {
  invoke: ToolCall;
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

  function invokeTemplateTool(
    tool: ServeTool,
    args: unknown,
    cancel?: AbortSignal
  ): Promise<ToolRunResult> {
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
        serveCwd,
        undefined,
        cancel
      )
    );
  }

  async function executeTool(
    tool: ServeTool,
    cli: PublishedCli,
    args: unknown,
    cancel?: AbortSignal
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
        serveCwd,
        undefined,
        cancel
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
        serveCwd,
        undefined,
        cancel
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
        serveCwd,
        undefined,
        cancel
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
      serveCwd,
      undefined,
      cancel
    );
  }

  async function invoke(name: string, args: unknown, cancel?: AbortSignal): Promise<ToolRunResult> {
    const tool = allTools.find((t) => t.name === name);
    if (!tool) return { stdout: '', stderr: `unknown tool ${name}`, exitCode: 1 };

    if (tool.cli === '' && tool.commandPath.length === 0) {
      return invokeTemplateTool(tool, args, cancel);
    }

    const cli = clis.find((c) => c.name === tool.cli);
    if (!cli) return { stdout: '', stderr: `unknown cli ${tool.cli}`, exitCode: 1 };

    return enqueue(cli.name, () => executeTool(tool, cli, args, cancel));
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
  let shutdownExit: number = SIGNAL_EXIT.SIGTERM;
  let inflightDone: Promise<void> | undefined;
  const earlyAbort = new AbortController();
  const onShutdown = (sig: keyof typeof SIGNAL_EXIT) => {
    if (earlyShutdown) return;
    earlyShutdown = true;
    shutdownExit = SIGNAL_EXIT[sig];
    earlyAbort.abort();
    inflightDone = killInflight();
  };
  await trapShutdown(platform, onShutdown);
  for (const cmd of commands) {
    try {
      const cli = await discoverCli(platform, cmd.path, cmd.name, childEnv, cwd, earlyAbort.signal);
      clis.push(cli);
    } catch (err) {
      if (earlyShutdown) return { exitCode: shutdownExit, inflightDone };
      await platform.write(2, `mcpcat serve: ${(err as Error).message}\n`);
      return { exitCode: 2 };
    }
  }
  if (earlyShutdown) return { exitCode: shutdownExit, inflightDone };
  return { clis };
}

async function resolveBearer(
  platform: Platform,
  options: ServeOptions
): Promise<{ resolved: string | undefined; generated: boolean } | { exitCode: number }> {
  if (options._resolvedBearer) {
    return { resolved: options._resolvedBearer, generated: false };
  }
  if (options.bearer) {
    const expanded = expandBearerToken(options.bearer, platform.env);
    if (!expanded) {
      await platform.write(
        2,
        'mcpcat serve: --bearer requires a ${NAME} variable reference, not a literal token. ' +
          "Use --bearer '${MY_TOKEN}' and set MY_TOKEN in the environment.\n"
      );
      return { exitCode: 2 };
    }
    return { resolved: expanded, generated: false };
  }
  if (options.noAuth) {
    if (options.transport === 'http' && !isLoopbackBind(options.host)) {
      await platform.write(2, 'mcpcat serve: --no-auth is only allowed on loopback\n');
      return { exitCode: 2 };
    }
    if (options.transport === 'http') {
      await platform.write(
        2,
        'mcpcat serve: warning: running without authentication on loopback\n'
      );
    }
    return { resolved: undefined, generated: false };
  }
  if (options.transport === 'http') {
    if (platform.kind === 'kernel') {
      await platform.write(
        2,
        "mcpcat serve: kernel HTTP serve requires --bearer '${VAR}' or --no-auth\n"
      );
      return { exitCode: 2 };
    }
    return { resolved: generateToken(), generated: true };
  }
  return { resolved: undefined, generated: false };
}

export async function runServe(
  platform: Platform,
  options: ServeOptions,
  version: string
): Promise<number> {
  const bearerResult = await resolveBearer(platform, options);
  if ('exitCode' in bearerResult) return bearerResult.exitCode;
  const { resolved: resolvedBearer, generated: generatedBearer } = bearerResult;

  if (options.proxy) {
    return runProxyServe(platform, options, version, resolvedBearer, generatedBearer);
  }

  if (options.webmcp) {
    return runWebMcpServe(platform, options, version, resolvedBearer, generatedBearer);
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
  const hub = buildEventHub(platform, options, childEnv, serveCwd);
  if (typeof hub === 'string') {
    await platform.write(2, sanitizeTerminal(`mcpcat serve: ${hub}\n`));
    return 2;
  }

  const serverName = 'mcpcat-serve';

  if (options.transport === 'stdio') {
    return runStdioServer(platform, executor.rpcTools, executor.invoke, serverName, version, hub);
  }

  return runHttpServer(
    platform,
    options,
    executor.rpcTools,
    executor.invoke,
    serverName,
    version,
    resolvedBearer,
    generatedBearer,
    hub
  );
}

function positive(value: number): boolean {
  return Number.isFinite(value) && value > 0;
}

function eventOptionsError(options: ServeOptions): string | undefined {
  if (options.webhookAllow.length > 0 && options.events.length === 0) {
    return '--webhook-allow needs at least one --event';
  }
  for (const prefix of options.webhookAllow) {
    const url = URL.canParse(prefix) ? new URL(prefix) : undefined;
    if (url?.protocol !== 'https:' || !url.href.endsWith('/') || url.search || url.hash) {
      return `--webhook-allow needs an https URL prefix ending in /: ${prefix}`;
    }
  }
  if (!Number.isInteger(options.eventBuffer) || options.eventBuffer < 1) {
    return '--event-buffer needs a positive integer';
  }
  const times: [string, number][] = [
    ['--event-heartbeat', options.eventHeartbeatMs],
    ['--event-poll', options.eventPollMs],
    ['--webhook-ttl', options.webhookTtlMs],
  ];
  for (const [flag, ms] of times) {
    if (!positive(ms)) return `${flag} needs a positive number of seconds`;
  }
  return undefined;
}

function buildEventHub(
  platform: Platform,
  options: ServeOptions,
  env: Record<string, string>,
  cwd: string
): EventHub | string | undefined {
  const error = eventOptionsError(options);
  if (error) return error;
  if (options.events.length === 0) return undefined;
  const specs: EventSpec[] = [];
  for (const raw of options.events) {
    const spec = parseEventSpec(raw);
    if (!spec) return `invalid --event spec: ${raw}`;
    if (specs.some((s) => s.name === spec.name)) return `duplicate --event name: ${spec.name}`;
    specs.push(spec);
  }
  return new EventHub({
    platform,
    specs,
    env,
    cwd,
    bufferSize: options.eventBuffer,
    heartbeatMs: options.eventHeartbeatMs,
    pollMs: options.eventPollMs,
    webhook:
      options.webhookAllow.length > 0
        ? { allow: options.webhookAllow.map((p) => new URL(p).href), ttlMs: options.webhookTtlMs }
        : undefined,
    stop: (proc) => terminate(proc, KILL_GRACE_MS),
    log: logLine(platform),
  });
}

function eventsExtensions(hub: EventHub | undefined): Record<string, unknown> | undefined {
  return hub ? { [EVENTS_EXTENSION]: {} } : undefined;
}

interface ProxyHandle {
  handle: (raw: string) => Promise<{ status: number; contentType: string; body: string }>;
  shutdown: () => Promise<void>;
}

interface ServeAddress {
  url: string;
  loopbackUrl?: string;
}

function serveAddress(platform: Platform, host: string, port: number): ServeAddress {
  if (platform.kind !== 'kernel') return { url: `http://${host}:${port}/mcp` };
  return {
    url: `http://${port}.kernel.localhost/mcp`,
    loopbackUrl: `http://127.0.0.1:${port}/mcp`,
  };
}

async function publishBearer(
  platform: Platform,
  token: string,
  port: number,
  address: ServeAddress,
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
    await platform.write(1, `${JSON.stringify({ ...address, bearerFile: tokenPath })}\n`);
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

function unsetIn(
  header: string,
  value: string,
  env: Record<string, string | undefined>
): string | undefined {
  const missing = missingPlaceholders(value, env);
  if (missing.length === 0) return undefined;
  return `unset variable ${missing.join(', ')} in header '${header}'`;
}

function hide(
  hidden: Set<string>,
  template: string,
  expanded: string,
  env: Record<string, string | undefined>
): void {
  if (template) hidden.add(template);
  if (expanded) hidden.add(expanded);
  for (const p of placeholderValues(template, env)) hidden.add(p);
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
    const expanded: Record<string, string> = {};
    for (const [k, v] of Object.entries(entry.headers ?? {})) {
      const missing = unsetIn(k, v, platform.env);
      if (missing) return missing;
      expanded[k] = expandPlaceholders(v, platform.env);
      hide(hiddenValues, v, expanded[k], platform.env);
    }
    const merged = { ...expanded, ...connectHeaders };
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
    const missing = unsetIn(k, v, platform.env);
    if (missing) return { error: missing };
    const expanded = expandPlaceholders(v, platform.env);
    const key = k.toLowerCase() === 'authorization' ? 'Authorization' : k;
    connectHeaders[key] = expanded;
    hide(hiddenValues, v, expanded, platform.env);
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

async function resolvePlaywrightCli(
  platform: Platform,
  explicit?: string
): Promise<string | undefined> {
  if (explicit) return explicit;
  if (platform.kind === 'kernel') return 'playwright-cli';
  const pathEnv = platform.env.PATH ?? '';
  const windows = pathEnv.includes(';');
  const names = windows
    ? ['playwright-cli.exe', 'playwright-cli.cmd', 'playwright-cli']
    : ['playwright-cli'];
  for (const dir of pathEnv.split(windows ? ';' : ':')) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = `${dir.replace(/[\\/]+$/, '')}/${name}`;
      if (await platform.fs.exists(candidate).catch(() => false)) return 'playwright-cli';
    }
  }
  return undefined;
}

async function listenOrReport(
  platform: Platform,
  options: ServeOptions,
  label: string
): Promise<Listener | number> {
  try {
    return await platform.listen!({ host: options.host, port: options.port });
  } catch (err) {
    const { code, message } = err as { code?: unknown; message?: unknown };
    const reason =
      code === 'EADDRINUSE' || /EADDRINUSE/.test(String(message))
        ? 'address already in use'
        : String(message ?? err);
    const host = options.host.includes(':') ? `[${options.host}]` : options.host;
    await platform.write(
      2,
      sanitizeTerminal(`${label}: cannot listen on ${host}:${options.port}: ${reason}\n`)
    );
    return 3;
  }
}

async function runWebMcpServe(
  platform: Platform,
  options: ServeOptions,
  version: string,
  resolvedBearer: string | undefined,
  generatedBearer: boolean
): Promise<number> {
  const usage = webmcpUsageError(options);
  if (usage) {
    await platform.write(2, sanitizeTerminal(`mcpcat serve --webmcp: ${usage}\n`));
    return 2;
  }
  const cliPath = await resolvePlaywrightCli(platform, options.webmcpPlaywrightCli);
  if (!cliPath) {
    await platform.write(
      2,
      'mcpcat serve --webmcp: playwright-cli not found on PATH. Install it with: curl -fsSL https://get.sliccy.ai/playwright-cli | sh\n'
    );
    return 3;
  }

  const cdp = options.webmcpCdp ?? platform.env.SLICC_CDP_URL;

  let tab = options.webmcpTab;
  if (!tab) {
    const resolved = await resolveWebMcpTab(platform, {
      playwrightCli: cliPath,
      cdp,
      callTimeoutMs: options.callTimeout,
    });
    if (resolved.notFound) {
      await platform.write(
        2,
        'mcpcat serve --webmcp: playwright-cli not found. Install it with: curl -fsSL https://get.sliccy.ai/playwright-cli | sh\n'
      );
      return 3;
    }
    if (!resolved.tab) {
      await platform.write(2, sanitizeTerminal(`mcpcat serve --webmcp: ${resolved.error}\n`));
      return 3;
    }
    tab = resolved.tab;
  }

  const cliVersion =
    options.webmcpPolyfill === 'off' && options.webmcpDialog === 'report'
      ? undefined
      : parseCliVersion(
          await playwrightCliVersion(platform, {
            playwrightCli: cliPath,
            callTimeoutMs: options.callTimeout,
          })
        );
  const polyfill = startPolyfill(platform, options, cliPath, cdp, tab, cliVersion);
  if (polyfill.oldVersion) {
    await platform.write(
      2,
      sanitizeTerminal(
        `mcpcat serve --webmcp: the WebMCP polyfill needs playwright-cli ${POLYFILL_MIN_VERSION} or newer (found ${polyfill.oldVersion}); continuing without it. Update with: curl -fsSL https://get.sliccy.ai/playwright-cli | sh\n`
      )
    );
  }
  const dialogs = await startDialogs(platform, options, cliPath, cdp, tab, cliVersion);
  const { holder } = polyfill;
  const notifier = polyfill.live ? createNotifier() : undefined;
  const handler = createWebMcpHandler(platform, {
    playwrightCli: cliPath,
    tab,
    cdp,
    allowConsequential: options.webmcpAllowConsequential,
    ttlMs: options.webmcpTtl,
    callTimeoutMs: options.callTimeout,
    maxOutput: options.maxOutput,
    fromOrigins: options.webmcpFromOrigins,
    dialogs,
    beforeList: holder ? () => holder.ready() : undefined,
    late: () => isLate(holder),
    emptyHint: (unavailable) => emptyToolsHint(options, polyfill, unavailable),
    topLoader: () => holder?.status().loaderId,
    onChange: notifier ? () => notifier.notify() : undefined,
  });
  holder?.onDocument(() => {
    handler.invalidateCache();
    notifier?.notify();
  });
  if (notifier) holder?.onToolsChanged((event) => void handler.applyToolsChanged(event));

  try {
    return await serveWebMcpHandler(
      platform,
      options,
      handler,
      version,
      resolvedBearer,
      generatedBearer,
      notifier
    );
  } finally {
    notifier?.close();
    handler.close();
    await Promise.all([holder?.stop(), dialogs?.stop()]);
  }
}

async function startDialogs(
  platform: Platform,
  options: ServeOptions,
  playwrightCli: string,
  cdp: string | undefined,
  tab: string,
  found: string | undefined
): Promise<DialogHolder | undefined> {
  if (options.webmcpDialog === 'report') return undefined;
  if (found && compareVersions(found, DIALOG_HOLD_MIN_VERSION) < 0) {
    await platform.write(
      2,
      sanitizeTerminal(
        `mcpcat serve --webmcp: --webmcp-dialog ${options.webmcpDialog} needs playwright-cli ${DIALOG_HOLD_MIN_VERSION} or newer (found ${found}); reporting JavaScript dialogs instead. Update with: curl -fsSL https://get.sliccy.ai/playwright-cli | sh\n`
      )
    );
    return undefined;
  }
  return startDialogHolder(platform, {
    playwrightCli,
    cdp,
    tab,
    accept: options.webmcpDialog === 'accept',
    readyTimeoutMs: Math.min(options.callTimeout, HOLDER_READY_MS),
    report: (line) => platform.write(2, line),
  });
}

function webmcpUsageError(options: ServeOptions): string | undefined {
  if (options.webmcpPolyfill !== 'auto' && options.webmcpPolyfill !== 'off') {
    return `--webmcp-polyfill must be auto or off, not ${options.webmcpPolyfill}`;
  }
  if (!(DIALOG_MODES as readonly string[]).includes(options.webmcpDialog)) {
    return `--webmcp-dialog must be report, dismiss or accept, not ${options.webmcpDialog}`;
  }
  if (options.webmcpDialog === 'accept' && !options.webmcpAllowConsequential) {
    return '--webmcp-dialog accept confirms page dialogs on your behalf, so it needs --allow-consequential; use --webmcp-dialog dismiss otherwise';
  }
  if (options.webmcpReload && options.webmcpPolyfill === 'off') {
    return '--webmcp-reload needs the polyfill; drop --webmcp-polyfill off';
  }
  for (const origin of options.webmcpFromOrigins) {
    let parsed: URL | undefined;
    try {
      parsed = new URL(origin);
    } catch {}
    if (!parsed || !/^https?:$/.test(parsed.protocol) || parsed.origin !== origin) {
      return `--webmcp-from-origin takes an origin such as https://example.com, not ${origin}`;
    }
  }
  return undefined;
}

interface PolyfillState {
  holder?: Holder;
  oldVersion?: string;
  live?: boolean;
}

function startPolyfill(
  platform: Platform,
  options: ServeOptions,
  playwrightCli: string,
  cdp: string | undefined,
  tab: string,
  found: string | undefined
): PolyfillState {
  if (options.webmcpPolyfill === 'off') return {};
  if (found && compareVersions(found, POLYFILL_MIN_VERSION) < 0) {
    return { oldVersion: found };
  }
  const live = found !== undefined && compareVersions(found, TOOLS_CHANGED_MIN_VERSION) >= 0;
  const holder = startHolder(platform, {
    playwrightCli,
    cdp,
    tab,
    reload: options.webmcpReload,
    readyTimeoutMs: Math.min(options.callTimeout, HOLDER_READY_MS),
    watch: live,
    report: (line) => platform.write(2, line),
  });
  return { holder, live };
}

function isLate(holder: Holder | undefined): boolean {
  const status = holder?.status();
  return status?.mode === 'polyfill' && status.late;
}

function emptyToolsHint(
  options: ServeOptions,
  polyfill: PolyfillState,
  unavailable: boolean
): string | undefined {
  if (options.webmcpPolyfill === 'off') {
    return unavailable
      ? 'WebMCP is not enabled in this browser and --webmcp-polyfill is off; drop --webmcp-polyfill off to inject the WebMCP polyfill'
      : undefined;
  }
  if (polyfill.oldVersion) {
    return `the page shows no WebMCP tools, and the WebMCP polyfill needs playwright-cli ${POLYFILL_MIN_VERSION} or newer (found ${polyfill.oldVersion})`;
  }
  const status = polyfill.holder?.status();
  if (isLate(polyfill.holder)) {
    return 'the page may check for WebMCP only when it loads, before the polyfill was injected; reload the tab, or restart with --webmcp-reload (it reloads the tab)';
  }
  if (!unavailable) return undefined;
  if (status?.error) {
    return `WebMCP is unavailable on this page and the WebMCP polyfill is not running (${status.error})`;
  }
  return 'WebMCP is unavailable on this page (the WebMCP polyfill skips protected and unverified documents)';
}

async function serveWebMcpHandler(
  platform: Platform,
  options: ServeOptions,
  handler: ReturnType<typeof createWebMcpHandler>,
  version: string,
  resolvedBearer: string | undefined,
  generatedBearer: boolean,
  notifier: Notifier | undefined
): Promise<number> {
  const probe = await handler.getRpcTools();
  if (probe === null) {
    await platform.write(
      2,
      'mcpcat serve --webmcp: playwright-cli not found. Install it with: curl -fsSL https://get.sliccy.ai/playwright-cli | sh\n'
    );
    return 3;
  }
  if (probe.hint) {
    await platform.write(2, sanitizeTerminal(`mcpcat serve --webmcp: ${probe.hint}\n`));
  }

  const serverName = 'mcpcat-webmcp';

  const getTools = async (): Promise<ToolListing> => (await handler.getRpcTools()) ?? { tools: [] };
  const callTool = (name: string, args: unknown) => handler.callTool(name, args);

  if (options.transport === 'stdio') {
    return runWebMcpStdio(platform, getTools, callTool, serverName, version, notifier);
  }

  return runWebMcpHttp(
    platform,
    options,
    getTools,
    callTool,
    serverName,
    version,
    resolvedBearer,
    generatedBearer,
    notifier
  );
}

async function runWebMcpStdio(
  platform: Platform,
  getTools: () => Promise<ToolListing>,
  callTool: (name: string, args: unknown) => Promise<ToolRunResult>,
  serverName: string,
  version: string,
  notifier: Notifier | undefined
): Promise<number> {
  const reader = platform.stdin.getReader();
  let buffer = '';
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let chain = Promise.resolve();
  const out = (body: string): Promise<void> => {
    chain = chain.then(async () => {
      const writer = platform.stdout.getWriter();
      try {
        await writer.write(enc.encode(`${body}\n`));
      } finally {
        writer.releaseLock();
      }
    });
    return chain;
  };
  const live = notifier ? stdioLive(notifier, out) : undefined;

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
        if (live?.take(line)) continue;

        const outcome = await handleJsonRpc(
          line,
          getTools,
          callTool,
          serverName,
          version,
          notifier !== undefined
        );
        if (outcome.status === 202) continue;
        await out(outcome.body);
      }
    }
  } finally {
    reader.releaseLock();
  }

  return 0;
}

function stdioLive(notifier: Notifier, out: (body: string) => Promise<void>) {
  const subscriptions = new Set<string | number>();
  let initialized = false;
  notifier.subscribe({
    change() {
      if (initialized) void out(listChangedMessage()).catch(() => {});
      for (const id of subscriptions) void out(listChangedMessage(id)).catch(() => {});
    },
    close() {},
  });
  return {
    take(line: string): boolean {
      const listen = parseListen(line);
      if (listen) {
        if (listen.tools) subscriptions.add(listen.id);
        void out(acknowledgedMessage(listen)).catch(() => {});
        return true;
      }
      const cancelled = parseCancelled(line);
      if (cancelled !== undefined) subscriptions.delete(cancelled);
      initialized ||= isInitialize(line);
      return false;
    },
  };
}

async function runWebMcpHttp(
  platform: Platform,
  options: ServeOptions,
  getTools: () => Promise<ToolListing>,
  callTool: (name: string, args: unknown) => Promise<ToolRunResult>,
  serverName: string,
  version: string,
  resolvedBearer: string | undefined,
  generatedBearer: boolean,
  notifier: Notifier | undefined
): Promise<number> {
  if (!platform.listen) {
    await platform.write(2, 'mcpcat serve --webmcp: HTTP transport requires platform.listen\n');
    return 3;
  }

  const boundLoopback = isLoopbackBind(options.host);
  if (!boundLoopback && !resolvedBearer) {
    await platform.write(
      2,
      'mcpcat serve --webmcp: --bearer is required when binding off loopback\n'
    );
    return 2;
  }

  const allowedOrigins = new Set(options.allowOrigins);
  const listener = await listenOrReport(platform, options, 'mcpcat serve --webmcp');
  if (typeof listener === 'number') return listener;
  const actualPort = listener.port;

  const serverOrigins = buildServerOrigins(options.host, actualPort);
  const allowedHosts = buildAllowedHosts(options.host, actualPort, options.allowHosts);

  const address = serveAddress(platform, options.host, actualPort);
  const listenUrl = address.url;
  let tokenFilePath: string | undefined;
  let shutdownRequested = false;

  const shutdown = () => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    listener.close();
    notifier?.close();
    if (tokenFilePath) {
      platform.fs.unlink?.(tokenFilePath).catch(() => {});
    }
  };

  await trapShutdown(platform, shutdown);

  if (generatedBearer && resolvedBearer) {
    tokenFilePath = await publishBearer(
      platform,
      resolvedBearer,
      actualPort,
      address,
      options.json
    );
    if (shutdownRequested && tokenFilePath) {
      await platform.fs.unlink?.(tokenFilePath).catch(() => {});
    }
  } else {
    if (options.json) {
      await platform.write(1, `${JSON.stringify(address)}\n`);
    }
  }

  if (!shutdownRequested) {
    await platform.write(2, `mcpcat serve --webmcp: listening on ${listenUrl}\n`);
    if (options.onListening) {
      await options.onListening(actualPort);
    }
  }

  const handler = (request: HttpRequest): Promise<HttpResponse> =>
    handleWebMcpRequest(request, {
      getTools,
      callTool,
      serverName,
      version,
      serverOrigins,
      allowedOrigins,
      allowedHosts,
      resolvedBearer,
      notifier,
    });

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

interface WebMcpRequestContext {
  getTools: () => Promise<ToolListing>;
  callTool: (name: string, args: unknown) => Promise<ToolRunResult>;
  serverName: string;
  version: string;
  serverOrigins: Set<string>;
  allowedOrigins: Set<string>;
  allowedHosts: Set<string>;
  resolvedBearer: string | undefined;
  notifier: Notifier | undefined;
}

function plain(status: number, reason: string, body: string, extra = {}): HttpResponse {
  return { status, reason, headers: { 'content-type': 'text/plain', ...extra }, body };
}

function webMcpShape(request: HttpRequest, live: boolean): HttpResponse | undefined {
  if (request.target !== '/mcp') return plain(404, 'Not Found', 'Not Found');
  if (live && request.method === 'GET') {
    return acceptsEventStream(request.headers.accept)
      ? undefined
      : plain(406, 'Not Acceptable', 'Accept must include text/event-stream');
  }
  if (request.method !== 'POST') {
    return plain(405, 'Method Not Allowed', 'Method Not Allowed', {
      allow: live ? 'GET, POST' : 'POST',
    });
  }
  if (!checkContentType(request.headers['content-type'])) {
    return plain(415, 'Unsupported Media Type', 'Content-Type must be application/json');
  }
  if (!checkAcceptHeader(request.headers.accept)) {
    return plain(
      406,
      'Not Acceptable',
      'Accept must include application/json or text/event-stream'
    );
  }
  return undefined;
}

function webMcpGuard(request: HttpRequest, ctx: WebMcpRequestContext): HttpResponse | undefined {
  const originCheck = checkOrigin(request.headers.origin, ctx.serverOrigins, ctx.allowedOrigins);
  if (!originCheck.ok) return plain(403, 'Forbidden', originCheck.reason ?? 'Forbidden');
  const hostCheck = checkHost(request.headers.host, ctx.allowedHosts);
  if (!hostCheck.ok) return plain(403, 'Forbidden', hostCheck.reason ?? 'Forbidden');
  if (ctx.resolvedBearer) {
    const authHeader = request.headers.authorization;
    const provided = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!provided || !constantTimeEqual(provided, ctx.resolvedBearer)) {
      return plain(401, 'Unauthorized', 'Unauthorized');
    }
  }
  return undefined;
}

async function handleWebMcpRequest(
  request: HttpRequest,
  ctx: WebMcpRequestContext
): Promise<HttpResponse> {
  const { notifier } = ctx;
  const rejected = webMcpShape(request, notifier !== undefined) ?? webMcpGuard(request, ctx);
  if (rejected) return rejected;
  if (notifier && request.method === 'GET') {
    return sseResponse(notifier, [], listChangedMessage(), undefined);
  }
  const listen = notifier ? parseListen(request.body) : undefined;
  if (notifier && listen) {
    return sseResponse(
      notifier,
      [acknowledgedMessage(listen)],
      listen.tools ? listChangedMessage(listen.id) : undefined,
      completedMessage(listen.id)
    );
  }
  const outcome = await handleJsonRpc(
    request.body,
    ctx.getTools,
    ctx.callTool,
    ctx.serverName,
    ctx.version,
    notifier !== undefined
  );
  return {
    status: outcome.status,
    reason: outcome.status === 200 ? 'OK' : 'Accepted',
    headers: { 'content-type': outcome.contentType },
    body: outcome.body,
  };
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
  const listener = await listenOrReport(platform, options, 'mcpcat serve --proxy');
  if (typeof listener === 'number') {
    await proxy.shutdown();
    return listener;
  }
  const actualPort = listener.port;

  const serverOrigins = buildServerOrigins(options.host, actualPort);
  const allowedHosts = buildAllowedHosts(options.host, actualPort, options.allowHosts);

  const address = serveAddress(platform, options.host, actualPort);
  const listenUrl = address.url;
  let tokenFilePath: string | undefined;
  let shutdownRequested = false;
  let proxyDone: Promise<void> | undefined;

  const shutdown = () => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    listener.close();
    proxyDone = proxy.shutdown();
    if (tokenFilePath) {
      platform.fs.unlink?.(tokenFilePath).catch(() => {});
    }
  };

  await trapShutdown(platform, shutdown);

  if (generatedBearer && resolvedBearer) {
    tokenFilePath = await publishBearer(
      platform,
      resolvedBearer,
      actualPort,
      address,
      options.json
    );
    if (shutdownRequested && tokenFilePath) {
      await platform.fs.unlink?.(tokenFilePath).catch(() => {});
    }
  } else {
    if (options.json) {
      await platform.write(1, `${JSON.stringify(address)}\n`);
    }
  }

  if (!shutdownRequested) {
    await platform.write(2, `mcpcat serve --proxy: listening on ${listenUrl}\n`);
    if (options.onListening) {
      await options.onListening(actualPort);
    }
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

  await proxyDone;
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
  version: string,
  hub: EventHub | undefined
): Promise<number> {
  const reader = platform.stdin.getReader();
  let buffer = '';
  const dec = new TextDecoder();
  const enc = new TextEncoder();
  let chain = Promise.resolve();
  const out = (body: string): Promise<void> => {
    chain = chain.then(async () => {
      const writer = platform.stdout.getWriter();
      try {
        await writer.write(enc.encode(`${body}\n`));
      } finally {
        writer.releaseLock();
      }
    });
    return chain;
  };
  const streams = hub ? new StdioStreams(hub, out) : undefined;
  let stop: (code: number) => void = () => {};
  const stopped = new Promise<number>((resolve) => {
    stop = resolve;
  });
  await trapShutdown(platform, (sig) => stop(SIGNAL_EXIT[sig]));

  const serve = async (): Promise<number> => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return 0;
      buffer += dec.decode(value, { stream: true });

      let nlIdx: number;
      while ((nlIdx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nlIdx).trim();
        buffer = buffer.slice(nlIdx + 1);
        if (!line) continue;
        if (streams && (await streams.take(line))) continue;

        const outcome = await handleJsonRpc(
          line,
          tools,
          call,
          serverName,
          version,
          false,
          eventsExtensions(hub)
        );
        if (outcome.status === 202) continue;
        await out(outcome.body);
      }
    }
  };

  try {
    return await Promise.race([serve(), stopped]);
  } finally {
    await reader.cancel().catch(() => {});
    await Promise.all([streams?.close(), killInflight()]);
  }
}

class StdioStreams {
  private readonly hub: EventHub;
  private readonly out: (body: string) => Promise<void>;
  private readonly open = new Map<string | number, AbortController>();

  constructor(hub: EventHub, out: (body: string) => Promise<void>) {
    this.hub = hub;
    this.out = out;
  }

  async take(line: string): Promise<boolean> {
    const outcome = await handleEventsMessage(this.hub, line, 'stdio');
    if (!outcome) return false;
    if (outcome.kind === 'cancel') {
      this.open.get(outcome.id)?.abort();
      return false;
    }
    if (outcome.kind === 'reply') {
      await this.out(outcome.body);
      return true;
    }
    const stop = new AbortController();
    this.open.set(outcome.id, stop);
    void outcome.open.run(this.out, stop.signal).finally(() => this.open.delete(outcome.id));
    return true;
  }

  async close(): Promise<void> {
    for (const stop of this.open.values()) stop.abort();
    await this.hub.close();
  }
}

async function runHttpServer(
  platform: Platform,
  options: ServeOptions,
  tools: RpcTool[],
  call: ToolCall,
  serverName: string,
  version: string,
  resolvedBearer: string | undefined,
  generatedBearer: boolean,
  hub: EventHub | undefined
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
  const listener = await listenOrReport(platform, options, 'mcpcat serve');
  if (typeof listener === 'number') return listener;
  const actualPort = listener.port;

  const serverOrigins = buildServerOrigins(options.host, actualPort);
  const allowedHosts = buildAllowedHosts(options.host, actualPort, options.allowHosts);

  const address = serveAddress(platform, options.host, actualPort);
  const listenUrl = address.url;
  let tokenFilePath: string | undefined;
  let shutdownRequested = false;
  let inflightDone: Promise<void> | undefined;
  const stopCalls = new AbortController();
  const activeCalls = new Set<Promise<HttpResponse>>();

  const shutdown = () => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    listener.close();
    stopCalls.abort();
    inflightDone = Promise.all([killInflight(), hub?.close()]).then(() => {});
    if (tokenFilePath) {
      platform.fs.unlink?.(tokenFilePath).catch(() => {});
    }
  };

  await trapShutdown(platform, shutdown);

  if (generatedBearer && resolvedBearer) {
    tokenFilePath = await publishBearer(
      platform,
      resolvedBearer,
      actualPort,
      address,
      options.json
    );
    if (shutdownRequested && tokenFilePath) {
      await platform.fs.unlink?.(tokenFilePath).catch(() => {});
    }
  } else {
    if (options.json) {
      await platform.write(1, `${JSON.stringify(address)}\n`);
    }
  }

  if (!shutdownRequested) {
    await platform.write(2, `mcpcat serve: listening on ${listenUrl}\n`);
  }

  const handler = (request: HttpRequest, signal: AbortSignal): Promise<HttpResponse> => {
    const cancel = new AbortController();
    const relay = () => cancel.abort();
    signal.addEventListener('abort', relay, { once: true });
    stopCalls.signal.addEventListener('abort', relay, { once: true });
    if (signal.aborted || stopCalls.signal.aborted) relay();
    const pending = handleMcpRequest(
      request,
      tools,
      (name, args) => call(name, args, cancel.signal),
      serverName,
      version,
      serverOrigins,
      allowedOrigins,
      allowedHosts,
      resolvedBearer,
      hub
    ).finally(() => {
      signal.removeEventListener('abort', relay);
      stopCalls.signal.removeEventListener('abort', relay);
      activeCalls.delete(pending);
    });
    activeCalls.add(pending);
    return pending;
  };

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
  await Promise.allSettled([...activeCalls]);

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
  resolvedBearer: string | undefined,
  hub: EventHub | undefined
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

  const events = hub ? await httpEvents(hub, request, resolvedBearer) : undefined;
  if (events) return events;
  const outcome = await handleJsonRpc(
    request.body,
    tools,
    call,
    serverName,
    version,
    false,
    eventsExtensions(hub)
  );
  return {
    status: outcome.status,
    reason: outcome.status === 200 ? 'OK' : 'Accepted',
    headers: { 'content-type': outcome.contentType },
    body: outcome.body,
  };
}

async function httpEvents(
  hub: EventHub,
  request: HttpRequest,
  resolvedBearer: string | undefined
): Promise<HttpResponse | undefined> {
  const principal = resolvedBearer ? 'bearer' : undefined;
  const outcome = await handleEventsMessage(hub, request.body, principal, request.headers);
  if (!outcome || outcome.kind === 'cancel') return undefined;
  if (outcome.kind === 'reply') {
    const status = outcome.status ?? 200;
    return {
      status,
      reason: status === 200 ? 'OK' : 'Bad Request',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: outcome.body,
    };
  }
  return {
    status: 200,
    reason: 'OK',
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    body: '',
    stream: (send, signal) => outcome.open.run((body) => send(sseEvent(body)), signal),
  };
}
