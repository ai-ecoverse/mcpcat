import { META_SERVER_INFO, MODERN_PROTOCOL_VERSION, modernRequestMeta } from '../client/modern.ts';
import type { Platform } from '../platform/types.ts';
import type { DiscoveryEvent, TrustSignal } from './types.ts';

interface ProbeResult {
  events: DiscoveryEvent[];
}

const LOOPBACK_RE = /^(127\.\d+\.\d+\.\d+|\[?::1\]?|localhost)$/i;
const LINK_LOCAL_RE = /^(169\.254\.|fe80:)/i;
const PRIVATE_RE = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|fc|fd)/i;
const LOCALHOST_SUFFIX_RE = /\.localhost$/i;
const SLICC_INTERNAL_RE = /^host\.slicc\.internal$/i;

function isPrivateOrLoopback(hostname: string): boolean {
  const bare = hostname.replace(/^\[|\]$/g, '');
  return (
    LOOPBACK_RE.test(bare) ||
    LINK_LOCAL_RE.test(bare) ||
    PRIVATE_RE.test(bare) ||
    LOCALHOST_SUFFIX_RE.test(bare) ||
    SLICC_INTERNAL_RE.test(bare)
  );
}

function isSameOrigin(base: string, candidate: string): boolean {
  try {
    const a = new URL(base);
    const b = new URL(candidate);
    return a.origin === b.origin;
  } catch {
    return false;
  }
}

function isUserUrlPrivate(userUrl: string): boolean {
  try {
    return isPrivateOrLoopback(new URL(userUrl).hostname);
  } catch {
    return false;
  }
}

function isJsonContentType(ct: string | null): boolean {
  if (!ct) return false;
  const lower = ct.toLowerCase();
  if (lower.includes('text/html')) return false;
  return lower.includes('json') || lower.includes('+json');
}

function parseLinkHeaders(headers: Headers): Array<{ url: string; rel: string }> {
  const links: Array<{ url: string; rel: string }> = [];
  const raw = headers.get('link');
  if (!raw) return links;
  const parts = raw.split(/,(?=\s*<)/);
  for (const part of parts) {
    const urlMatch = /<([^>]+)>/.exec(part);
    const relMatch = /rel\s*=\s*"?([^";,\s]+)"?/i.exec(part);
    if (urlMatch && relMatch) {
      links.push({ url: urlMatch[1], rel: relMatch[1].toLowerCase() });
    }
  }
  return links;
}

function wasRedirected(requestUrl: string, resp: Response): boolean {
  if (resp.redirected) return true;
  if (resp.url && resp.url !== requestUrl) return true;
  return false;
}

async function probeUrl(
  fetcher: typeof globalThis.fetch,
  url: string,
  accept?: string
): Promise<{ ok: boolean; status: number; headers: Headers; body: string } | undefined> {
  let resp: Response;
  try {
    resp = await fetcher(url, {
      redirect: 'manual',
      headers: accept ? { Accept: accept } : undefined,
      credentials: 'omit' as RequestCredentials,
    });
  } catch {
    try {
      resp = await fetcher(url, {
        redirect: 'follow',
        headers: accept ? { Accept: accept } : undefined,
        credentials: 'omit' as RequestCredentials,
      });
      if (wasRedirected(url, resp)) {
        return { ok: false, status: 301, headers: resp.headers, body: '' };
      }
    } catch {
      return undefined;
    }
  }
  if (resp.status !== 200)
    return { ok: false, status: resp.status, headers: resp.headers, body: '' };
  const ct = resp.headers.get('content-type');
  if (!isJsonContentType(ct))
    return { ok: false, status: resp.status, headers: resp.headers, body: '' };
  const body = await resp.text();
  return { ok: true, status: 200, headers: resp.headers, body };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function makeEvent(
  standard: string,
  origin: string,
  url: string,
  via: DiscoveryEvent['via'],
  page: string,
  status: 'valid' | 'invalid',
  summary: unknown,
  reason?: string
): DiscoveryEvent {
  return {
    v: 1,
    standard,
    origin,
    url,
    via,
    page,
    targetId: '',
    status,
    summary,
    ...(reason ? { reason } : {}),
  };
}

function tryParseJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

function classifyArd(
  origin: string,
  url: string,
  via: DiscoveryEvent['via'],
  page: string,
  body: string
): DiscoveryEvent | undefined {
  const parsed = tryParseJson(body);
  if (!isRecord(parsed))
    return makeEvent('ard', origin, url, via, page, 'invalid', null, 'invalid JSON');
  if (!Array.isArray(parsed.entries))
    return makeEvent('ard', origin, url, via, page, 'invalid', null, 'missing entries[]');
  const entries: unknown[] = [];
  for (const entry of parsed.entries) {
    if (!isRecord(entry)) continue;
    entries.push({
      identifier: entry.identifier,
      displayName: entry.displayName,
      type: entry.type,
      url: entry.url,
      capabilities: entry.capabilities,
      representativeQueries: entry.representativeQueries,
      trustManifest: entry.trustManifest,
    });
  }
  return makeEvent('ard', origin, url, via, page, 'valid', { entries });
}

function classifyAiCatalog(
  origin: string,
  url: string,
  via: DiscoveryEvent['via'],
  page: string,
  body: string
): DiscoveryEvent | undefined {
  const parsed = tryParseJson(body);
  if (!isRecord(parsed))
    return makeEvent('ai-catalog', origin, url, via, page, 'invalid', null, 'invalid JSON');
  const entries: unknown[] = [];
  const items = Array.isArray(parsed.entries)
    ? parsed.entries
    : Array.isArray(parsed.items)
      ? parsed.items
      : undefined;
  if (!items)
    return makeEvent('ai-catalog', origin, url, via, page, 'invalid', null, 'no entries or items');
  for (const entry of items) {
    if (!isRecord(entry)) continue;
    entries.push({
      displayName: entry.displayName ?? entry.name,
      type: entry.type,
      url: entry.url,
    });
  }
  return makeEvent('ai-catalog', origin, url, via, page, 'valid', { entries });
}

async function probeWellKnown(
  fetcher: typeof globalThis.fetch,
  origin: string,
  page: string
): Promise<DiscoveryEvent[]> {
  const events: DiscoveryEvent[] = [];

  const ardUrl = `${origin}/.well-known/ard.json`;
  const ardResult = await probeUrl(fetcher, ardUrl, 'application/json');
  if (ardResult?.ok) {
    const ev = classifyArd(origin, ardUrl, 'well-known', page, ardResult.body);
    if (ev) events.push(ev);
  }

  const aiCatUrl = `${origin}/.well-known/ai-catalog.json`;
  const aiCatResult = await probeUrl(fetcher, aiCatUrl, 'application/json');
  if (aiCatResult?.ok) {
    const ev = classifyAiCatalog(origin, aiCatUrl, 'well-known', page, aiCatResult.body);
    if (ev) events.push(ev);
  }

  return events;
}

async function probeLinkHeaders(
  fetcher: typeof globalThis.fetch,
  targetUrl: string,
  origin: string,
  page: string,
  userUrlIsPrivate: boolean
): Promise<DiscoveryEvent[]> {
  const events: DiscoveryEvent[] = [];
  const targetResult = await probeUrl(fetcher, targetUrl);
  if (!targetResult) return events;

  const links = parseLinkHeaders(targetResult.headers);
  for (const link of links) {
    const resolved = new URL(link.url, targetUrl).href;
    if (!isSameOrigin(targetUrl, resolved)) {
      events.push(
        makeEvent(
          link.rel,
          origin,
          resolved,
          'link-header',
          page,
          'invalid',
          null,
          `skipped: cross-origin Link target (${new URL(resolved).origin})`
        )
      );
      continue;
    }
    const resolvedHost = new URL(resolved).hostname;
    if (!userUrlIsPrivate && isPrivateOrLoopback(resolvedHost)) {
      events.push(
        makeEvent(
          link.rel,
          origin,
          resolved,
          'link-header',
          page,
          'invalid',
          null,
          `skipped: private/loopback target (${resolvedHost})`
        )
      );
      continue;
    }
    const classifier =
      link.rel === 'ard' ? classifyArd : link.rel === 'ai-catalog' ? classifyAiCatalog : null;
    if (!classifier) continue;
    const linkResult = await probeUrl(fetcher, resolved, 'application/json');
    if (linkResult?.ok) {
      const ev = classifier(origin, resolved, 'link-header', page, linkResult.body);
      if (ev) events.push(ev);
    }
  }
  return events;
}

interface McpProbeHit {
  url: string;
  serverInfo?: { name?: string; version?: string };
  trust: TrustSignal[];
}

function sseResponse(text: string, id: unknown): unknown {
  for (const block of text.replace(/\r\n?/g, '\n').split('\n\n')) {
    const data = block
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).replace(/^ /, ''))
      .join('\n');
    const parsed = tryParseJson(data);
    if (isRecord(parsed) && parsed.id === id) return parsed;
  }
  return undefined;
}

function mcpJsonRpc(method: string, params: unknown, id = 1): string {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params });
}

function parseServerInfo(
  result: Record<string, unknown>
): { name?: string; version?: string } | undefined {
  const meta = isRecord(result._meta) ? result._meta : undefined;
  const fromMeta = meta && isRecord(meta[META_SERVER_INFO]) ? meta[META_SERVER_INFO] : undefined;
  const si = fromMeta ?? (isRecord(result.serverInfo) ? result.serverInfo : undefined);
  if (!si) return undefined;
  return {
    name: typeof si.name === 'string' ? si.name : undefined,
    version: typeof si.version === 'string' ? si.version : undefined,
  };
}

function checkAuthResponse(resp: Response): TrustSignal | undefined {
  if (resp.status !== 401) return undefined;
  const wwwAuth = resp.headers.get('www-authenticate');
  if (!wwwAuth) return undefined;
  return { type: 'auth-required', detail: wwwAuth.split(',')[0].trim() };
}

async function tryMcpPost(
  fetcher: typeof globalThis.fetch,
  url: string,
  body: string,
  extraHeaders?: Record<string, string>
): Promise<McpProbeHit | undefined> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    ...extraHeaders,
  };
  try {
    const resp = await fetcher(url, {
      method: 'POST',
      headers,
      body,
      redirect: 'manual',
      credentials: 'omit' as RequestCredentials,
    });
    const authSignal = checkAuthResponse(resp);
    if (authSignal) return { url, trust: [authSignal] };
    if (resp.status === 200) {
      const text = await resp.text();
      const sse = (resp.headers.get('content-type') ?? '').includes('text/event-stream');
      const parsed = sse
        ? sseResponse(text, (tryParseJson(body) as { id?: unknown } | undefined)?.id)
        : tryParseJson(text);
      if (isRecord(parsed) && isRecord(parsed.result)) {
        return { url, serverInfo: parseServerInfo(parsed.result), trust: [] };
      }
    }
  } catch {}
  return undefined;
}

async function probeMcpEndpoint(
  fetcher: typeof globalThis.fetch,
  url: string
): Promise<McpProbeHit | undefined> {
  const discoverBody = mcpJsonRpc('server/discover', {
    _meta: modernRequestMeta(MODERN_PROTOCOL_VERSION, { name: 'mcpcat', version: '0.0.0' }),
  });
  const hit = await tryMcpPost(fetcher, url, discoverBody, {
    'MCP-Protocol-Version': MODERN_PROTOCOL_VERSION,
    'Mcp-Method': 'server/discover',
  });
  if (hit) return hit;

  const initBody = mcpJsonRpc(
    'initialize',
    {
      protocolVersion: '2025-11-25',
      clientInfo: { name: 'mcpcat', version: '0.0.0' },
      capabilities: {},
    },
    2
  );
  return tryMcpPost(fetcher, url, initBody);
}

async function probeMcp(
  fetcher: typeof globalThis.fetch,
  origin: string,
  page: string,
  targetUrl: string
): Promise<DiscoveryEvent[]> {
  const events: DiscoveryEvent[] = [];
  const urls = [targetUrl];
  const mcpUrl = `${origin}/mcp`;
  if (mcpUrl !== targetUrl) urls.push(mcpUrl);

  for (const url of urls) {
    const hit = await probeMcpEndpoint(fetcher, url);
    if (hit) {
      const summary: Record<string, unknown> = { endpoint: hit.url };
      if (hit.serverInfo) summary.serverInfo = hit.serverInfo;
      if (hit.trust.length > 0) summary.trust = hit.trust;
      events.push(makeEvent('mcp', origin, hit.url, 'well-known', page, 'valid', summary));
    }
  }
  return events;
}

export async function probeDiscover(platform: Platform, targetUrl: string): Promise<ProbeResult> {
  let origin: string;
  try {
    const u = new URL(targetUrl);
    origin = u.origin;
  } catch {
    return { events: [] };
  }

  const page = targetUrl;
  const fetcher = platform.fetch;
  const userPrivate = isUserUrlPrivate(targetUrl);
  const events = [
    ...(await probeWellKnown(fetcher, origin, page)),
    ...(await probeLinkHeaders(fetcher, targetUrl, origin, page, userPrivate)),
    ...(await probeMcp(fetcher, origin, page, targetUrl)),
  ];
  return { events };
}
