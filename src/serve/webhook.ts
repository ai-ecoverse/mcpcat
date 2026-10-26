import {
  canonicalArgs,
  type EventSpec,
  EventsRpcError,
  FORBIDDEN,
  INVALID_PARAMS,
  NOT_FOUND,
  RESOURCE_EXHAUSTED,
  randomId,
  readSubscription,
  type Source,
} from './events.ts';

export const CALLBACK_ENDPOINT_ERROR = -32027;
const MAX_SUBSCRIPTIONS = 100;
const MIN_TTL_MS = 1000;
const ROTATION_GRACE_MS = 300_000;
const DELIVERY_TIMEOUT_MS = 5000;
export const RETRY_DELAYS_MS = [0, 1000, 5000, 30_000, 120_000];
const SECRET = /^whsec_([A-Za-z0-9+/]+={0,2})$/;

export interface WebhookOptions {
  allow: string[];
  ttlMs: number;
  retryDelaysMs?: number[];
  deliveryTimeoutMs?: number;
}

export interface WebhookHost {
  specs: Map<string, EventSpec>;
  acquire(spec: EventSpec, args: Record<string, string>): Source;
  release(source: Source): void;
  fetch: typeof globalThis.fetch;
  log(text: string): Promise<void>;
  now(): number;
}

interface Secret {
  key: CryptoKey;
  raw: string;
  until?: number;
}

interface DeliveryStatus {
  active: boolean;
  lastDeliveryAt?: string;
  lastError: string | null;
  failedSince?: string;
}

interface Hook {
  id: string;
  key: string;
  url: string;
  source: Source;
  secrets: Secret[];
  expires?: ReturnType<typeof setTimeout>;
  acked: number;
  pumping: boolean;
  abort: AbortController;
  off?: () => void;
  status: DeliveryStatus;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function base64(bytes: ArrayBuffer): string {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s);
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function secretKey(raw: string): Promise<CryptoKey> {
  const m = SECRET.exec(raw);
  let bytes: Uint8Array<ArrayBuffer> | undefined;
  try {
    bytes = m ? Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0)) : undefined;
  } catch {
    bytes = undefined;
  }
  if (!bytes || bytes.length < 24 || bytes.length > 64) {
    throw new EventsRpcError(
      INVALID_PARAMS,
      'delivery.secret must be whsec_ and base64 of 24 to 64 bytes'
    );
  }
  return crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

function callbackUrl(delivery: Record<string, unknown>, allow: string[]): string {
  const raw = delivery.url;
  const parsed = typeof raw === 'string' && URL.canParse(raw) ? new URL(raw) : undefined;
  if (parsed?.protocol !== 'https:' || parsed.username || parsed.password) {
    throw new EventsRpcError(
      INVALID_PARAMS,
      'delivery.url must be an https URL without credentials'
    );
  }
  const url = parsed.href;
  if (!allow.some((prefix) => url.startsWith(prefix))) {
    throw new EventsRpcError(
      CALLBACK_ENDPOINT_ERROR,
      'delivery.url is not covered by --webhook-allow',
      { reason: 'challenge_failed' }
    );
  }
  return url;
}

function readDelivery(params: unknown): Record<string, unknown> {
  const delivery = isRecord(params) ? params.delivery : undefined;
  if (!isRecord(delivery)) throw new EventsRpcError(INVALID_PARAMS, 'delivery is required');
  if (delivery.mode !== undefined && delivery.mode !== 'webhook') {
    throw new EventsRpcError(INVALID_PARAMS, 'delivery.mode must be webhook');
  }
  return delivery;
}

function category(err: unknown, timedOut: boolean): string {
  if (timedOut) return 'timeout';
  const text = `${(err as Error).message} ${String((err as { cause?: unknown }).cause ?? '')}`;
  return /certificate|tls|ssl|self.signed/i.test(text) ? 'tls_error' : 'connection_refused';
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

export class WebhookRegistry {
  private readonly host: WebhookHost;
  private readonly o: WebhookOptions;
  private readonly hooks = new Map<string, Hook>();

  constructor(host: WebhookHost, options: WebhookOptions) {
    this.host = host;
    this.o = options;
  }

  private grant(params: unknown): number {
    const ttl = isRecord(params) ? params.ttlMs : undefined;
    if (ttl === undefined || ttl === null) return this.o.ttlMs;
    if (typeof ttl !== 'number' || !(ttl >= 0)) {
      throw new EventsRpcError(INVALID_PARAMS, 'ttlMs must be a non-negative number or null');
    }
    return Math.min(Math.max(ttl, MIN_TTL_MS), this.o.ttlMs);
  }

  private async identify(
    params: unknown,
    principal: string | undefined
  ): Promise<{ id: string; key: string; url: string; delivery: Record<string, unknown> }> {
    if (principal === undefined) {
      throw new EventsRpcError(FORBIDDEN, 'webhook delivery needs an authenticated client', {
        reason: 'unauthenticated',
      });
    }
    const delivery = readDelivery(params);
    const url = callbackUrl(delivery, this.o.allow);
    const { sub } = readSubscription(params, this.host.specs);
    const key = JSON.stringify([principal, url, sub.name, canonicalArgs(sub.arguments)]);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
    return { id: `sub_${hex(digest).slice(0, 16)}`, key, url, delivery };
  }

  async subscribe(
    params: unknown,
    principal: string | undefined
  ): Promise<Record<string, unknown>> {
    const { id, key, url, delivery } = await this.identify(params, principal);
    const { spec, sub } = readSubscription(params, this.host.specs);
    const raw = typeof delivery.secret === 'string' ? delivery.secret : '';
    const secretKeyed = await secretKey(raw);
    const ttl = this.grant(params);
    const refreshBefore = new Date(this.host.now() + ttl).toISOString();
    const existing = this.hooks.get(id);
    if (existing) {
      if (existing.secrets[0].raw !== raw) {
        existing.secrets = [
          { key: secretKeyed, raw },
          { ...existing.secrets[0], until: this.host.now() + ROTATION_GRACE_MS },
        ];
      }
      clearTimeout(existing.expires);
      existing.expires = setTimeout(() => this.remove(existing), ttl);
      existing.status.active = true;
      return {
        id,
        refreshBefore,
        cursor: existing.source.cursor(existing.acked),
        truncated: false,
        deliveryStatus: existing.status,
      };
    }
    if (this.hooks.size >= MAX_SUBSCRIPTIONS) {
      throw new EventsRpcError(RESOURCE_EXHAUSTED, 'too many webhook subscriptions', {
        limit: 'subscriptions',
        max: MAX_SUBSCRIPTIONS,
      });
    }
    const source = this.host.acquire(spec, sub.arguments);
    const pos = source.position(sub.cursor, sub.maxAgeMs);
    const hook: Hook = {
      id,
      key,
      url,
      source,
      secrets: [{ key: secretKeyed, raw }],
      acked: pos.seq,
      pumping: false,
      abort: new AbortController(),
      status: { active: true, lastError: null },
    };
    hook.expires = setTimeout(() => this.remove(hook), ttl);
    hook.off = source.on(() => void this.pump(hook));
    void this.pump(hook);
    this.hooks.set(id, hook);
    return { id, refreshBefore, cursor: source.cursor(pos.seq), truncated: pos.truncated };
  }

  async unsubscribe(
    params: unknown,
    principal: string | undefined
  ): Promise<Record<string, unknown>> {
    const { id } = await this.identify(params, principal);
    const hook = this.hooks.get(id);
    if (!hook) {
      throw new EventsRpcError(NOT_FOUND, 'no such webhook subscription', { kind: 'subscription' });
    }
    this.remove(hook);
    return {};
  }

  private remove(hook: Hook): void {
    this.hooks.delete(hook.id);
    clearTimeout(hook.expires);
    hook.off?.();
    hook.abort.abort();
    this.host.release(hook.source);
  }

  close(): void {
    for (const hook of [...this.hooks.values()]) this.remove(hook);
  }

  private async pump(hook: Hook): Promise<void> {
    if (hook.pumping) return;
    hook.pumping = true;
    const { source } = hook;
    while (!hook.abort.signal.aborted) {
      if (hook.acked < source.oldest - 1) {
        hook.acked = source.oldest - 1;
        const body = JSON.stringify({ type: 'gap', cursor: source.cursor(hook.acked) });
        await this.deliver(hook, `msg_gap_${randomId(8)}`, body, 'a gap notice');
        continue;
      }
      const [entry] = source.after(hook.acked, 1);
      if (!entry) break;
      const { eventId } = entry.occurrence;
      const body = JSON.stringify({ ...entry.occurrence, cursor: source.cursor(entry.seq) });
      await this.deliver(hook, eventId, body, `event ${eventId}`);
      hook.acked = entry.seq;
    }
    hook.pumping = false;
  }

  private async deliver(hook: Hook, webhookId: string, body: string, what: string): Promise<void> {
    const delays = this.o.retryDelaysMs ?? RETRY_DELAYS_MS;
    for (const delay of delays) {
      if (delay > 0) await sleep(delay, hook.abort.signal);
      if (hook.abort.signal.aborted) return;
      const outcome = await this.post(hook, webhookId, body);
      const now = new Date(this.host.now()).toISOString();
      if (outcome === 'ok') {
        hook.status = { active: true, lastDeliveryAt: now, lastError: null };
        return;
      }
      if (outcome === 'drop') return;
      hook.status = {
        ...hook.status,
        lastError: outcome,
        failedSince: hook.status.failedSince ?? now,
      };
    }
    await this.host.log(`webhook ${hook.id} gave up on ${what} (${hook.status.lastError})`);
  }

  private async sign(hook: Hook, message: string): Promise<string> {
    const now = this.host.now();
    hook.secrets = hook.secrets.filter((s) => s.until === undefined || s.until > now);
    const data = new TextEncoder().encode(message);
    const sigs = await Promise.all(
      hook.secrets.map(async (s) => `v1,${base64(await crypto.subtle.sign('HMAC', s.key, data))}`)
    );
    return sigs.join(' ');
  }

  private async post(hook: Hook, webhookId: string, body: string): Promise<string> {
    const timestamp = String(Math.floor(this.host.now() / 1000));
    const signature = await this.sign(hook, `${webhookId}.${timestamp}.${body}`);
    const timeout = new AbortController();
    const stop = () => timeout.abort();
    const timer = setTimeout(stop, this.o.deliveryTimeoutMs ?? DELIVERY_TIMEOUT_MS);
    hook.abort.signal.addEventListener('abort', stop, { once: true });
    try {
      const res = await this.host.fetch(hook.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'webhook-id': webhookId,
          'webhook-timestamp': timestamp,
          'webhook-signature': signature,
          'x-mcp-subscription-id': hook.id,
        },
        body,
        redirect: 'manual',
        signal: timeout.signal,
      });
      await res.body?.cancel().catch(() => {});
      if (res.status >= 200 && res.status < 300) return 'ok';
      if (res.status === 410 || res.status === 413) return 'drop';
      return res.status >= 500 ? 'http_5xx' : 'http_4xx';
    } catch (err) {
      return category(err, timeout.signal.aborted && !hook.abort.signal.aborted);
    } finally {
      clearTimeout(timer);
      hook.abort.signal.removeEventListener('abort', stop);
    }
  }
}
