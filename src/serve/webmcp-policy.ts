import type { AttachEvent } from './attach.ts';

export function headerAllows(header: string, own: string, origin: string): boolean {
  const entries = header.split(',').filter((entry) => entry.trim().startsWith('tools'));
  if (entries.length === 0) return true;
  if (entries.length !== 1) return false;
  const entry = entries[0]!.trim();
  const equals = entry.indexOf('=');
  if (equals < 0 || entry.slice(0, equals).trim() !== 'tools') return false;
  const value = entry.slice(equals + 1).trim();
  if (value === '*') return true;
  if (!value.startsWith('(') || !value.endsWith(')')) return false;
  let matched = false;
  for (const token of value.slice(1, -1).split(/\s+/).filter(Boolean)) {
    if (token === 'self') {
      matched ||= own === origin;
      continue;
    }
    if (!token.startsWith('"') || !token.endsWith('"')) return false;
    const raw = token.slice(1, -1);
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      return false;
    }
    if (
      !/^https?:$/.test(parsed.protocol) ||
      parsed.pathname !== '/' ||
      raw.includes('?') ||
      raw.includes('#') ||
      parsed.username ||
      parsed.password
    )
      return false;
    matched ||= parsed.origin === origin;
  }
  return matched;
}

export function iframeAllows(allow: string, parent: string, child: string, src: string): boolean {
  const entries = allow
    .split(';')
    .map((entry) => entry.trim().split(/\s+/))
    .filter((values) => values[0] === 'tools');
  if (entries.length === 0) return parent === child;
  if (entries.length !== 1) return false;
  const values = entries[0]!.slice(1);
  if (values.length === 0) return child === src;
  if (values.includes("'none'")) return false;
  return values.some(
    (value) =>
      value === '*' ||
      (value === "'self'" && parent === child) ||
      (value === "'src'" && src === child) ||
      value === child
  );
}

interface Evidence {
  frameId: string;
  loaderId: string;
  origin: string;
  permissionsPolicy?: unknown;
  toolsAllowed?: unknown;
  allow?: unknown;
  srcOrigin?: unknown;
}

function evidence(value: unknown): value is Evidence {
  if (!value || typeof value !== 'object') return false;
  const entry = value as Evidence;
  return ['frameId', 'loaderId', 'origin'].every(
    (key) => typeof entry[key as keyof Evidence] === 'string' && entry[key as keyof Evidence]
  );
}

export function childToolAllowed(event: AttachEvent, exposedTo: unknown): boolean {
  if (!Array.isArray(event.ancestors) || event.ancestors.length === 0) return false;
  const chain: unknown[] = [...event.ancestors, event];
  if (!chain.every(evidence)) return false;
  const top = chain[0]!;
  const child = chain[chain.length - 1]!;
  if (event.parentFrameId !== chain[chain.length - 2]!.frameId) return false;
  if (new Set(chain.map((entry) => entry.frameId)).size !== chain.length) return false;
  if (
    child.origin !== top.origin &&
    (!Array.isArray(exposedTo) ||
      !exposedTo.some((origin) => origin === '*' || origin === top.origin))
  )
    return false;
  for (let index = 0; index < chain.length; index++) {
    const current = chain[index]!;
    if (!documentAllows(current)) return false;
    if (index === 0) continue;
    const parent = chain[index - 1]!;
    if (typeof current.allow !== 'string' || typeof current.srcOrigin !== 'string') return false;
    if (!iframeAllows(current.allow, parent.origin, current.origin, current.srcOrigin))
      return false;
    if (
      typeof parent.permissionsPolicy === 'string' &&
      !headerAllows(parent.permissionsPolicy, parent.origin, current.origin)
    )
      return false;
  }
  return true;
}

function documentAllows(current: Evidence): boolean {
  if (current.toolsAllowed === false) return false;
  if (typeof current.permissionsPolicy === 'string')
    return headerAllows(current.permissionsPolicy, current.origin, current.origin);
  return current.toolsAllowed === true;
}
