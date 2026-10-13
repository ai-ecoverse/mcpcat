export function isLoopbackBind(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

export function buildServerOrigins(host: string, port: number): Set<string> {
  const origins = new Set<string>();
  origins.add(`http://${host}:${port}`);
  origins.add(`http://${port}.kernel.localhost`);
  if (isLoopbackBind(host)) {
    origins.add(`http://localhost:${port}`);
    origins.add(`http://127.0.0.1:${port}`);
    origins.add(`http://[::1]:${port}`);
  }
  return origins;
}

export function checkOrigin(
  origin: string | undefined,
  serverOrigins: Set<string>,
  allowedOrigins: Set<string>
): { ok: boolean; reason?: string } {
  if (origin === undefined) return { ok: true };
  if (serverOrigins.has(origin)) return { ok: true };
  if (allowedOrigins.has(origin)) return { ok: true };
  return { ok: false, reason: `origin ${origin} is not allowed` };
}

export function buildAllowedHosts(host: string, port: number, extraHosts: string[]): Set<string> {
  const hosts = new Set<string>();
  hosts.add(`${host}:${port}`);
  hosts.add(host);
  hosts.add(`${port}.kernel.localhost`);
  const loopback = ['localhost', '127.0.0.1', '[::1]'];
  for (const h of loopback) {
    hosts.add(h);
    hosts.add(`${h}:${port}`);
  }
  for (const h of extraHosts) hosts.add(h);
  return hosts;
}

export function checkHost(
  host: string | undefined,
  allowedHosts: Set<string>
): { ok: boolean; reason?: string } {
  if (!host) return { ok: false, reason: 'missing Host header' };
  if (allowedHosts.has(host)) return { ok: true };
  const hostname = host.replace(/:\d+$/, '');
  if (allowedHosts.has(hostname)) return { ok: true };
  if (hostname.endsWith('.localhost')) return { ok: true };
  return { ok: false, reason: `host ${host} is not allowed` };
}
