import type { Candidate, DiscoveryEvent, TrustSignal } from './types.ts';

let nextId = 1;

function candidateId(): string {
  return String(nextId++);
}

export function resetIdCounter(start = 1): void {
  nextId = start;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function checkUrnPublisher(identifier: string, originHost: string): TrustSignal | undefined {
  const urnMatch = /^urn:air:([^:]+):/.exec(identifier);
  if (!urnMatch) return undefined;
  const urnDomain = urnMatch[1];
  if (domainMatch(urnDomain, originHost)) {
    return { type: 'urn-publisher', detail: `${urnDomain} matches ${originHost}` };
  }
  return { type: 'urn-publisher-mismatch', detail: `${urnDomain} does not match ${originHost}` };
}

function checkTrustManifest(
  entry: Record<string, unknown>,
  originHost: string
): TrustSignal | undefined {
  if (!isRecord(entry.trustManifest) || typeof entry.trustManifest.identity !== 'string')
    return undefined;
  const identity = entry.trustManifest.identity;
  if (domainMatch(identity, originHost)) {
    return { type: 'trust-manifest', detail: `identity ${identity} matches origin` };
  }
  return {
    type: 'trust-manifest-mismatch',
    detail: `identity ${identity} does not match ${originHost}`,
  };
}

function extractArd(event: DiscoveryEvent): Candidate[] {
  const candidates: Candidate[] = [];
  const summary = event.summary;
  if (!isRecord(summary)) return candidates;
  const entries = summary.entries;
  if (!Array.isArray(entries)) return candidates;
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    if (entry.type !== 'application/mcp-server-card+json') continue;
    const url = typeof entry.url === 'string' ? entry.url : undefined;
    if (!url) continue;
    const trust: TrustSignal[] = [];
    const originHost = hostFromUrl(event.origin);
    const identifier = typeof entry.identifier === 'string' ? entry.identifier : undefined;
    if (identifier) {
      const urnSignal = checkUrnPublisher(identifier, originHost);
      if (urnSignal) trust.push(urnSignal);
    }
    const tmSignal = checkTrustManifest(entry, originHost);
    if (tmSignal) trust.push(tmSignal);
    candidates.push({
      id: candidateId(),
      endpoint: url,
      standard: 'ard',
      origin: event.origin,
      name: typeof entry.displayName === 'string' ? entry.displayName : undefined,
      transport: 'http',
      trust,
      status: event.status,
      reason: event.reason,
      discoveredAt: new Date().toISOString(),
    });
  }
  return candidates;
}

function extractAiCatalog(event: DiscoveryEvent): Candidate[] {
  const candidates: Candidate[] = [];
  const summary = event.summary;
  if (!isRecord(summary)) return candidates;
  const entries = summary.entries;
  if (!Array.isArray(entries)) return candidates;
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    if (entry.type !== 'application/mcp-server-card+json' && entry.type !== 'mcp-server') continue;
    const url = typeof entry.url === 'string' ? entry.url : undefined;
    if (!url) continue;
    candidates.push({
      id: candidateId(),
      endpoint: url,
      standard: 'ai-catalog',
      origin: event.origin,
      name: typeof entry.displayName === 'string' ? entry.displayName : undefined,
      transport: 'http',
      trust: [],
      status: event.status,
      reason: event.reason,
      discoveredAt: new Date().toISOString(),
    });
  }
  return candidates;
}

function extractUcp(event: DiscoveryEvent): Candidate[] {
  const candidates: Candidate[] = [];
  const summary = event.summary;
  if (!isRecord(summary)) return candidates;
  const services = summary.services;
  if (!isRecord(services)) return candidates;
  for (const [svcName, svcValue] of Object.entries(services)) {
    if (!Array.isArray(svcValue)) continue;
    for (const transport of svcValue) {
      if (!isRecord(transport)) continue;
      if (transport.transport !== 'mcp') continue;
      const endpoint = typeof transport.endpoint === 'string' ? transport.endpoint : undefined;
      if (!endpoint) continue;
      candidates.push({
        id: candidateId(),
        endpoint,
        standard: 'ucp',
        origin: event.origin,
        name: svcName,
        transport: 'http',
        trust: [],
        status: event.status,
        reason: event.reason,
        discoveredAt: new Date().toISOString(),
      });
    }
  }
  return candidates;
}

function extractPoppy(event: DiscoveryEvent): Candidate[] {
  const candidates: Candidate[] = [];
  const summary = event.summary;
  if (!isRecord(summary)) return candidates;
  const apis = summary.apis;
  if (!Array.isArray(apis)) return candidates;
  for (const api of apis) {
    if (!isRecord(api)) continue;
    if (api.type !== 'mcp') continue;
    const url = typeof api.url === 'string' ? api.url : undefined;
    if (!url) continue;
    candidates.push({
      id: candidateId(),
      endpoint: url,
      standard: 'poppy',
      origin: event.origin,
      transport: 'http',
      trust: [],
      status: event.status,
      reason: event.reason,
      discoveredAt: new Date().toISOString(),
    });
  }
  return candidates;
}

function extractNlweb(event: DiscoveryEvent): Candidate[] {
  const summary = event.summary;
  if (!isRecord(summary)) return [];
  const mcpUrl = typeof summary.mcpUrl === 'string' ? summary.mcpUrl : undefined;
  if (!mcpUrl) return [];
  return [
    {
      id: candidateId(),
      endpoint: mcpUrl,
      standard: 'nlweb',
      origin: event.origin,
      transport: 'http',
      trust: [],
      status: event.status,
      reason: event.reason,
      discoveredAt: new Date().toISOString(),
    },
  ];
}

function extractWebmcp(event: DiscoveryEvent): Candidate[] {
  return [
    {
      id: candidateId(),
      endpoint: event.url,
      standard: 'webmcp',
      origin: event.origin,
      transport: 'webmcp',
      trust: [],
      status: event.status,
      reason: event.reason,
      suggestion: 'mcpcat serve --webmcp',
      discoveredAt: new Date().toISOString(),
    },
  ];
}

function hostFromUrl(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function domainMatch(a: string, b: string): boolean {
  const na = a.toLowerCase().replace(/^www\./, '');
  const nb = b.toLowerCase().replace(/^www\./, '');
  if (na === nb) return true;
  if (nb.endsWith(`.${na}`) || na.endsWith(`.${nb}`)) return true;
  return false;
}

const EXTRACTORS: Record<string, (event: DiscoveryEvent) => Candidate[]> = {
  ard: extractArd,
  'ai-catalog': extractAiCatalog,
  ucp: extractUcp,
  poppy: extractPoppy,
  nlweb: extractNlweb,
  webmcp: extractWebmcp,
};

export function extractCandidates(event: DiscoveryEvent): Candidate[] {
  const extractor = EXTRACTORS[event.standard];
  if (!extractor) return [];
  return extractor(event);
}

export function deduplicateCandidates(candidates: Candidate[]): Candidate[] {
  const seen = new Set<string>();
  const result: Candidate[] = [];
  for (const c of candidates) {
    const key = c.endpoint;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(c);
  }
  return result;
}
