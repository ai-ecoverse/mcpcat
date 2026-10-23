import type { HttpResponse } from './http.ts';

type SubscriptionId = string | number;

const SUBSCRIPTION_ID = 'io.modelcontextprotocol/subscriptionId';

export interface LiveListener {
  change(): void;
  close(): void;
}

export interface Notifier {
  subscribe(listener: LiveListener): () => void;
  notify(): void;
  close(): void;
}

export function createNotifier(): Notifier {
  const listeners = new Set<LiveListener>();
  let closed = false;
  return {
    subscribe(listener) {
      if (closed) {
        listener.close();
        return () => {};
      }
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    notify() {
      for (const listener of listeners) listener.change();
    },
    close() {
      closed = true;
      const all = [...listeners];
      listeners.clear();
      for (const listener of all) listener.close();
    },
  };
}

export interface Listen {
  id: SubscriptionId;
  tools: boolean;
}

function parseMessage(raw: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function subscriptionId(value: unknown): SubscriptionId | undefined {
  return typeof value === 'string' || typeof value === 'number' ? value : undefined;
}

export function parseListen(raw: string): Listen | undefined {
  const message = parseMessage(raw);
  if (message?.method !== 'subscriptions/listen') return undefined;
  const id = subscriptionId(message.id);
  if (id === undefined) return undefined;
  const notifications = record(record(message.params).notifications);
  return { id, tools: notifications.toolsListChanged === true };
}

export function parseCancelled(raw: string): SubscriptionId | undefined {
  const message = parseMessage(raw);
  if (message?.method !== 'notifications/cancelled') return undefined;
  return subscriptionId(record(message.params).requestId);
}

export function isInitialize(raw: string): boolean {
  return parseMessage(raw)?.method === 'initialize';
}

export function listChangedMessage(id?: SubscriptionId): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    method: 'notifications/tools/list_changed',
    ...(id === undefined ? {} : { params: { _meta: { [SUBSCRIPTION_ID]: id } } }),
  });
}

export function acknowledgedMessage(listen: Listen): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    method: 'notifications/subscriptions/acknowledged',
    params: {
      _meta: { [SUBSCRIPTION_ID]: listen.id },
      notifications: listen.tools ? { toolsListChanged: true } : {},
    },
  });
}

export function completedMessage(id: SubscriptionId): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    result: { resultType: 'complete', _meta: { [SUBSCRIPTION_ID]: id } },
  });
}

export function sseEvent(body: string): string {
  return `event: message\ndata: ${body}\n\n`;
}

export function sseResponse(
  notifier: Notifier,
  first: string[],
  change: string | undefined,
  last: string | undefined
): HttpResponse {
  return {
    status: 200,
    reason: 'OK',
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
    body: '',
    async stream(send, signal) {
      let done!: () => void;
      const ended = new Promise<void>((resolve) => {
        done = resolve;
      });
      let chain = Promise.resolve();
      const push = (body: string) => {
        chain = chain.then(() => send(sseEvent(body))).catch(done);
      };
      for (const body of first) push(body);
      const off = notifier.subscribe({
        change: () => {
          if (change) push(change);
        },
        close: () => {
          if (last) push(last);
          void chain.then(done);
        },
      });
      signal.addEventListener('abort', done, { once: true });
      if (signal.aborted) done();
      await ended;
      off();
      signal.removeEventListener('abort', done);
    },
  };
}
