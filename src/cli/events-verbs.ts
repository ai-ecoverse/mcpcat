import { coerceArgsBySchema, mergeArgs } from '../args/coerce.ts';
import type {
  EventDescriptor,
  EventOccurrence,
  EventSubscription,
  EventsApi,
  McpConnection,
  PollEventsResult,
  StreamEnd,
} from '../client/connection.ts';
import { EventsTransportClosedError } from '../client/events.ts';
import { EVENTS_EXTENSION, META_SUBSCRIPTION_ID } from '../client/modern.ts';
import { reap } from '../client/reap.ts';
import { McpAuthError, StatelessRpcError } from '../client/stateless-connection.ts';
import type { Platform, SpawnResult } from '../platform/types.ts';
import { type Redactor, renderErrorJson } from '../render/result.ts';
import { sanitizeJson, sanitizeTerminal } from '../render/sanitize.ts';
import {
  EXIT_AUTH,
  EXIT_CONNECTION,
  EXIT_OK,
  EXIT_RPC_ERROR,
  EXIT_USAGE,
  McpcatError,
} from './exit-codes.ts';

export const EVENTS_USAGE =
  'usage: mcpcat <target> --experimental events --list-events\n' +
  '       mcpcat <target> --experimental events [options] --subscribe <event> [--<arg> value…] [-- cmd…]';

const DELIVERY_MODES = new Set(['push', 'poll', 'webhook']);
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 60_000;
const DEFAULT_POLL_MS = 30_000;
const POLL_FLOOR_MS = 1000;
const BACKOFF_START_MS = 500;
const BACKOFF_MAX_MS = 30_000;
const SEEN_LIMIT = 256;
const HANDLER_GRACE_MS = 2000;
const FORBIDDEN = -32024;

export interface EventsArgs {
  target: string;
  mode: 'list' | 'subscribe';
  event?: string;
  eventArgs: string[];
  handler?: string[];
  dataArg?: string;
  delivery?: 'push' | 'poll' | 'webhook';
  webhookUrl?: string;
  webhookSecretFile?: string;
  webhookSecret?: string;
  webhookTtlMs?: number;
  webhookKeep: boolean;
  webhookOnce: boolean;
  webhookUnsubscribe: boolean;
  cursor?: string;
  sinceNow: boolean;
  cursorFile?: string;
  maxAgeMs?: number;
  count?: number;
  heartbeatTimeoutMs: number;
  noValidate: boolean;
  headers: Record<string, string>;
  protocolVersion?: string;
  timeoutMs?: number;
  verbose: boolean;
  silent: boolean;
  json: boolean;
  noInput: boolean;
}

export const EVENTS_VALUE_FLAGS = new Set([
  '-H',
  '--header',
  '-d',
  '--protocol-version',
  '-m',
  '--timeout',
  '--root',
  '--respond',
  '-o',
  '--output',
  '--memory',
  '-s',
  '--server',
  '-e',
  '--budget',
  '--delivery',
  '--cursor',
  '--since',
  '--cursor-file',
  '--max-age',
  '--count',
  '--heartbeat-timeout',
  '--webhook-url',
  '--webhook-secret-file',
  '--webhook-ttl',
]);

export function isEventsInvocation(args: string[], verbs: readonly string[]): boolean {
  let positionals = 0;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') return false;
    if (arg === '--list-events' || arg === '--subscribe') return true;
    if (EVENTS_VALUE_FLAGS.has(arg)) {
      i++;
      continue;
    }
    if (arg.startsWith('-')) continue;
    positionals++;
    if (positionals === 1 && verbs.includes(arg)) return false;
    if (positionals >= 2) return false;
  }
  return false;
}

function seconds(flag: string, raw: string): number | string {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return `${flag} needs a positive number of seconds`;
  return Math.round(n * 1000);
}

type Setter = (out: EventsArgs, value: string, flag: string) => string | undefined;

function millis(key: 'maxAgeMs' | 'heartbeatTimeoutMs' | 'timeoutMs' | 'webhookTtlMs'): Setter {
  return (out, value, flag) => {
    const ms = seconds(flag, value);
    if (typeof ms === 'string') return ms;
    out[key] = ms;
    return undefined;
  };
}

const header: Setter = (out, value) => {
  const colon = value.indexOf(':');
  if (colon > 0) out.headers[value.slice(0, colon).trim()] = value.slice(colon + 1).trim();
  return undefined;
};

const VALUE_OPTIONS: Record<string, Setter> = {
  '--delivery': (out, value) => {
    if (!DELIVERY_MODES.has(value)) return '--delivery must be push, poll or webhook';
    out.delivery = value as 'push' | 'poll' | 'webhook';
    return undefined;
  },
  '--webhook-url': (out, value) => {
    if (!URL.canParse(value) || new URL(value).protocol !== 'https:') {
      return '--webhook-url needs an https URL';
    }
    out.webhookUrl = value;
    return undefined;
  },
  '--webhook-secret-file': (out, value) => {
    out.webhookSecretFile = value;
    return undefined;
  },
  '--webhook-ttl': millis('webhookTtlMs'),
  '--cursor': (out, value) => {
    out.cursor = value;
    return undefined;
  },
  '--since': (out, value) => {
    if (value === 'now') out.sinceNow = true;
    else out.cursor = value;
    return undefined;
  },
  '--cursor-file': (out, value) => {
    out.cursorFile = value;
    return undefined;
  },
  '--count': (out, value) => {
    const n = Number(value);
    if (!Number.isInteger(n) || n < 1) return '--count needs a positive integer';
    out.count = n;
    return undefined;
  },
  '-d': (out, value) => {
    out.dataArg = value;
    return undefined;
  },
  '--protocol-version': (out, value) => {
    out.protocolVersion = value;
    return undefined;
  },
  '--max-age': millis('maxAgeMs'),
  '--heartbeat-timeout': millis('heartbeatTimeoutMs'),
  '-m': millis('timeoutMs'),
  '--timeout': millis('timeoutMs'),
  '-H': header,
  '--header': header,
};

const FLAG_OPTIONS: Record<string, (out: EventsArgs) => void> = {
  '-v': (out) => {
    out.verbose = true;
  },
  '--verbose': (out) => {
    out.verbose = true;
  },
  '--silent': (out) => {
    out.silent = true;
  },
  '--json': (out) => {
    out.json = true;
  },
  '--no-input': (out) => {
    out.noInput = true;
  },
  '--no-validate': (out) => {
    out.noValidate = true;
  },
  '--webhook-keep': (out) => {
    out.webhookKeep = true;
  },
  '--webhook-once': (out) => {
    out.webhookOnce = true;
  },
  '--webhook-unsubscribe': (out) => {
    out.webhookUnsubscribe = true;
  },
};

function flagOrTarget(out: EventsArgs, arg: string): string | undefined {
  if (Object.hasOwn(FLAG_OPTIONS, arg)) {
    FLAG_OPTIONS[arg](out);
    return undefined;
  }
  if (arg.startsWith('-')) return `unknown option ${arg} for --list-events or --subscribe`;
  if (out.target) return `unexpected argument '${arg}'`;
  out.target = arg;
  return undefined;
}

function parseLead(
  lead: string[],
  out: EventsArgs
): { list: boolean; rest: string[] | undefined } | string {
  let list = false;
  for (let i = 0; i < lead.length; i++) {
    const arg = lead[i];
    const value = lead[i + 1];
    if (arg === '--list-events') {
      list = true;
    } else if (arg === '--subscribe') {
      if (value === undefined || value.startsWith('-')) return '--subscribe needs an event name';
      out.event = value;
      return { list, rest: lead.slice(i + 2) };
    } else if (Object.hasOwn(VALUE_OPTIONS, arg)) {
      if (value === undefined) return `${arg} needs a value`;
      const error = VALUE_OPTIONS[arg](out, value, arg);
      if (error) return error;
      i++;
    } else {
      const error = flagOrTarget(out, arg);
      if (error) return error;
    }
  }
  return { list, rest: undefined };
}

export function parseEventsArgs(args: string[]): EventsArgs | string {
  const out: EventsArgs = {
    target: '',
    mode: 'list',
    eventArgs: [],
    sinceNow: false,
    heartbeatTimeoutMs: DEFAULT_HEARTBEAT_TIMEOUT_MS,
    noValidate: false,
    headers: {},
    verbose: false,
    silent: false,
    json: false,
    noInput: false,
    webhookKeep: false,
    webhookOnce: false,
    webhookUnsubscribe: false,
  };
  const sep = args.indexOf('--');
  const parsed = parseLead(sep < 0 ? args : args.slice(0, sep), out);
  if (typeof parsed === 'string') return parsed;
  const subscribe = parsed.rest !== undefined;
  if (!out.target) return 'no target given';
  if (parsed.list && subscribe) return '--list-events and --subscribe do not combine';
  if (sep >= 0) {
    const tail = args.slice(sep + 1);
    if (!subscribe) return 'a command after -- needs --subscribe';
    if (tail.length === 0) return 'no command after --';
    out.handler = tail;
  }
  out.mode = subscribe ? 'subscribe' : 'list';
  out.eventArgs = parsed.rest ?? [];
  return webhookArgsError(out) ?? out;
}

function webhookArgsError(out: EventsArgs): string | undefined {
  const flags = out.webhookKeep || out.webhookOnce || out.webhookUnsubscribe;
  const anything = flags || out.webhookSecretFile !== undefined || out.webhookTtlMs !== undefined;
  if (!out.webhookUrl) {
    if (out.delivery === 'webhook') return '--delivery webhook needs --webhook-url';
    return anything ? 'the --webhook-… options need --webhook-url' : undefined;
  }
  if (out.delivery !== undefined && out.delivery !== 'webhook') {
    return `--webhook-url does not combine with --delivery ${out.delivery}`;
  }
  if (out.mode !== 'subscribe') return '--webhook-url needs --subscribe';
  if (out.handler) {
    return 'with --webhook-url the server delivers to that URL, not to mcpcat; run the command from the receiver (for example ntfy subscribe <topic> <cmd>)';
  }
  if (out.count !== undefined) return '--count does not apply to --webhook-url';
  out.delivery = 'webhook';
  return undefined;
}

const SECRET = /^whsec_[A-Za-z0-9+/]+={0,2}$/;

function validSecret(secret: string): boolean {
  if (!SECRET.test(secret)) return false;
  try {
    const n = atob(secret.slice(6)).length;
    return n >= 24 && n <= 64;
  } catch {
    return false;
  }
}

export async function webhookSecret(platform: Platform, file: string | undefined): Promise<string> {
  if (file && (await platform.fs.exists(file))) {
    const secret = new TextDecoder().decode(await platform.fs.readFile(file)).trim();
    if (validSecret(secret)) return secret;
    throw new McpcatError(
      EXIT_USAGE,
      `--webhook-secret-file ${file} does not hold a whsec_ secret of 24 to 64 bytes`
    );
  }
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const secret = `whsec_${btoa(String.fromCharCode(...bytes))}`;
  if (file) await platform.fs.writeFile(file, `${secret}\n`, { mode: 0o600 });
  return secret;
}

function formatDescriptor(event: EventDescriptor): string {
  const lines: string[] = [];
  const modes = Array.isArray(event.delivery) ? event.delivery.join(', ') : '';
  const desc = event.description ? `  ${event.description}` : '';
  lines.push(`${event.name}${modes ? ` [${modes}]` : ''}${desc}`);
  for (const [label, schema] of [
    ['Input schema', event.inputSchema],
    ['Payload schema', event.payloadSchema],
  ] as const) {
    if (!schema) continue;
    lines.push(`  ${label}:`);
    lines.push(`    ${JSON.stringify(schema, null, 2).split('\n').join('\n    ')}`);
  }
  return lines.join('\n');
}

async function listEvents(
  platform: Platform,
  events: EventDescriptor[],
  json: boolean
): Promise<number> {
  if (json) {
    await platform.write(1, `${sanitizeJson(JSON.stringify({ events }, null, 2))}\n`);
    return EXIT_OK;
  }
  const text = events.length === 0 ? '(no events)' : events.map(formatDescriptor).join('\n\n');
  await platform.write(1, sanitizeTerminal(`${text}\n`));
  return EXIT_OK;
}

interface CursorState {
  cursor: string | null;
  eventIds: string[];
}

async function loadCursorFile(platform: Platform, path: string): Promise<CursorState> {
  if (!(await platform.fs.exists(path))) return { cursor: null, eventIds: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(await platform.fs.readFile(path)));
  } catch (err) {
    throw new McpcatError(
      EXIT_USAGE,
      `cannot read --cursor-file ${path}: ${(err as Error).message}`
    );
  }
  const state = parsed as { cursor?: unknown; eventIds?: unknown } | null;
  const cursor = typeof state?.cursor === 'string' ? state.cursor : null;
  const ids = Array.isArray(state?.eventIds)
    ? state.eventIds.filter((v): v is string => typeof v === 'string')
    : [];
  return { cursor, eventIds: ids.slice(-SEEN_LIMIT) };
}

function pickDelivery(
  event: EventDescriptor,
  forced: 'push' | 'poll' | 'webhook' | undefined
): 'push' | 'poll' | 'webhook' | string {
  const offered = Array.isArray(event.delivery) ? event.delivery : [];
  const list = offered.join(', ') || 'none';
  if (forced) {
    return offered.includes(forced)
      ? forced
      : `event '${event.name}' does not offer ${forced} delivery (offers: ${list})`;
  }
  if (offered.includes('push')) return 'push';
  if (offered.includes('poll')) return 'poll';
  const hint = offered.includes('webhook') ? '; for webhook, give --webhook-url' : '';
  return `event '${event.name}' offers no delivery mode mcpcat can use (offers: ${list}; mcpcat does poll and push${hint})`;
}

function occurrenceOf(params: Record<string, unknown>): EventOccurrence {
  const { _meta, ...rest } = params;
  const occurrence = rest as unknown as EventOccurrence;
  if (_meta && typeof _meta === 'object' && !Array.isArray(_meta)) {
    const { [META_SUBSCRIPTION_ID]: _sid, ...meta } = _meta as Record<string, unknown>;
    if (Object.keys(meta).length > 0) occurrence._meta = meta;
  }
  return occurrence;
}

function errorText(params: Record<string, unknown>): string {
  const err = params.error as { code?: unknown; message?: unknown; data?: unknown } | undefined;
  const message = typeof err?.message === 'string' ? err.message : 'unknown error';
  const code = typeof err?.code === 'number' ? ` ${err.code}` : '';
  const data = err?.data !== undefined ? ` ${JSON.stringify(err.data)}` : '';
  return `${message}${code ? ` (${code.trim()})` : ''}${data}`;
}

function envValue(value: string): string {
  return value.replace(/\0/g, '');
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

function isRetryable(err: unknown): boolean {
  if (err instanceof StatelessRpcError) return false;
  if (err instanceof EventsTransportClosedError) return false;
  if (err instanceof McpAuthError) return false;
  if (err instanceof McpcatError) return false;
  return true;
}

function fatal(err: unknown): unknown {
  if (err instanceof EventsTransportClosedError) {
    return new McpcatError(EXIT_CONNECTION, err.message);
  }
  if (err instanceof StatelessRpcError && err.code === FORBIDDEN) {
    return new McpcatError(EXIT_AUTH, err.message);
  }
  return err;
}

interface SubscriberOptions {
  platform: Platform;
  api: EventsApi;
  event: EventDescriptor;
  args: EventsArgs;
  arguments: Record<string, unknown>;
  signal: AbortSignal;
  redact: Redactor;
}

class Subscriber {
  private cursor: string | null = null;
  private persisted: string | null | undefined;
  private seen: string[] = [];
  private seenSet = new Set<string>();
  private delivered = 0;
  private readonly o: SubscriberOptions;

  constructor(options: SubscriberOptions) {
    this.o = options;
  }

  async start(): Promise<number> {
    const { args, platform } = this.o;
    if (args.cursorFile) {
      const state = await loadCursorFile(platform, args.cursorFile);
      this.cursor = state.cursor;
      this.persisted = state.cursor;
      for (const id of state.eventIds) this.remember(id);
    }
    if (args.sinceNow) this.cursor = null;
    if (args.cursor !== undefined) this.cursor = args.cursor;
    const mode = pickDelivery(this.o.event, args.delivery);
    return mode === 'push' ? await this.push() : await this.poll();
  }

  private notice(text: string): Promise<void> {
    if (this.o.args.silent) return Promise.resolve();
    return this.o.platform.write(2, sanitizeTerminal(`mcpcat: ${this.o.redact(text)}\n`));
  }

  private remember(id: string): void {
    if (this.seenSet.has(id)) return;
    this.seen.push(id);
    this.seenSet.add(id);
    while (this.seen.length > SEEN_LIMIT) this.seenSet.delete(this.seen.shift()!);
  }

  private done(): boolean {
    return this.o.args.count !== undefined && this.delivered >= this.o.args.count;
  }

  private async persist(force = false): Promise<void> {
    const path = this.o.args.cursorFile;
    if (!path || this.o.signal.aborted || (!force && this.persisted === this.cursor)) return;
    const body = JSON.stringify({
      event: this.o.event.name,
      cursor: this.cursor,
      eventIds: this.seen,
    });
    const tmp = `${path}.tmp`;
    await this.o.platform.fs.writeFile(tmp, `${body}\n`);
    await this.o.platform.fs.rename(tmp, path);
    this.persisted = this.cursor;
  }

  private async moveTo(cursor: unknown, truncated: unknown): Promise<void> {
    const next = typeof cursor === 'string' ? cursor : null;
    if (truncated === true && next !== null) {
      await this.notice(`events for ${this.o.event.name} were skipped (truncated); resuming`);
    }
    this.cursor = next;
    await this.persist();
  }

  private async deliver(occurrence: EventOccurrence, cursor: string | undefined) {
    if (this.o.signal.aborted) return;
    const id = typeof occurrence.eventId === 'string' ? occurrence.eventId : undefined;
    if (id !== undefined && this.seenSet.has(id)) {
      if (cursor !== undefined) await this.moveTo(cursor, false);
      return;
    }
    await this.handle(occurrence);
    if (id !== undefined) this.remember(id);
    this.delivered++;
    if (cursor !== undefined) this.cursor = cursor;
    await this.persist(true);
  }

  private async handle(occurrence: EventOccurrence): Promise<void> {
    const { platform, args, signal } = this.o;
    const line = `${sanitizeJson(JSON.stringify(occurrence))}\n`;
    if (!args.handler) {
      await platform.write(1, line);
      return;
    }
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(platform.env)) if (v !== undefined) env[k] = v;
    env.MCPCAT_EVENT_ID = envValue(String(occurrence.eventId ?? ''));
    env.MCPCAT_EVENT_NAME = envValue(String(occurrence.name ?? ''));
    if (typeof occurrence.cursor === 'string')
      env.MCPCAT_EVENT_CURSOR = envValue(occurrence.cursor);
    else delete env.MCPCAT_EVENT_CURSOR;
    let proc: SpawnResult;
    try {
      proc = await platform.spawn({ argv: args.handler, env, cwd: platform.cwd });
    } catch (err) {
      throw new McpcatError(EXIT_USAGE, `cannot run ${args.handler[0]}: ${(err as Error).message}`);
    }
    const stop = () => void reap(proc, HANDLER_GRACE_MS);
    if (signal.aborted) stop();
    else signal.addEventListener('abort', stop, { once: true });
    const feed = async () => {
      const writer = proc.stdin.getWriter();
      try {
        await writer.write(new TextEncoder().encode(line));
        await writer.close();
      } catch {}
    };
    const pipe = async (stream: ReadableStream<Uint8Array>, fd: number) => {
      const reader = stream.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          await platform.write(fd, value);
        }
      } catch {
      } finally {
        reader.releaseLock();
      }
    };
    try {
      const [, , , status] = await Promise.all([
        feed(),
        pipe(proc.stdout, 1),
        pipe(proc.stderr, 2),
        proc.wait(),
      ]);
      if (status.status !== 0 && !signal.aborted) {
        const how = status.signal ? `was killed by ${status.signal}` : `exited ${status.status}`;
        await this.notice(`${args.handler[0]} ${how} for event ${String(occurrence.eventId)}`);
      }
    } finally {
      signal.removeEventListener('abort', stop);
    }
  }

  private async backoff(delay: number, reason: string, verb = 'retrying'): Promise<number> {
    await this.notice(`${reason}; ${verb} in ${Math.round(delay / 100) / 10}s`);
    await sleep(delay, this.o.signal);
    return Math.min(delay * 2, BACKOFF_MAX_MS);
  }

  private subscription(withMaxAge: boolean): EventSubscription {
    const { event, args } = this.o;
    const sub: EventSubscription = {
      name: event.name,
      arguments: this.o.arguments,
      cursor: this.cursor,
    };
    if (withMaxAge && args.maxAgeMs !== undefined) sub.maxAgeMs = args.maxAgeMs;
    return sub;
  }

  private async batch(result: PollEventsResult): Promise<number | undefined> {
    const { signal } = this.o;
    for (const occurrence of Array.isArray(result.events) ? result.events : []) {
      if (this.done() || signal.aborted) return 0;
      await this.deliver(occurrence, undefined);
    }
    await this.moveTo(result.cursor, result.truncated);
    if (this.done()) return 0;
    if (result.hasMore === true) return undefined;
    const wait = typeof result.nextPollMs === 'number' ? result.nextPollMs : DEFAULT_POLL_MS;
    return Math.max(wait, POLL_FLOOR_MS);
  }

  private async poll(): Promise<number> {
    const { api, signal } = this.o;
    let ok = false;
    let delay = BACKOFF_START_MS;
    while (!signal.aborted) {
      let result: PollEventsResult;
      try {
        result = await api.poll(this.subscription(!ok));
      } catch (err) {
        if (signal.aborted) break;
        if (!ok || !isRetryable(err)) throw fatal(err);
        delay = await this.backoff(delay, `poll failed (${(err as Error).message})`);
        continue;
      }
      ok = true;
      delay = BACKOFF_START_MS;
      const wait = await this.batch(result);
      if (wait === 0) return EXIT_OK;
      if (wait !== undefined) await sleep(wait, signal);
    }
    return EXIT_OK;
  }

  private async onStreamMessage(
    method: string,
    params: Record<string, unknown>
  ): Promise<'stop' | undefined> {
    if (method === 'notifications/events/active') {
      await this.moveTo(params.cursor, params.truncated);
      return undefined;
    }
    if (method === 'notifications/events/heartbeat') {
      await this.moveTo(params.cursor, false);
      return undefined;
    }
    if (method === 'notifications/events/event') {
      const cursor = typeof params.cursor === 'string' ? params.cursor : undefined;
      await this.deliver(occurrenceOf(params), cursor);
      return this.done() ? 'stop' : undefined;
    }
    if (method === 'notifications/events/error') {
      await this.notice(`server reported an error for ${this.o.event.name}: ${errorText(params)}`);
      return undefined;
    }
    if (method === 'notifications/events/terminated') {
      const code = (params.error as { code?: unknown } | undefined)?.code;
      throw new McpcatError(
        code === FORBIDDEN ? EXIT_AUTH : EXIT_RPC_ERROR,
        `subscription to ${this.o.event.name} terminated by the server: ${errorText(params)}`
      );
    }
    return undefined;
  }

  private async push(): Promise<number> {
    const { api, signal, args } = this.o;
    let active = false;
    let delay = BACKOFF_START_MS;
    while (!signal.aborted) {
      let end: StreamEnd;
      let opened = false;
      try {
        end = await api.stream(
          this.subscription(true),
          async (method, params) => {
            if (!opened) {
              opened = true;
              active = true;
              delay = BACKOFF_START_MS;
            }
            return this.onStreamMessage(method, params);
          },
          { idleMs: args.heartbeatTimeoutMs, signal }
        );
      } catch (err) {
        if (signal.aborted) break;
        if (!active || !isRetryable(err)) throw fatal(err);
        delay = await this.backoff(
          delay,
          `stream failed (${(err as Error).message})`,
          'reconnecting'
        );
        continue;
      }
      if (end === 'stopped' || end === 'aborted' || signal.aborted) break;
      if (!active) {
        throw new McpcatError(
          EXIT_CONNECTION,
          end === 'stale'
            ? `no notifications/events/active within ${args.heartbeatTimeoutMs / 1000}s`
            : 'the server ended events/stream before it was active'
        );
      }
      const reason =
        end === 'stale'
          ? `no event or heartbeat for ${args.heartbeatTimeoutMs / 1000}s`
          : end === 'closed'
            ? 'the server closed the stream'
            : 'the stream dropped';
      delay = await this.backoff(delay, reason, 'reconnecting');
    }
    return EXIT_OK;
  }
}

const REFRESH_MIN_MS = 1000;
const REFRESH_MAX_MS = 3_600_000;

class WebhookClient {
  private readonly o: SubscriberOptions;
  private cursor: string | null = null;
  private eventIds: string[] = [];
  private lastError: unknown = null;

  constructor(options: SubscriberOptions) {
    this.o = options;
  }

  private notice(text: string): Promise<void> {
    if (this.o.args.silent) return Promise.resolve();
    return this.o.platform.write(2, sanitizeTerminal(`mcpcat: ${this.o.redact(text)}\n`));
  }

  private key(): Record<string, unknown> {
    return { name: this.o.event.name, arguments: this.o.arguments };
  }

  private params(first: boolean): Record<string, unknown> {
    const { args } = this.o;
    return {
      ...this.key(),
      delivery: { mode: 'webhook', url: args.webhookUrl, secret: args.webhookSecret },
      cursor: this.cursor,
      ...(first && args.maxAgeMs !== undefined ? { maxAgeMs: args.maxAgeMs } : {}),
      ...(args.webhookTtlMs !== undefined ? { ttlMs: args.webhookTtlMs } : {}),
    };
  }

  async start(): Promise<number> {
    const { args, platform } = this.o;
    if (args.cursorFile) {
      const state = await loadCursorFile(platform, args.cursorFile);
      this.cursor = state.cursor;
      this.eventIds = state.eventIds;
    }
    if (args.sinceNow) this.cursor = null;
    if (args.cursor !== undefined) this.cursor = args.cursor;
    if (args.webhookUnsubscribe) {
      await this.o.api.unsubscribe({ ...this.key(), delivery: { url: args.webhookUrl } });
      await this.notice(`unsubscribed ${this.o.event.name} from ${args.webhookUrl}`);
      return EXIT_OK;
    }
    return this.loop();
  }

  private async loop(): Promise<number> {
    const { signal, args } = this.o;
    let ok = false;
    let delay = BACKOFF_START_MS;
    while (!signal.aborted) {
      let result: Record<string, unknown>;
      try {
        result = await this.o.api.subscribe(this.params(!ok));
      } catch (err) {
        if (signal.aborted) break;
        if (!ok || !isRetryable(err)) throw fatal(err);
        await this.notice(
          `refresh failed (${(err as Error).message}); retrying in ${delay / 1000}s`
        );
        await sleep(delay, signal);
        delay = Math.min(delay * 2, BACKOFF_MAX_MS);
        continue;
      }
      ok = true;
      delay = BACKOFF_START_MS;
      await this.record(result);
      if (args.webhookOnce) return EXIT_OK;
      await sleep(this.refreshIn(result.refreshBefore), signal);
    }
    if (ok && !args.webhookKeep) await this.unsubscribe();
    return EXIT_OK;
  }

  private refreshIn(refreshBefore: unknown): number {
    const at = typeof refreshBefore === 'string' ? Date.parse(refreshBefore) : Number.NaN;
    if (Number.isNaN(at)) return REFRESH_MAX_MS;
    return Math.min(Math.max((at - Date.now()) / 2, REFRESH_MIN_MS), REFRESH_MAX_MS);
  }

  private async record(result: Record<string, unknown>): Promise<void> {
    const { resultType: _r, ...status } = result;
    await this.o.platform.write(1, `${sanitizeJson(JSON.stringify(status))}\n`);
    if (status.truncated === true && typeof status.cursor === 'string') {
      await this.notice(`events for ${this.o.event.name} were skipped (truncated)`);
    }
    const lastError =
      (status.deliveryStatus as { lastError?: unknown } | undefined)?.lastError ?? null;
    if (lastError !== this.lastError && lastError !== null) {
      await this.notice(`the server reports webhook delivery failing (${String(lastError)})`);
    }
    this.lastError = lastError;
    this.cursor = typeof status.cursor === 'string' ? status.cursor : null;
    const path = this.o.args.cursorFile;
    if (!path) return;
    const body = JSON.stringify({
      event: this.o.event.name,
      cursor: this.cursor,
      eventIds: this.eventIds,
    });
    await this.o.platform.fs.writeFile(`${path}.tmp`, `${body}\n`);
    await this.o.platform.fs.rename(`${path}.tmp`, path);
  }

  private async unsubscribe(): Promise<void> {
    try {
      await this.o.api.unsubscribe({ ...this.key(), delivery: { url: this.o.args.webhookUrl } });
    } catch (err) {
      await this.notice(`could not unsubscribe (${(err as Error).message}); it expires on its own`);
    }
  }
}

export interface RunEventsOptions {
  base: Record<string, unknown>;
  signal: AbortSignal;
  redact: Redactor;
}

async function fail(
  platform: Platform,
  options: RunEventsOptions,
  json: boolean,
  code: number,
  msg: string
) {
  const kind = code === EXIT_USAGE ? 'usage' : 'error';
  if (json) await renderErrorJson(platform, kind, msg, undefined, undefined, options.redact);
  else await platform.write(2, sanitizeTerminal(`mcpcat: ${options.redact(msg)}\n`));
  return code;
}

function eventArguments(
  event: EventDescriptor,
  args: EventsArgs,
  base: Record<string, unknown>
): Record<string, unknown> | string {
  const schema = event.inputSchema ?? { type: 'object', properties: {} };
  if (args.eventArgs.length > 0) {
    const c = coerceArgsBySchema(args.eventArgs, schema, {
      noValidate: args.noValidate || args.dataArg !== undefined,
    });
    if (!c.ok) return c.error;
    return mergeArgs(base, c.value);
  }
  if (args.dataArg === undefined && !args.noValidate) {
    const required = (schema as { required?: unknown }).required;
    for (const r of Array.isArray(required) ? required : []) {
      if (typeof r === 'string' && !Object.hasOwn(base, r)) return `missing required flag --${r}`;
    }
  }
  return base;
}

export async function runEvents(
  platform: Platform,
  conn: McpConnection,
  args: EventsArgs,
  options: RunEventsOptions
): Promise<number> {
  const info = await conn.info();
  if (!conn.events) {
    return fail(
      platform,
      options,
      args.json,
      EXIT_RPC_ERROR,
      `events need protocol 2026-07-28; this server speaks ${info.protocolVersion}`
    );
  }
  const extensions = info.capabilities.extensions as Record<string, unknown> | undefined;
  if (!extensions || typeof extensions !== 'object' || !extensions[EVENTS_EXTENSION]) {
    return fail(
      platform,
      options,
      args.json,
      EXIT_RPC_ERROR,
      `the server does not offer the events extension (${EVENTS_EXTENSION})`
    );
  }
  const events = await conn.events.list();
  if (args.mode === 'list') return listEvents(platform, events, args.json);
  const event = events.find((e) => e.name === args.event);
  if (!event) {
    const known = events.map((e) => e.name).join(', ') || 'none';
    return fail(
      platform,
      options,
      args.json,
      EXIT_USAGE,
      `unknown event '${args.event}' (events: ${known})`
    );
  }
  const mode = pickDelivery(event, args.delivery);
  if (mode !== 'push' && mode !== 'poll' && mode !== 'webhook')
    return fail(platform, options, args.json, EXIT_USAGE, mode);
  const eventArgs = eventArguments(event, args, options.base);
  if (typeof eventArgs === 'string')
    return fail(platform, options, args.json, EXIT_USAGE, eventArgs);
  if (mode === 'webhook') {
    return new WebhookClient({
      platform,
      api: conn.events,
      event,
      args,
      arguments: eventArgs,
      signal: options.signal,
      redact: options.redact,
    }).start();
  }
  const subscriber = new Subscriber({
    platform,
    api: conn.events,
    event,
    args,
    arguments: eventArgs,
    signal: options.signal,
    redact: options.redact,
  });
  return subscriber.start();
}
