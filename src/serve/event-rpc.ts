import type { EventHub, OpenStream } from './event-hub.ts';
import { EventsRpcError } from './events.ts';

export const NAMED_EVENT_METHODS = new Set([
  'events/poll',
  'events/stream',
  'events/subscribe',
  'events/unsubscribe',
]);

const HEADER_MISMATCH = -32020;

type RpcId = string | number;

export type EventsOutcome =
  | { kind: 'reply'; body: string; status?: number }
  | { kind: 'stream'; id: RpcId; open: OpenStream }
  | { kind: 'cancel'; id: RpcId };

interface Message {
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

function parse(raw: string): Message | undefined {
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Message)
      : undefined;
  } catch {
    return undefined;
  }
}

function rpcId(value: unknown): RpcId | undefined {
  return typeof value === 'string' || typeof value === 'number' ? value : undefined;
}

function errorBody(id: RpcId, code: number, message: string, data?: unknown): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  });
}

export function decodeHeaderValue(value: string | undefined): string | undefined {
  const m = value === undefined ? null : /^=\?base64\?(.*)\?=$/.exec(value);
  if (!m) return value;
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0)));
  } catch {
    return undefined;
  }
}

export async function handleEventsMessage(
  hub: EventHub,
  raw: string,
  principal: string | undefined,
  headers?: Record<string, string>
): Promise<EventsOutcome | undefined> {
  const msg = parse(raw);
  if (!msg || typeof msg.method !== 'string') return undefined;
  if (msg.method === 'notifications/cancelled') {
    const params = msg.params as { requestId?: unknown } | undefined;
    const id = rpcId(params?.requestId);
    return id === undefined ? undefined : { kind: 'cancel', id };
  }
  const id = rpcId(msg.id);
  if (!msg.method.startsWith('events/') || id === undefined) return undefined;
  const name = (msg.params as { name?: unknown } | undefined)?.name;
  if (
    headers &&
    NAMED_EVENT_METHODS.has(msg.method) &&
    decodeHeaderValue(headers['mcp-name']) !== name
  ) {
    return {
      kind: 'reply',
      status: 400,
      body: errorBody(id, HEADER_MISMATCH, 'Mcp-Name does not match params.name'),
    };
  }
  try {
    if (msg.method === 'events/stream')
      return { kind: 'stream', id, open: hub.openStream(id, msg.params) };
    const result = await hub.request(msg.method, msg.params, principal);
    if (!result)
      return { kind: 'reply', body: errorBody(id, -32601, `Method not found: ${msg.method}`) };
    return {
      kind: 'reply',
      body: JSON.stringify({ jsonrpc: '2.0', id, result: { resultType: 'complete', ...result } }),
    };
  } catch (err) {
    if (!(err instanceof EventsRpcError)) throw err;
    return { kind: 'reply', body: errorBody(id, err.code, err.message, err.data) };
  }
}
