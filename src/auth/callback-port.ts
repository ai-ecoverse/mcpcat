import { OAuthCallbackServer } from '@earendil-works/pi-mcp/oauth';
import { cacheDir, userConfigPath } from '../config/paths.ts';
import type { McpOAuthConfig } from '../config/types.ts';
import type { Platform } from '../platform/types.ts';

export function needsInjectedCallbackPort(options: {
  namedEntry: boolean;
  oauth: McpOAuthConfig | undefined;
}): boolean {
  return options.namedEntry && !options.oauth?.callbackPort && !options.oauth?.callbackUrl;
}

export async function withInjectedCallbackPortIfNeeded<T>(
  platform: Platform,
  name: string,
  options: { namedEntry: boolean; oauth: McpOAuthConfig | undefined },
  fn: (env: Record<string, string> | undefined) => Promise<T>
): Promise<T> {
  if (!needsInjectedCallbackPort(options)) return fn(undefined);
  const port = await allocateCallbackPort();
  return withTempCallbackPortConfig(platform, name, port, fn);
}

export async function allocateCallbackPort(): Promise<number> {
  const callback = await OAuthCallbackServer.listen({
    host: '127.0.0.1',
    port: 0,
    path: '/callback',
  });
  try {
    return Number(new URL(callback.redirectUrl).port);
  } finally {
    await callback.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hostEnv(platform: Platform): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(platform.env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}

async function makeTempDir(platform: Platform): Promise<string> {
  const base = `${cacheDir(platform)}/mcp-cb`;
  await platform.fs.mkdir(base, { mode: 0o700 });
  for (let i = 0; i < 32; i++) {
    const dir = `${base}/${Date.now().toString(36)}-${i.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    try {
      await platform.fs.mkdirExclusive(dir);
      return dir;
    } catch {}
  }
  throw new Error('unable to create temporary mcp config directory');
}

async function removeTempDir(platform: Platform, dir: string): Promise<void> {
  try {
    if (platform.fs.unlink) await platform.fs.unlink(`${dir}/mcp.json`);
  } catch {}
  try {
    await platform.fs.rmdir(dir);
  } catch {}
}

export async function withTempCallbackPortConfig<T>(
  platform: Platform,
  name: string,
  port: number,
  fn: (env: Record<string, string> | undefined) => Promise<T>
): Promise<T> {
  const path = userConfigPath(platform);
  let raw: string;
  try {
    raw = new TextDecoder().decode(await platform.fs.readFile(path));
  } catch {
    return fn(undefined);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fn(undefined);
  }
  if (!isRecord(parsed) || !isRecord(parsed.mcpServers) || !isRecord(parsed.mcpServers[name])) {
    return fn(undefined);
  }
  const entry = { ...(parsed.mcpServers[name] as Record<string, unknown>) };
  const prevOauth = isRecord(entry.oauth) ? { ...entry.oauth } : {};
  entry.oauth = { ...prevOauth, callbackPort: port };
  const tempServers = { ...(parsed.mcpServers as Record<string, unknown>), [name]: entry };
  const merged = { ...parsed, mcpServers: tempServers };
  const tempDir = await makeTempDir(platform);
  const tempPath = `${tempDir}/mcp.json`;
  await platform.fs.writeFile(tempPath, `${JSON.stringify(merged, null, 2)}\n`, { mode: 0o600 });

  const env = { ...hostEnv(platform), PI_MCP_CONFIG: tempPath };

  let cleaned = false;
  const cleanup = async () => {
    if (cleaned) return;
    cleaned = true;
    await removeTempDir(platform, tempDir);
  };

  const exitFor = (signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP'): number =>
    signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 129;

  let signalCode: number | undefined;
  let wake: (() => void) | undefined;
  const stopped = new Promise<void>((resolve) => {
    wake = resolve;
  });

  if (platform.onSignal) {
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
      await platform.onSignal(signal, () => {
        void cleanup().then(() => {
          signalCode = exitFor(signal);
          wake?.();
        });
      });
    }
  }

  try {
    const result = await Promise.race([
      fn(env).then((value) => ({ ok: true as const, value })),
      stopped.then(() => ({ ok: false as const })),
    ]);
    if (!result.ok) platform.exit(signalCode ?? 130);
    return result.value;
  } finally {
    await cleanup();
  }
}
