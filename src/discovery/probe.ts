import type { Platform } from '../platform/types.ts';
import type { DiscoveryEvent } from './types.ts';

interface ProbeResult {
  events: DiscoveryEvent[];
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

async function probeUrl(
  fetcher: typeof globalThis.fetch,
  url: string,
  accept?: string
): Promise<{ ok: boolean; status: number; headers: Headers; body: string } | undefined> {
  try {
    const resp = await fetcher(url, {
      redirect: 'manual',
      headers: accept ? { Accept: accept } : undefined,
      credentials: 'omit' as RequestCredentials,
    });
    if (resp.status !== 200)
      return { ok: false, status: resp.status, headers: resp.headers, body: '' };
    const ct = resp.headers.get('content-type');
    if (!isJsonContentType(ct))
      return { ok: false, status: resp.status, headers: resp.headers, body: '' };
    const body = await resp.text();
    return { ok: true, status: 200, headers: resp.headers, body };
  } catch {
    return undefined;
  }
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
  page: string
): Promise<DiscoveryEvent[]> {
  const events: DiscoveryEvent[] = [];
  const targetResult = await probeUrl(fetcher, targetUrl);
  if (!targetResult) return events;

  const links = parseLinkHeaders(targetResult.headers);
  for (const link of links) {
    const resolved = new URL(link.url, targetUrl).href;
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

async function probeMcp(
  fetcher: typeof globalThis.fetch,
  origin: string,
  page: string
): Promise<DiscoveryEvent[]> {
  const mcpUrl = `${origin}/mcp`;
  const mcpResult = await probeUrl(fetcher, mcpUrl, 'application/json');
  if (mcpResult?.ok) {
    const body = tryParseJson(mcpResult.body);
    if (isRecord(body)) {
      return [makeEvent('mcp', origin, mcpUrl, 'well-known', page, 'valid', { endpoint: mcpUrl })];
    }
  }
  return [];
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
  const events = [
    ...(await probeWellKnown(fetcher, origin, page)),
    ...(await probeLinkHeaders(fetcher, targetUrl, origin, page)),
    ...(await probeMcp(fetcher, origin, page)),
  ];
  return { events };
}
