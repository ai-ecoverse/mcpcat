import type { VerboseLogger } from '../cli/verbose.ts';
import type {
  EventDescriptor,
  EventSubscription,
  StreamEnd,
  StreamMessageHandler,
} from './connection.ts';
import { META_SUBSCRIPTION_ID } from './modern.ts';

export const EVENTS_METHODS = new Set([
  'events/poll',
  'events/stream',
  'events/subscribe',
  'events/unsubscribe',
]);

const MAX_LIST_PAGES = 100;

export class EventsTransportClosedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EventsTransportClosedError';
  }
}

export function subscriptionParams(subscription: EventSubscription): Record<string, unknown> {
  const params: Record<string, unknown> = {
    name: subscription.name,
    arguments: subscription.arguments,
    cursor: subscription.cursor,
    _events: true,
  };
  if (subscription.maxAgeMs !== undefined) params.maxAgeMs = subscription.maxAgeMs;
  return params;
}

export async function listAllEvents(
  request: (method: string, params: Record<string, unknown>) => Promise<unknown>
): Promise<EventDescriptor[]> {
  const out: EventDescriptor[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_LIST_PAGES; page++) {
    const params: Record<string, unknown> = cursor ? { cursor, _events: true } : { _events: true };
    const result = (await request('events/list', params)) as {
      events?: unknown;
      nextCursor?: unknown;
    } | null;
    if (Array.isArray(result?.events)) {
      for (const e of result.events) {
        if (e && typeof e === 'object' && typeof (e as EventDescriptor).name === 'string') {
          out.push(e as EventDescriptor);
        }
      }
    }
    const next = result?.nextCursor;
    if (typeof next !== 'string' || !next || next === cursor) break;
    cursor = next;
  }
  return out;
}

export function isStreamMessage(message: unknown, id: number): boolean {
  if (!message || typeof message !== 'object') return false;
  const { method, params } = message as { method?: unknown; params?: unknown };
  if (typeof method !== 'string' || !method.startsWith('notifications/events/')) return false;
  const meta = (params as { _meta?: Record<string, unknown> } | undefined)?._meta;
  const sid = meta?.[META_SUBSCRIPTION_ID];
  return sid === id || sid === String(id);
}

export function createSseParser(): (chunk: string) => string[] {
  let buffer = '';
  let carry = '';
  return (chunk: string) => {
    let text = carry + chunk;
    carry = '';
    if (text.endsWith('\r')) {
      carry = '\r';
      text = text.slice(0, -1);
    }
    buffer += text.replace(/\r\n?/g, '\n');
    const out: string[] = [];
    let end = buffer.indexOf('\n\n');
    while (end >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const data = block
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).replace(/^ /, ''));
      if (data.length > 0) out.push(data.join('\n'));
      end = buffer.indexOf('\n\n');
    }
    return out;
  };
}

export const STALE = Symbol('stale');

export function within<T>(promise: Promise<T>, ms: number): Promise<T | typeof STALE> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stale = new Promise<typeof STALE>((resolve) => {
    timer = setTimeout(() => resolve(STALE), ms);
  });
  return Promise.race([promise, stale]).finally(() => clearTimeout(timer));
}

export function idleClock(onMessage: StreamMessageHandler, idleMs: number) {
  let deadline = Date.now() + idleMs;
  return {
    left: () => Math.max(0, deadline - Date.now()),
    onMessage: async (method: string, params: Record<string, unknown>) => {
      const out = await onMessage(method, params);
      deadline = Date.now() + idleMs;
      return out;
    },
  };
}

export async function dispatchStreamData(
  data: string,
  id: number,
  onMessage: StreamMessageHandler,
  verbose: VerboseLogger | undefined,
  rpcError: (code: number, message: string, data?: unknown) => Error
): Promise<StreamEnd | undefined> {
  let msg: {
    id?: unknown;
    method?: string;
    error?: { code: number; message: string; data?: unknown };
    params?: Record<string, unknown>;
  };
  try {
    msg = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (!msg || typeof msg !== 'object') return undefined;
  if (verbose?.enabled) verbose.response(data);
  if (msg.id === id && msg.method === undefined) {
    if (msg.error) throw rpcError(msg.error.code, msg.error.message, msg.error.data);
    return 'closed';
  }
  if (!isStreamMessage(msg, id)) return undefined;
  return (await onMessage(msg.method!, msg.params ?? {})) === 'stop' ? 'stopped' : undefined;
}
