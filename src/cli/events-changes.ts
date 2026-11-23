import type { EventDescriptor, EventsApi, StreamEnd } from '../client/connection.ts';
import { EventsTransportClosedError } from '../client/events.ts';
import { McpAuthError, StatelessRpcError } from '../client/stateless-connection.ts';
import { EXIT_RPC_ERROR, EXIT_USAGE, McpcatError } from './exit-codes.ts';

const NOT_FOUND = -32023;
const UNSUPPORTED = -32026;
const BACKOFF_START_MS = 500;
const BACKOFF_MAX_MS = 30_000;

export type Verdict =
  | { kind: 'same'; event: EventDescriptor }
  | { kind: 'gone' }
  | { kind: 'invalid'; event: EventDescriptor; reason: string }
  | { kind: 'changed'; event: EventDescriptor; what: string[] };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isRecord(value)) return value;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) out[key] = canonical(value[key]);
  return out;
}

export function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function typeMatches(type: unknown, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return Number.isInteger(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'object':
      return isRecord(value);
    case 'array':
      return Array.isArray(value);
    case 'null':
      return value === null;
    default:
      return true;
  }
}

function valueError(schema: unknown, value: unknown): string | undefined {
  if (!isRecord(schema)) return undefined;
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => sameJson(e, value))) {
    return 'is not one of its enum values';
  }
  if (Object.hasOwn(schema, 'const') && !sameJson(schema.const, value)) {
    return 'is not its const value';
  }
  const types =
    typeof schema.type === 'string' ? [schema.type] : Array.isArray(schema.type) ? schema.type : [];
  if (types.length > 0 && !types.some((t) => typeMatches(t, value))) {
    return `is not ${types.join(' or ')}`;
  }
  return undefined;
}

export function argumentsError(
  schema: unknown,
  value: Record<string, unknown>
): string | undefined {
  const s = isRecord(schema) ? schema : {};
  const properties = isRecord(s.properties) ? s.properties : {};
  for (const name of Array.isArray(s.required) ? s.required : []) {
    if (typeof name === 'string' && !Object.hasOwn(value, name)) {
      return `missing required argument ${name}`;
    }
  }
  for (const [key, v] of Object.entries(value)) {
    if (!Object.hasOwn(properties, key)) {
      if (s.additionalProperties === false) return `unknown argument ${key}`;
      continue;
    }
    const why = valueError(properties[key], v);
    if (why) return `argument ${key} ${why}`;
  }
  return undefined;
}

function modes(event: EventDescriptor): string[] {
  return Array.isArray(event.delivery) ? [...event.delivery].sort() : [];
}

export function compareEvent(
  current: EventDescriptor,
  events: EventDescriptor[],
  args: Record<string, unknown>,
  validate: boolean
): Verdict {
  const event = events.find((e) => e.name === current.name);
  if (!event) return { kind: 'gone' };
  if (validate && !sameJson(current.inputSchema, event.inputSchema)) {
    const reason = argumentsError(event.inputSchema, args);
    if (reason && !argumentsError(current.inputSchema, args)) {
      return { kind: 'invalid', event, reason };
    }
  }
  const what: string[] = [];
  if (!sameJson(modes(current), modes(event))) what.push('delivery modes');
  if (!sameJson(current.payloadSchema, event.payloadSchema)) what.push('payload schema');
  return what.length > 0 ? { kind: 'changed', event, what } : { kind: 'same', event };
}

export function isSchemaChange(error: unknown): boolean {
  if (!isRecord(error)) return false;
  const data = isRecord(error.data) ? error.data : {};
  if (error.code === NOT_FOUND) return data.kind === 'event';
  if (error.code === UNSUPPORTED) return data.reason === 'schema_changed';
  return false;
}

export function isSchemaRpcError(err: unknown): boolean {
  return err instanceof StatelessRpcError && isSchemaChange({ code: err.code, data: err.data });
}

function retryable(err: unknown): boolean {
  return !(
    err instanceof StatelessRpcError ||
    err instanceof EventsTransportClosedError ||
    err instanceof McpAuthError ||
    err instanceof McpcatError
  );
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, signal.aborted ? 0 : ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

export interface WatchOptions {
  api: EventsApi;
  event: EventDescriptor;
  arguments: Record<string, unknown>;
  validate: boolean;
  signal: AbortSignal;
  notice(text: string): Promise<void>;
  usable(event: EventDescriptor): string | undefined;
}

export class EventWatch {
  event: EventDescriptor;
  failure: McpcatError | undefined;
  private readonly o: WatchOptions;
  private current = new AbortController();
  private unlink: () => void = () => {};
  private chain: Promise<unknown> = Promise.resolve();
  private readonly stopper = new AbortController();
  private listening: Promise<void> | undefined;
  private retryMs = BACKOFF_START_MS;

  constructor(options: WatchOptions) {
    this.o = options;
    this.event = options.event;
  }

  leg(): AbortSignal {
    this.unlink();
    const leg = new AbortController();
    const main = this.o.signal;
    const relay = () => leg.abort();
    if (main.aborted) leg.abort();
    else main.addEventListener('abort', relay, { once: true });
    this.unlink = () => main.removeEventListener('abort', relay);
    this.current = leg;
    return leg.signal;
  }

  settled(): Promise<void> {
    return this.chain.then(() => {});
  }

  async resync(): Promise<boolean> {
    const before = this.event;
    let verdict = await this.queue();
    while (typeof verdict === 'number') {
      await sleep(verdict, this.o.signal);
      verdict = this.o.signal.aborted ? undefined : await this.queue();
    }
    if (this.failure) throw this.failure;
    if (!verdict) return this.o.signal.aborted;
    if (verdict.kind === 'gone') return false;
    if (verdict.kind === 'changed') return true;
    if (sameJson(before, verdict.event)) return false;
    await this.o.notice(`event '${before.name}' changed; resubscribing from the last cursor`);
    return true;
  }

  async check(): Promise<Verdict | undefined> {
    const verdict = await this.queue();
    if (typeof verdict !== 'number') return verdict;
    void sleep(verdict, this.stopper.signal).then(() => {
      if (!this.stopper.signal.aborted) void this.check();
    });
    return undefined;
  }

  private queue(): Promise<Verdict | number | undefined> {
    const next = this.chain.then(() => this.refresh());
    this.chain = next.catch(() => {});
    return next;
  }

  private async refresh(): Promise<Verdict | number | undefined> {
    if (this.failure || this.o.signal.aborted) return undefined;
    let events: EventDescriptor[];
    try {
      events = await this.o.api.list();
    } catch (err) {
      if (this.o.signal.aborted || this.stopper.signal.aborted) return undefined;
      const message = `could not refresh events/list (${(err as Error).message})`;
      if (!retryable(err)) {
        await this.o.notice(message);
        return undefined;
      }
      const delay = this.retryMs;
      this.retryMs = Math.min(delay * 2, BACKOFF_MAX_MS);
      await this.o.notice(`${message}; retrying in ${Math.round(delay / 100) / 10}s`);
      return delay;
    }
    this.retryMs = BACKOFF_START_MS;
    const verdict = compareEvent(this.event, events, this.o.arguments, this.o.validate);
    const name = this.event.name;
    if (verdict.kind === 'gone') {
      this.fail(
        EXIT_RPC_ERROR,
        `event '${name}' is no longer offered by the server; the subscription has ended`
      );
      return verdict;
    }
    this.event = verdict.event;
    if (verdict.kind === 'invalid') {
      this.fail(
        EXIT_USAGE,
        `event '${name}' changed its inputSchema and the subscription's arguments no longer validate (${verdict.reason}); the subscription has ended`
      );
      return verdict;
    }
    if (verdict.kind === 'same') return verdict;
    const unusable = this.o.usable(verdict.event);
    if (unusable) {
      this.fail(EXIT_USAGE, `${unusable}; the subscription has ended`);
      return verdict;
    }
    await this.o.notice(
      `event '${name}' changed its ${verdict.what.join(' and ')}; resubscribing from the last cursor`
    );
    this.current.abort();
    return verdict;
  }

  private fail(code: typeof EXIT_RPC_ERROR | typeof EXIT_USAGE, message: string): void {
    this.failure = new McpcatError(code, message);
    this.current.abort();
  }

  listen(): void {
    this.listening ??= this.listenLoop();
  }

  async stop(): Promise<void> {
    this.unlink();
    this.stopper.abort();
    await this.listening;
  }

  private async listenLoop(): Promise<void> {
    const signal = this.stopper.signal;
    const lost = 'event type changes will go unnoticed';
    let acked = false;
    let delay = BACKOFF_START_MS;
    while (!signal.aborted) {
      let refused = false;
      let end: StreamEnd;
      try {
        end = await this.o.api.listen(
          async (method, params) => {
            if (method === 'notifications/subscriptions/acknowledged') {
              const filter = isRecord(params.notifications) ? params.notifications : {};
              if (filter.eventsListChanged !== true) {
                refused = true;
                return 'stop';
              }
              acked = true;
              delay = BACKOFF_START_MS;
              void this.check();
            } else if (method === 'notifications/events/list_changed' && acked) {
              void this.check();
            }
            return undefined;
          },
          { idleMs: Number.POSITIVE_INFINITY, signal }
        );
      } catch (err) {
        if (signal.aborted) return;
        if (!acked || !retryable(err)) {
          await this.o.notice(`subscriptions/listen failed (${(err as Error).message}); ${lost}`);
          return;
        }
        end = 'dropped';
      }
      if (signal.aborted || end === 'aborted') return;
      if (refused) {
        await this.o.notice(
          `the server advertises listChanged but did not acknowledge eventsListChanged; ${lost}`
        );
        return;
      }
      if (!acked) {
        await this.o.notice(
          `the server ended subscriptions/listen before acknowledging it; ${lost}`
        );
        return;
      }
      const why =
        end === 'closed'
          ? 'the server closed the subscriptions/listen stream'
          : 'the subscriptions/listen stream dropped';
      await this.o.notice(`${why}; reconnecting in ${Math.round(delay / 100) / 10}s`);
      await sleep(delay, signal);
      delay = Math.min(delay * 2, BACKOFF_MAX_MS);
    }
  }
}
