import { OAuthCallbackServer } from '@earendil-works/pi-mcp/oauth';
import { userConfigPath } from '../config/paths.ts';
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
  fn: () => Promise<T>
): Promise<T> {
  if (!needsInjectedCallbackPort(options)) return fn();
  const port = await allocateCallbackPort();
  return withNamedCallbackPort(platform, name, port, fn);
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

export async function withNamedCallbackPort<T>(
  platform: Platform,
  name: string,
  port: number,
  fn: () => Promise<T>
): Promise<T> {
  const path = userConfigPath(platform);
  const fs = platform.fs;
  let raw: string | undefined;
  try {
    raw = new TextDecoder().decode(await fs.readFile(path));
  } catch {
    return fn();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fn();
  }
  if (!isRecord(parsed) || !isRecord(parsed.mcpServers) || !isRecord(parsed.mcpServers[name])) {
    return fn();
  }
  const entry = parsed.mcpServers[name] as Record<string, unknown>;
  const prevOauth = isRecord(entry.oauth) ? { ...entry.oauth } : undefined;
  const hadPort = prevOauth !== undefined && 'callbackPort' in prevOauth;
  const previousPort = hadPort ? prevOauth.callbackPort : undefined;
  entry.oauth = { ...(prevOauth ?? {}), callbackPort: port };
  const indent = /^([ \t]+)\S/m.exec(raw)?.[1] ?? '  ';
  const output = `${JSON.stringify(parsed, null, indent)}\n`;
  const tmpPath = `${path}.tmp.${Date.now()}`;
  await fs.writeFile(tmpPath, output, { mode: 0o600 });
  await fs.rename(tmpPath, path);
  try {
    return await fn();
  } finally {
    try {
      const again = JSON.parse(new TextDecoder().decode(await fs.readFile(path))) as Record<
        string,
        unknown
      >;
      if (isRecord(again.mcpServers) && isRecord(again.mcpServers[name])) {
        const restore = again.mcpServers[name] as Record<string, unknown>;
        if (hadPort) {
          restore.oauth = {
            ...(isRecord(restore.oauth) ? restore.oauth : {}),
            callbackPort: previousPort,
          };
        } else if (isRecord(restore.oauth)) {
          delete restore.oauth.callbackPort;
          if (Object.keys(restore.oauth).length === 0) delete restore.oauth;
        }
        const out = `${JSON.stringify(again, null, indent)}\n`;
        const tmp = `${path}.tmp.${Date.now()}`;
        await fs.writeFile(tmp, out, { mode: 0o600 });
        await fs.rename(tmp, path);
      }
    } catch {}
  }
}
