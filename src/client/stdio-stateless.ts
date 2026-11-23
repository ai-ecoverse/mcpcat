import type {
  CallToolResult,
  ReadResourceResult,
  Resource,
  ResourceTemplate,
  Tool,
} from '@earendil-works/pi-mcp';
import type { VerboseLogger } from '../cli/verbose.ts';
import type { Platform, SpawnResult } from '../platform/types.ts';
import type {
  CallToolOptions,
  CompleteResult,
  CompletionRef,
  GetPromptResult,
  McpConnection,
  PollEventsResult,
  PromptInfo,
  ServerInfo,
  StreamEnd,
  StreamMessageHandler,
  StreamOptions,
} from './connection.ts';
import {
  dispatchStreamData,
  EventsTransportClosedError,
  idleClock,
  listAllEvents,
  listenParams,
  STALE,
  subscriptionParams,
  webhookMethods,
  within,
} from './events.ts';
import { MODERN_PROTOCOL_VERSION, modernRequestParams } from './modern.ts';
import {
  discoverServerInfo,
  InputRequiredError,
  McpTimeoutError,
  readHiddenTools,
  readListHint,
  StatelessRpcError,
  UnsupportedModernVersionError,
} from './stateless-connection.ts';
import { reapStdio, trackStdio } from './stdio-registry.ts';

const PROTOCOL_VERSION = MODERN_PROTOCOL_VERSION;

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface StdioStatelessOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  platform: Platform;
  version?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  verbose?: VerboseLogger;
}

interface StdioJsonRpc {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  stream(
    method: string,
    params: Record<string, unknown>,
    onMessage: StreamMessageHandler,
    options: StreamOptions
  ): Promise<StreamEnd>;
  close(): void;
  pendingBuffer(): string;
}

const ABORTED = Symbol('aborted');
const MAX_BACKLOG = 1000;

function rpcError(code: number, message: string, data?: unknown): Error {
  return new StatelessRpcError(code, message, data);
}

type Line = string | typeof STALE | typeof ABORTED;

interface LineFeed {
  next(ms: number, signals: (AbortSignal | undefined)[]): Promise<Line>;
  close(): void;
}

function raceAbort<T>(
  promise: Promise<T>,
  signals: (AbortSignal | undefined)[]
): Promise<T | typeof ABORTED> {
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<typeof ABORTED>((resolve) => {
    onAbort = () => resolve(ABORTED);
    for (const s of signals) {
      if (s?.aborted) onAbort();
      else s?.addEventListener('abort', onAbort, { once: true });
    }
  });
  return Promise.race([promise, aborted]).finally(() => {
    for (const s of signals) if (onAbort) s?.removeEventListener('abort', onAbort);
  });
}

export function createLineRouter(
  readLine: () => Promise<string>,
  seen?: (line: string) => void,
  backlog = MAX_BACKLOG
): { open(): LineFeed } {
  const log: string[] = [];
  let base = 0;
  let reading: Promise<void> | undefined;
  let waiters: (() => void)[] = [];
  const feeds = new Set<{ at: number }>();
  const trim = () => {
    let min = base + log.length;
    for (const feed of feeds) min = Math.min(min, feed.at);
    log.splice(0, min - base);
    base = min;
    if (log.length >= backlog) return;
    const ready = waiters;
    waiters = [];
    for (const wake of ready) wake();
  };
  const room = () => new Promise<void>((resolve) => waiters.push(resolve));
  const fill = (): Promise<void> => {
    reading ??= readLine()
      .then((line) => {
        seen?.(line);
        log.push(line);
      })
      .finally(() => {
        reading = undefined;
      });
    return reading;
  };
  return {
    open(): LineFeed {
      const feed = { at: base + log.length };
      feeds.add(feed);
      let pending: Promise<string> | undefined;
      const take = async (): Promise<string> => {
        while (feed.at >= base + log.length) await (log.length >= backlog ? room() : fill());
        const line = log[feed.at - base];
        feed.at++;
        trim();
        return line;
      };
      return {
        async next(ms, signals) {
          pending ??= take();
          try {
            const got = await raceAbort(within(pending, ms), signals);
            if (typeof got === 'string') pending = undefined;
            return got;
          } catch (err) {
            pending = undefined;
            throw err;
          }
        },
        close() {
          feeds.delete(feed);
          trim();
        },
      };
    },
  };
}

function createStdioJsonRpc(
  proc: SpawnResult,
  platform: Platform,
  options: { version?: string; timeoutMs?: number; signal?: AbortSignal; verbose?: VerboseLogger }
): StdioJsonRpc {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let nextId = 1;
  let readBuffer = '';
  const reader = proc.stdout.getReader();
  const { version = '0.0.0', timeoutMs = 60_000, signal: externalSignal, verbose } = options;

  async function readLine(): Promise<string> {
    while (true) {
      const nlIdx = readBuffer.indexOf('\n');
      if (nlIdx >= 0) {
        const line = readBuffer.slice(0, nlIdx).trim();
        readBuffer = readBuffer.slice(nlIdx + 1);
        if (line) return line;
        continue;
      }
      const { done, value } = await reader.read();
      if (done) throw new EventsTransportClosedError('stdio server closed unexpectedly');
      readBuffer += decoder.decode(value, { stream: true });
    }
  }

  const router = createLineRouter(readLine, (line) => {
    if (verbose?.enabled) verbose.response(line);
  });

  let writing: Promise<void> = Promise.resolve();
  function send(msg: string): Promise<void> {
    const write = async () => {
      const writer = proc.stdin.getWriter();
      try {
        await writer.write(encoder.encode(`${msg}\n`));
      } finally {
        writer.releaseLock();
      }
    };
    const next = writing.then(write);
    writing = next.catch(() => {});
    return next;
  }

  function wireBody(id: number, method: string, params: Record<string, unknown>): string {
    return JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params: modernRequestParams(params, PROTOCOL_VERSION, { name: 'mcpcat', version }),
    });
  }

  async function request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = nextId++;
    const body = wireBody(id, method, params);
    const feed = router.open();
    try {
      if (verbose?.enabled) verbose.request(method, body);
      await send(body);
      const deadline = Date.now() + timeoutMs;
      const signal = params._detached === true ? undefined : externalSignal;
      for (;;) {
        const line = await feed.next(Math.max(0, deadline - Date.now()), [signal]);
        if (typeof line !== 'string') throw new McpTimeoutError(method, timeoutMs);
        const parsed = JSON.parse(line) as JsonRpcMessage;
        if (parsed.id === id && parsed.method === undefined) {
          if (parsed.error) {
            throw new StatelessRpcError(parsed.error.code, parsed.error.message, parsed.error.data);
          }
          return parsed.result;
        }
      }
    } finally {
      feed.close();
    }
  }

  async function cancel(id: number, reason: string): Promise<void> {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      method: 'notifications/cancelled',
      params: { requestId: id, reason },
    });
    if (verbose?.enabled) verbose.request('notifications/cancelled', body);
    try {
      await send(body);
    } catch {}
  }

  async function stream(
    method: string,
    params: Record<string, unknown>,
    onMessage: StreamMessageHandler,
    streamOptions: StreamOptions
  ): Promise<StreamEnd> {
    const signals = [externalSignal, streamOptions.signal];
    if (signals.some((s) => s?.aborted)) return 'aborted';
    const id = nextId++;
    const body = wireBody(id, method, params);
    const feed = router.open();
    try {
      if (verbose?.enabled) verbose.request(method, body);
      await send(body);
      const clock = idleClock(onMessage, streamOptions);
      for (;;) {
        const line = await feed.next(clock.left(), signals);
        if (line === ABORTED) {
          await cancel(id, 'interrupted');
          return 'aborted';
        }
        if (line === STALE) {
          await cancel(id, 'no heartbeat');
          return 'stale';
        }
        const end = await dispatchStreamData(line, id, clock.onMessage, undefined, rpcError);
        if (end === 'stopped') await cancel(id, 'done');
        if (end) return end;
      }
    } finally {
      feed.close();
    }
  }

  return {
    request,
    stream,
    close() {
      try {
        reader.releaseLock();
      } catch {}
    },
    pendingBuffer() {
      return readBuffer;
    },
  };
}

function buildServerInfo(discoverResult: Record<string, unknown> | null): ServerInfo {
  const serverInfo = discoverServerInfo(discoverResult);
  return {
    name: serverInfo?.name as string | undefined,
    version: serverInfo?.version as string | undefined,
    title: serverInfo?.title as string | undefined,
    protocolVersion: PROTOCOL_VERSION,
    capabilities: (discoverResult?.capabilities as Record<string, unknown>) ?? {},
    instructions: discoverResult?.instructions as string | undefined,
  };
}

function buildConnectionMethods(
  rpc: StdioJsonRpc,
  discoverResult: Record<string, unknown> | null,
  proc: SpawnResult
): McpConnection {
  let hidden: Record<string, string> = {};
  let hint: string | undefined;
  return {
    async info(): Promise<ServerInfo> {
      return buildServerInfo(discoverResult);
    },
    async listTools(): Promise<Tool[]> {
      const result = (await rpc.request('tools/list', {})) as { tools?: Tool[] } | null;
      hidden = readHiddenTools(result);
      hint = readListHint(result);
      return result?.tools ?? [];
    },
    hiddenTool(name: string): string | undefined {
      return Object.hasOwn(hidden, name) ? hidden[name] : undefined;
    },
    listHint: () => hint,
    async callTool(
      name: string,
      args?: Record<string, unknown>,
      callOptions?: CallToolOptions
    ): Promise<CallToolResult> {
      const params: Record<string, unknown> = { name, arguments: args ?? {} };
      if (callOptions?.inputResponses) {
        params._inputResponses = callOptions.inputResponses;
      }
      if (callOptions?.async) params._tasks = true;
      const result = (await rpc.request('tools/call', params)) as CallToolResult & {
        resultType?: string;
      };
      if ((result.resultType ?? 'complete') === 'input_required') {
        throw new InputRequiredError(
          JSON.stringify({ name, arguments: args ?? {}, result }, null, 2)
        );
      }
      return result;
    },
    async listResources(): Promise<Resource[]> {
      return (
        ((await rpc.request('resources/list', {})) as { resources?: Resource[] } | null)
          ?.resources ?? []
      );
    },
    async listResourceTemplates(): Promise<ResourceTemplate[]> {
      return (
        (
          (await rpc.request('resources/templates/list', {})) as {
            resourceTemplates?: ResourceTemplate[];
          } | null
        )?.resourceTemplates ?? []
      );
    },
    async readResource(uri: string): Promise<ReadResourceResult> {
      return (await rpc.request('resources/read', { uri })) as ReadResourceResult;
    },
    async listPrompts(): Promise<PromptInfo[]> {
      return (
        ((await rpc.request('prompts/list', {})) as { prompts?: PromptInfo[] } | null)?.prompts ??
        []
      );
    },
    async getPrompt(name: string, args?: Record<string, unknown>): Promise<GetPromptResult> {
      return (await rpc.request('prompts/get', { name, arguments: args ?? {} })) as GetPromptResult;
    },
    async complete(
      ref: CompletionRef,
      argument: { name: string; value: string }
    ): Promise<CompleteResult> {
      return (await rpc.request('completion/complete', { ref, argument })) as CompleteResult;
    },
    async getTask(taskId: string): Promise<Record<string, unknown>> {
      return (await rpc.request('tasks/get', { taskId, _tasks: true })) as Record<string, unknown>;
    },
    async cancelTask(taskId: string): Promise<Record<string, unknown>> {
      return (await rpc.request('tasks/cancel', { taskId, _tasks: true })) as Record<
        string,
        unknown
      >;
    },
    events: {
      list: () => listAllEvents(rpc.request),
      ...webhookMethods(rpc.request),
      poll: async (subscription) =>
        ((await rpc.request('events/poll', subscriptionParams(subscription))) ??
          {}) as PollEventsResult,
      stream: (subscription, onMessage, options) =>
        rpc.stream('events/stream', subscriptionParams(subscription), onMessage, options),
      listen: (onMessage, options) =>
        rpc.stream('subscriptions/listen', listenParams(), onMessage, options),
    },
    async close(): Promise<void> {
      rpc.close();
      await reapStdio(proc);
    },
  };
}

export interface StdioFallbackProcess {
  proc: SpawnResult;
  pendingStdout: string;
}

export async function createStdioStatelessConnection(
  options: StdioStatelessOptions
): Promise<McpConnection> {
  const result = await probeStdioStateless(options);
  if ('proc' in result) throw result.error;
  return result;
}

export async function probeStdioStateless(
  options: StdioStatelessOptions
): Promise<McpConnection | { proc: SpawnResult; pendingStdout: string; error: Error }> {
  const inheritedEnv = {
    ...(options.platform.env as Record<string, string>),
    ...options.env,
  };
  const proc = await options.platform.spawn({
    argv: [options.command, ...(options.args ?? [])],
    env: inheritedEnv,
    cwd: options.cwd,
    dieWithParent: true,
  });
  trackStdio(proc);

  const rpc = createStdioJsonRpc(proc, options.platform, {
    version: options.version,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    verbose: options.verbose,
  });

  let discoverRaw;
  try {
    discoverRaw = await rpc.request('server/discover', {});
  } catch (err) {
    const pending = rpc.pendingBuffer();
    rpc.close();
    return { proc, pendingStdout: pending, error: err as Error };
  }

  const discoverResult = discoverRaw as Record<string, unknown>;
  const advertised = discoverResult?.supportedVersions;
  const supported = (Array.isArray(advertised) ? advertised : []).filter(
    (v): v is string => typeof v === 'string'
  );
  if (!supported.includes(PROTOCOL_VERSION)) {
    const pending = rpc.pendingBuffer();
    rpc.close();
    return {
      proc,
      pendingStdout: pending,
      error: new UnsupportedModernVersionError(PROTOCOL_VERSION, supported),
    };
  }
  void readStderr(proc, options.verbose);

  return buildConnectionMethods(rpc, discoverResult, proc);
}

async function readStderr(
  proc: { stderr: ReadableStream<Uint8Array> },
  verbose?: VerboseLogger
): Promise<void> {
  if (!verbose?.enabled) return;
  const reader = proc.stderr.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split('\n')) {
        if (line.trim()) verbose.server(line);
      }
    }
  } catch {}
}
