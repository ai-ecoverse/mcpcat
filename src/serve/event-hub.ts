import type { EventDescriptor } from '../client/connection.ts';
import { EVENTS_EXTENSION } from '../client/modern.ts';
import type { Platform, SpawnResult } from '../platform/types.ts';
import {
  canonicalArgs,
  descriptor,
  type EventSpec,
  EventsRpcError,
  grantHeartbeat,
  NOT_FOUND,
  notification,
  readMaxEvents,
  readSubscription,
  Source,
  type SourceContext,
  type Subscription,
  streamResult,
  UNSUPPORTED,
} from './events.ts';
import { createNotifier, type Notifier } from './live.ts';
import { type WebhookOptions, WebhookRegistry } from './webhook.ts';

export interface HubOptions {
  platform: Platform;
  specs: EventSpec[];
  env: Record<string, string>;
  cwd: string;
  bufferSize: number;
  heartbeatMs: number;
  pollMs: number;
  webhook?: WebhookOptions;
  reloadable?: boolean;
  stop(proc: SpawnResult): Promise<void>;
  log(text: string): Promise<void>;
  now?: () => number;
}

export type Send = (message: string) => Promise<void>;

export interface OpenStream {
  run(send: Send, signal: AbortSignal): Promise<void>;
}

export function eventsExtensions(hub: EventHub | undefined): Record<string, unknown> | undefined {
  return hub ? { [EVENTS_EXTENSION]: { listChanged: hub.listChanged === true } } : undefined;
}

export interface Reload {
  added: string[];
  removed: string[];
  changed: string[];
}

type RpcErrorBody = { code: number; message: string; data: Record<string, unknown> };

function samePlaceholders(a: EventSpec, b: EventSpec): boolean {
  return (
    a.placeholders.length === b.placeholders.length &&
    a.placeholders.every((p) => b.placeholders.includes(p))
  );
}

export class EventHub {
  private readonly o: HubOptions;
  private readonly specs = new Map<string, EventSpec>();
  private readonly sources = new Map<string, Source>();
  private readonly leases = new Map<
    string,
    { source: Source; timer: ReturnType<typeof setTimeout> }
  >();
  private readonly closers = new Set<() => void>();
  private readonly enders = new Set<{ name: string; end(error: RpcErrorBody): void }>();
  private readonly ctx: SourceContext;
  private readonly webhooks: WebhookRegistry | undefined;
  readonly changes: Notifier = createNotifier();

  constructor(options: HubOptions) {
    this.o = options;
    for (const spec of options.specs) this.specs.set(spec.name, spec);
    const now = options.now ?? Date.now;
    this.ctx = {
      platform: options.platform,
      env: options.env,
      cwd: options.cwd,
      bufferSize: options.bufferSize,
      stop: options.stop,
      log: options.log,
      now,
    };
    this.webhooks = options.webhook
      ? new WebhookRegistry(
          {
            specs: this.specs,
            acquire: (spec, args) => this.acquire(spec, args),
            release: (source) => this.release(source),
            fetch: options.platform.fetch,
            log: options.log,
            now,
          },
          options.webhook
        )
      : undefined;
  }

  get listChanged(): boolean {
    return this.o.reloadable === true;
  }

  get leaseMs(): number {
    return Math.max(60_000, this.o.pollMs * 3);
  }

  descriptors(): EventDescriptor[] {
    const delivery = ['push', 'poll', ...(this.webhooks ? ['webhook'] : [])];
    return [...this.specs.values()].map((spec) => descriptor(spec, delivery));
  }

  private keyOf(spec: EventSpec, args: Record<string, string>): string {
    return `${spec.name}\0${canonicalArgs(args)}`;
  }

  acquire(spec: EventSpec, args: Record<string, string>): Source {
    const key = this.keyOf(spec, args);
    let source = this.sources.get(key);
    if (!source) {
      source = new Source(this.ctx, spec, args, key);
      this.sources.set(key, source);
    }
    source.refs++;
    if (source.refs === 1) source.start();
    return source;
  }

  release(source: Source): void {
    source.refs--;
    if (source.refs > 0) return;
    if (this.sources.get(source.key) === source) this.sources.delete(source.key);
    void source.stop();
  }

  reload(specs: EventSpec[]): Reload {
    const next = new Map(specs.map((spec) => [spec.name, spec]));
    const out: Reload = { added: [], removed: [], changed: [] };
    const broken = new Map<string, RpcErrorBody>();
    for (const [name, old] of this.specs) {
      const spec = next.get(name);
      if (!spec) {
        out.removed.push(name);
        broken.set(name, {
          code: NOT_FOUND,
          message: `event ${name} was removed`,
          data: { kind: 'event' },
        });
      } else if (spec.template !== old.template) {
        out.changed.push(name);
        if (!samePlaceholders(old, spec)) {
          broken.set(name, {
            code: UNSUPPORTED,
            message: `event ${name} changed its inputSchema`,
            data: { feature: 'inputSchema', reason: 'schema_changed' },
          });
        }
      }
    }
    for (const name of next.keys()) if (!this.specs.has(name)) out.added.push(name);
    this.specs.clear();
    for (const [name, spec] of next) this.specs.set(name, spec);
    this.end(broken);
    for (const source of this.sources.values()) {
      const spec = next.get(source.spec.name);
      if (spec && spec !== source.spec) source.retarget(spec);
    }
    if (out.added.length + out.removed.length + out.changed.length > 0) this.changes.notify();
    return out;
  }

  private end(broken: Map<string, RpcErrorBody>): void {
    if (broken.size === 0) return;
    for (const [key, source] of [...this.sources]) {
      if (broken.has(source.spec.name)) this.sources.delete(key);
    }
    for (const ender of [...this.enders]) {
      const error = broken.get(ender.name);
      if (error) ender.end(error);
    }
    for (const [key, { source, timer }] of [...this.leases]) {
      if (!broken.has(source.spec.name)) continue;
      clearTimeout(timer);
      this.leases.delete(key);
      this.release(source);
    }
    this.webhooks?.end((name) => broken.get(name));
  }

  private lease(spec: EventSpec, args: Record<string, string>): Source {
    const key = this.keyOf(spec, args);
    const held = this.leases.get(key);
    const source = held?.source ?? this.acquire(spec, args);
    clearTimeout(held?.timer);
    const timer = setTimeout(() => {
      this.leases.delete(key);
      this.release(source);
    }, this.leaseMs);
    this.leases.set(key, { source, timer });
    return source;
  }

  async request(
    method: string,
    params: unknown,
    principal: string | undefined
  ): Promise<Record<string, unknown> | undefined> {
    if (method === 'events/list') return { events: this.descriptors() };
    if (method === 'events/poll') return this.poll(params);
    if (method !== 'events/subscribe' && method !== 'events/unsubscribe') return undefined;
    if (!this.webhooks) {
      throw new EventsRpcError(UNSUPPORTED, 'webhook delivery is not enabled (--webhook-allow)', {
        feature: 'deliveryMode',
        value: 'webhook',
      });
    }
    return method === 'events/subscribe'
      ? this.webhooks.subscribe(params, principal)
      : this.webhooks.unsubscribe(params, principal);
  }

  private poll(params: unknown): Record<string, unknown> {
    const { spec, sub } = readSubscription(params, this.specs);
    const max = readMaxEvents(params);
    const source = this.lease(spec, sub.arguments);
    const nextPollMs = this.o.pollMs;
    if (sub.cursor === null) {
      return { events: [], cursor: source.cursor(), truncated: false, hasMore: false, nextPollMs };
    }
    const pos = source.position(sub.cursor, sub.maxAgeMs);
    const entries = source.after(pos.seq, max);
    const last = entries.at(-1)?.seq ?? pos.seq;
    return {
      events: entries.map((e) => e.occurrence),
      cursor: source.cursor(last),
      truncated: pos.truncated,
      hasMore: last < source.head,
      nextPollMs,
    };
  }

  openStream(id: string | number, params: unknown): OpenStream {
    const { spec, sub } = readSubscription(params, this.specs);
    const heartbeatMs = grantHeartbeat(params, this.o.heartbeatMs);
    return { run: (send, signal) => this.runStream(id, spec, sub, heartbeatMs, send, signal) };
  }

  private async runStream(
    id: string | number,
    spec: EventSpec,
    sub: Subscription,
    heartbeatMs: number,
    send: Send,
    signal: AbortSignal
  ): Promise<void> {
    const source = this.acquire(spec, sub.arguments);
    const pos = source.position(sub.cursor, sub.maxAgeMs);
    const state = {
      last: pos.seq,
      beat: false,
      closing: false,
      ended: false,
      writing: false,
      error: undefined as RpcErrorBody | undefined,
    };
    let finish: () => void = () => {};
    const ended = new Promise<void>((resolve) => {
      finish = () => {
        state.ended = true;
        resolve();
      };
    });
    const next = (): string | undefined => {
      if (state.closing || state.error) return undefined;
      if (state.last < source.oldest - 1) {
        state.last = source.oldest - 1;
        return notification(id, 'active', {
          cursor: source.cursor(state.last),
          truncated: true,
          heartbeatMs,
        });
      }
      const [entry] = source.after(state.last, 1);
      if (entry) {
        state.last = entry.seq;
        return notification(id, 'event', { ...entry.occurrence, cursor: source.cursor(entry.seq) });
      }
      if (state.beat) {
        state.beat = false;
        return notification(id, 'heartbeat', { cursor: source.cursor(state.last) });
      }
      return undefined;
    };
    const pump = async () => {
      if (state.writing) return;
      state.writing = true;
      try {
        for (let message = next(); message && !state.ended; message = next()) await send(message);
        if (state.error && !state.ended) {
          await send(notification(id, 'terminated', { error: state.error }));
          finish();
        }
        if (state.closing && !state.ended) {
          await send(streamResult(id));
          finish();
        }
      } catch {
        finish();
      }
      state.writing = false;
    };
    const first = notification(id, 'active', {
      cursor: source.cursor(pos.seq),
      truncated: pos.truncated,
      heartbeatMs,
    });
    const off = source.on(() => void pump());
    const beat = setInterval(() => {
      state.beat = true;
      void pump();
    }, heartbeatMs);
    const closer = () => {
      state.closing = true;
      void pump();
    };
    this.closers.add(closer);
    const ender = {
      name: spec.name,
      end: (error: RpcErrorBody) => {
        state.error = error;
        void pump();
      },
    };
    this.enders.add(ender);
    signal.addEventListener('abort', finish, { once: true });
    if (signal.aborted) finish();
    state.writing = true;
    void send(first)
      .then(() => {
        state.writing = false;
        return pump();
      })
      .catch(finish);
    await ended;
    off();
    clearInterval(beat);
    this.closers.delete(closer);
    this.enders.delete(ender);
    signal.removeEventListener('abort', finish);
    this.release(source);
  }

  async close(): Promise<void> {
    for (const closer of [...this.closers]) closer();
    for (const { source, timer } of this.leases.values()) {
      clearTimeout(timer);
      this.release(source);
    }
    this.leases.clear();
    this.webhooks?.close();
    this.changes.close();
    await Promise.all([...this.sources.values()].map((source) => source.stop()));
  }
}
