import type { EventDescriptor, EventOccurrence } from '../client/connection.ts';
import { META_SUBSCRIPTION_ID } from '../client/modern.ts';
import { splitShellStyle } from '../client/targets.ts';
import type { Platform, SpawnResult } from '../platform/types.ts';
import { sanitizeTerminal } from '../render/sanitize.ts';

export const INVALID_PARAMS = -32602;
export const NOT_FOUND = -32023;
export const FORBIDDEN = -32024;
export const RESOURCE_EXHAUSTED = -32025;
export const UNSUPPORTED = -32026;

const NAME = /^[A-Za-z0-9._-]+$/;
const PLACEHOLDER = /\{(\w+)\}/g;
const DEFAULT_MAX_EVENTS = 100;
const RESTART_START_MS = 500;
const RESTART_MAX_MS = 30_000;
const STEADY_MS = 30_000;

export class EventsRpcError extends Error {
  readonly code: number;
  readonly data?: Record<string, unknown>;
  constructor(code: number, message: string, data?: Record<string, unknown>) {
    super(message);
    this.name = 'EventsRpcError';
    this.code = code;
    this.data = data;
  }
}

export interface EventSpec {
  name: string;
  template: string;
  argv: string[];
  placeholders: string[];
}

export function parseEventSpec(spec: string): EventSpec | undefined {
  const colon = spec.indexOf(':');
  if (colon <= 0) return undefined;
  const name = spec.slice(0, colon).trim();
  const template = spec.slice(colon + 1).trim();
  const argv = splitShellStyle(template);
  if (!NAME.test(name) || argv.length === 0) return undefined;
  const placeholders: string[] = [];
  for (const m of template.matchAll(PLACEHOLDER)) {
    if (!placeholders.includes(m[1])) placeholders.push(m[1]);
  }
  return { name, template, argv, placeholders };
}

export function lineToEvent(
  line: string,
  name: string,
  fallbackId: string,
  now: Date
): EventOccurrence {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    parsed = undefined;
  }
  const base = { eventId: fallbackId, name, timestamp: now.toISOString() };
  if (!isRecord(parsed)) return { ...base, data: { line } };
  if (!isRecord(parsed.data)) return { ...base, data: parsed };
  return {
    ...base,
    ...(typeof parsed.eventId === 'string' && parsed.eventId ? { eventId: parsed.eventId } : {}),
    ...(typeof parsed.timestamp === 'string' ? { timestamp: parsed.timestamp } : {}),
    data: parsed.data,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function randomId(bytes = 6): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, '0')).join('');
}

export function canonicalArgs(args: Record<string, string>): string {
  return JSON.stringify(Object.entries(args).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export interface Entry {
  seq: number;
  at: number;
  occurrence: EventOccurrence;
}

export interface SourceContext {
  platform: Platform;
  env: Record<string, string>;
  cwd: string;
  bufferSize: number;
  stop(proc: SpawnResult): Promise<void>;
  log(text: string): Promise<void>;
  now(): number;
}

export class Source {
  readonly epoch = randomId();
  readonly spec: EventSpec;
  readonly key: string;
  refs = 0;
  private readonly ctx: SourceContext;
  private readonly argv: string[];
  private seq = 0;
  private buffer: Entry[] = [];
  private listeners = new Set<(entry: Entry) => void>();
  private proc: SpawnResult | undefined;
  private running = false;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private delay = RESTART_START_MS;

  constructor(ctx: SourceContext, spec: EventSpec, args: Record<string, string>, key: string) {
    this.ctx = ctx;
    this.spec = spec;
    this.key = key;
    this.argv = spec.argv.map((token) => token.replace(PLACEHOLDER, (_w, ph: string) => args[ph]));
  }

  cursor(seq = this.seq): string {
    return `${this.epoch}.${seq}`;
  }

  get head(): number {
    return this.seq;
  }

  get oldest(): number {
    return this.buffer[0]?.seq ?? this.seq + 1;
  }

  position(cursor: string | null, maxAgeMs?: number): { seq: number; truncated: boolean } {
    if (cursor === null) return { seq: this.seq, truncated: false };
    const dot = cursor.lastIndexOf('.');
    const n = Number(cursor.slice(dot + 1));
    const valid =
      cursor.slice(0, dot) === this.epoch &&
      Number.isInteger(n) &&
      n <= this.seq &&
      n >= this.oldest - 1;
    let pos = valid ? { seq: n, truncated: false } : { seq: this.oldest - 1, truncated: true };
    if (maxAgeMs === undefined) return pos;
    const floor = this.ctx.now() - maxAgeMs;
    for (const entry of this.after(pos.seq)) {
      if (entry.at >= floor) break;
      pos = { seq: entry.seq, truncated: true };
    }
    return pos;
  }

  after(seq: number, limit = Number.POSITIVE_INFINITY): Entry[] {
    const out: Entry[] = [];
    for (const entry of this.buffer) {
      if (out.length >= limit) break;
      if (entry.seq > seq) out.push(entry);
    }
    return out;
  }

  on(listener: (entry: Entry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(line: string): void {
    this.seq++;
    const occurrence = lineToEvent(line, this.spec.name, this.cursor(), new Date(this.ctx.now()));
    const entry = { seq: this.seq, at: this.ctx.now(), occurrence };
    this.buffer.push(entry);
    if (this.buffer.length > this.ctx.bufferSize) this.buffer.shift();
    for (const listener of [...this.listeners]) listener(entry);
  }

  start(): void {
    this.running = true;
    void this.spawn();
  }

  async stop(): Promise<void> {
    this.running = false;
    clearTimeout(this.retry);
    const proc = this.proc;
    this.proc = undefined;
    if (proc) await this.ctx.stop(proc);
  }

  private async spawn(): Promise<void> {
    const started = this.ctx.now();
    let status: string;
    try {
      const proc = await this.ctx.platform.spawn({
        argv: this.argv,
        env: this.ctx.env,
        cwd: this.ctx.cwd,
        stdin: 'ignore',
        dieWithParent: true,
      });
      this.proc = proc;
      if (!this.running) await this.ctx.stop(proc);
      const [, , exit] = await Promise.all([
        this.lines(proc.stdout),
        this.forward(proc.stderr),
        proc.wait(),
      ]);
      status = exit.signal ? `was killed by ${exit.signal}` : `exited ${exit.status}`;
    } catch (err) {
      status = `could not start (${(err as Error).message})`;
    }
    if (!this.running) return;
    this.proc = undefined;
    if (this.ctx.now() - started >= STEADY_MS) this.delay = RESTART_START_MS;
    const wait = this.delay;
    this.delay = Math.min(this.delay * 2, RESTART_MAX_MS);
    await this.ctx.log(
      `event source ${this.spec.name} ${status}; restarting in ${Math.round(wait / 100) / 10}s`
    );
    this.retry = setTimeout(() => {
      if (this.running) void this.spawn();
    }, wait);
  }

  private async lines(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (line.trim()) this.emit(line);
        nl = buffer.indexOf('\n');
      }
    }
    if (buffer.trim()) this.emit(buffer);
  }

  private async forward(stream: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      await this.ctx.platform.write(2, value);
    }
  }
}

export interface Subscription {
  name: string;
  arguments: Record<string, string>;
  cursor: string | null;
  maxAgeMs?: number;
}

function field(params: Record<string, unknown>, key: string): unknown {
  return Object.getOwnPropertyDescriptor(params, key)?.value;
}

export function readSubscription(
  params: unknown,
  specs: Map<string, EventSpec>
): { spec: EventSpec; sub: Subscription } {
  const p = isRecord(params) ? params : {};
  const name = field(p, 'name');
  if (typeof name !== 'string' || !name)
    throw new EventsRpcError(INVALID_PARAMS, 'name is required');
  const spec = specs.get(name);
  if (!spec) throw new EventsRpcError(NOT_FOUND, `unknown event: ${name}`, { kind: 'event' });
  const raw = field(p, 'arguments') ?? {};
  if (!isRecord(raw)) throw new EventsRpcError(INVALID_PARAMS, 'arguments must be an object');
  const args: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!spec.placeholders.includes(key)) {
      throw new EventsRpcError(INVALID_PARAMS, `unknown argument: ${key}`);
    }
    if (typeof value !== 'string') {
      throw new EventsRpcError(INVALID_PARAMS, `argument ${key} must be a string`);
    }
    args[key] = value;
  }
  for (const ph of spec.placeholders) {
    if (!Object.hasOwn(args, ph))
      throw new EventsRpcError(INVALID_PARAMS, `missing argument: ${ph}`);
  }
  const cursor = field(p, 'cursor') ?? null;
  if (cursor !== null && typeof cursor !== 'string') {
    throw new EventsRpcError(INVALID_PARAMS, 'cursor must be a string or null');
  }
  const maxAge = field(p, 'maxAgeMs');
  if (maxAge !== undefined && (typeof maxAge !== 'number' || !(maxAge >= 0))) {
    throw new EventsRpcError(INVALID_PARAMS, 'maxAgeMs must be a non-negative number');
  }
  const sub: Subscription = { name, arguments: args, cursor };
  if (typeof maxAge === 'number' && cursor !== null) sub.maxAgeMs = maxAge;
  return { spec, sub };
}

export function descriptor(spec: EventSpec, delivery: string[]): EventDescriptor {
  const properties: Record<string, unknown> = {};
  for (const ph of spec.placeholders) properties[ph] = { type: 'string', description: ph };
  return {
    name: spec.name,
    description: spec.template,
    delivery,
    inputSchema: {
      type: 'object',
      properties,
      required: spec.placeholders,
      additionalProperties: false,
    },
    payloadSchema: { type: 'object' },
  };
}

export function notification(id: string | number, method: string, params: Record<string, unknown>) {
  return JSON.stringify({
    jsonrpc: '2.0',
    method: `notifications/events/${method}`,
    params: { ...params, _meta: { ...(params._meta as object), [META_SUBSCRIPTION_ID]: id } },
  });
}

export function streamResult(id: string | number): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    result: { resultType: 'complete', _meta: { [META_SUBSCRIPTION_ID]: id } },
  });
}

export function readMaxEvents(params: unknown): number {
  const value = isRecord(params) ? field(params, 'maxEvents') : undefined;
  if (value === undefined) return DEFAULT_MAX_EVENTS;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
    throw new EventsRpcError(INVALID_PARAMS, 'maxEvents must be a positive integer');
  }
  return Math.min(value, DEFAULT_MAX_EVENTS);
}

export function logLine(platform: Platform) {
  return (text: string) => platform.write(2, sanitizeTerminal(`mcpcat serve: ${text}\n`));
}
