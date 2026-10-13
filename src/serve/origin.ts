const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    const hostname = url.hostname;
    if (LOOPBACK_HOSTS.has(hostname)) return true;
    if (hostname === '::1') return true;
    if (hostname.endsWith('.localhost')) return true;
    return false;
  } catch {
    return false;
  }
}

export function isLoopbackHost(host: string): boolean {
  const hostname = host.replace(/:\d+$/, '');
  if (LOOPBACK_HOSTS.has(hostname)) return true;
  if (hostname === '::1') return true;
  if (hostname.endsWith('.localhost')) return true;
  return false;
}

export function checkOrigin(
  origin: string | undefined,
  allowedOrigins: Set<string>,
  boundLoopback: boolean
): { ok: boolean; reason?: string } {
  if (origin === undefined) return { ok: true };
  if (allowedOrigins.has(origin)) return { ok: true };
  if (isLoopbackOrigin(origin)) return { ok: true };
  if (!boundLoopback) return { ok: true };
  return { ok: false, reason: `origin ${origin} is not allowed` };
}

export function checkHost(
  host: string | undefined,
  boundLoopback: boolean
): { ok: boolean; reason?: string } {
  if (!boundLoopback) return { ok: true };
  if (!host) return { ok: false, reason: 'missing Host header' };
  if (isLoopbackHost(host)) return { ok: true };
  return { ok: false, reason: `host ${host} is not loopback` };
}
