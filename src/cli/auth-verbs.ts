import {
  JERK_EXIT_SIGN_IN,
  JERK_TIMEOUT_MS,
  JerkTimeoutError,
  JerkTokenSource,
  jerkAvailable,
  runJerk,
} from '../auth/jerk-token-source.ts';
import { SignInCancelledError, signIn } from '../auth/oauth.ts';
import { PiFileTokenSource } from '../auth/pi-store.ts';
import type { TokenSource } from '../auth/token-source.ts';
import { isKernel } from '../auth/token-source.ts';
import { MergedConfigSource } from '../config/index.ts';
import type { McpOAuthConfig } from '../config/types.ts';
import type { Platform } from '../platform/types.ts';

let resolvedSource: TokenSource | undefined;

export async function createTokenSource(
  platform: Platform,
  timeoutMs: number = JERK_TIMEOUT_MS
): Promise<TokenSource> {
  if (isKernel(platform)) return new PiFileTokenSource(platform);
  if (resolvedSource) return resolvedSource;
  if (await jerkAvailable(platform)) {
    resolvedSource = new JerkTokenSource(platform, timeoutMs);
  } else {
    resolvedSource = new PiFileTokenSource(platform);
  }
  return resolvedSource;
}

export function resetTokenSourceCache(): void {
  resolvedSource = undefined;
}

const VALUE_FLAGS = new Set(['--scope', '-m', '--timeout']);

function positionals(args: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (VALUE_FLAGS.has(args[i])) i++;
    else if (!args[i].startsWith('-')) out.push(args[i]);
  }
  return out;
}

function resolveServerName(target: string): { name: string; isUrl: boolean } {
  try {
    const u = new URL(target.startsWith('http') ? target : `https://${target}`);
    if (target.includes('.') || target.includes(':')) {
      return { name: `url:${u.origin}${u.pathname}`, isUrl: true };
    }
  } catch {}
  return { name: target, isUrl: false };
}

async function resolveLoginTarget(
  platform: Platform,
  target: string
): Promise<{
  name: string;
  serverUrl: string;
  oauth: McpOAuthConfig | undefined;
}> {
  const config = await MergedConfigSource.load(platform);
  const entry = config.entry(target);
  if (entry && 'url' in entry.config && entry.config.url) {
    const httpConfig = entry.config as { url: string; oauth?: McpOAuthConfig };
    return {
      name: target,
      serverUrl: httpConfig.url,
      oauth: httpConfig.oauth,
    };
  }

  const resolved = resolveServerName(target);
  if (resolved.isUrl) {
    const url = target.startsWith('http') ? target : `https://${target}`;
    return { name: resolved.name, serverUrl: url, oauth: undefined };
  }

  throw new Error(`unknown target '${target}': not a URL and not found in mcp.json`);
}

function jerkMcpId(name: string): string {
  if (name.startsWith('mcp:')) return name;
  if (name.startsWith('url:')) return `mcp:${name}`;
  return `mcp:${name}`;
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.length;
  }
  return new TextDecoder().decode(buf);
}

async function jerkLogin(platform: Platform, target: string, args: string[]): Promise<number> {
  const resolved = await resolveLoginTarget(platform, target);
  const id = jerkMcpId(resolved.name);
  const argv = ['jerk', id, 'create'];
  const scopeIdx = args.indexOf('--scope');
  if (scopeIdx !== -1 && args[scopeIdx + 1]) {
    argv.push('--scope', args[scopeIdx + 1]);
  }
  if (args.includes('--no-browser')) {
    argv.push('--no-browser');
  }
  const proc = await platform.spawn({ argv });
  proc.stdin.close().catch(() => {});
  const [, errText, result] = await Promise.all([
    readStream(proc.stdout),
    readStream(proc.stderr),
    proc.wait(),
  ]);
  if (result.status === 0) {
    await platform.write(1, `Signed in to ${target}\n`);
    return 0;
  }
  if (errText.trim()) {
    await platform.write(2, errText);
  }
  if (result.status === JERK_EXIT_SIGN_IN) return 4;
  return result.status;
}

async function jerkLogout(
  platform: Platform,
  target: string,
  source: JerkTokenSource
): Promise<number> {
  const resolved = await resolveLoginTarget(platform, target);
  const id = jerkMcpId(resolved.name);
  const result = await runJerk(platform, ['jerk', id, 'drop', '--yes'], source.timeoutMs);
  if (result.status === 0) {
    await platform.write(1, `Signed out of ${target}\n`);
  } else {
    await platform.write(1, `No credentials stored for ${target}\n`);
  }
  return 0;
}

export async function runLogin(
  platform: Platform,
  args: string[],
  source: TokenSource
): Promise<number> {
  if (isKernel(platform)) {
    await platform.write(
      2,
      "mcpcat: login is not available in seven. Use the agent's MCP sign-in in Settings, or run mcpcat login on the host.\n"
    );
    return 4;
  }

  const positional = positionals(args);
  if (positional.length === 0) {
    await platform.write(2, 'mcpcat: login requires a target\n');
    return 2;
  }

  const target = positional[0];

  if (source instanceof JerkTokenSource) {
    try {
      return await jerkLogin(platform, target, args);
    } catch (err) {
      await platform.write(2, `mcpcat: login failed: ${(err as Error).message}\n`);
      return 4;
    }
  }

  const noBrowser = args.includes('--no-browser');
  let resolved;
  try {
    resolved = await resolveLoginTarget(platform, target);
  } catch (err) {
    await platform.write(2, `mcpcat: ${(err as Error).message}\n`);
    return 2;
  }

  try {
    await signIn({
      name: resolved.name,
      serverUrl: resolved.serverUrl,
      source,
      oauth: resolved.oauth,
      platform,
      prompt: {
        showAuthorizationUrl(url: URL) {
          if (!noBrowser && platform.openUrl) {
            platform.openUrl(url.href).catch(() => {});
          }
          void platform.write(2, `Open this URL to sign in:\n${url.href}\n`);
          if (noBrowser || !platform.openUrl) {
            void platform.write(2, '\nPaste the redirect URL from your browser address bar:\n');
          }
        },
        async promptForRedirectUrl(signal: AbortSignal): Promise<string | undefined> {
          if (!noBrowser && platform.openUrl) {
            return new Promise((_resolve, reject) => {
              signal.addEventListener('abort', () => reject(new SignInCancelledError()));
            });
          }
          const reader = platform.stdin.getReader();
          const chunks: Uint8Array[] = [];
          try {
            while (true) {
              const read = reader.read();
              const result = await Promise.race([
                read,
                new Promise<never>((_, reject) => {
                  signal.addEventListener('abort', () => reject(new SignInCancelledError()));
                }),
              ]);
              if (result.done) break;
              chunks.push(result.value);
              const text = new TextDecoder().decode(concatUint8Arrays(chunks));
              if (text.includes('\n')) return text.trim();
            }
          } finally {
            reader.releaseLock();
          }
          return new TextDecoder().decode(concatUint8Arrays(chunks)).trim() || undefined;
        },
      },
    });

    await platform.write(1, `Signed in to ${target}\n`);
    return 0;
  } catch (err) {
    if (err instanceof SignInCancelledError) {
      await platform.write(2, 'mcpcat: sign-in cancelled\n');
      return 1;
    }
    await platform.write(2, `mcpcat: login failed: ${(err as Error).message}\n`);
    return 4;
  }
}

export async function runLogout(
  platform: Platform,
  args: string[],
  source: TokenSource
): Promise<number> {
  if (isKernel(platform)) {
    await platform.write(2, 'mcpcat: logout is not available in seven.\n');
    return 4;
  }

  const positional = positionals(args);
  if (positional.length === 0) {
    await platform.write(2, 'mcpcat: logout requires a target\n');
    return 2;
  }

  const target = positional[0];

  if (source instanceof JerkTokenSource) {
    try {
      return await jerkLogout(platform, target, source);
    } catch (err) {
      if (err instanceof JerkTimeoutError) {
        await platform.write(2, `mcpcat: ${err.message}\n`);
        return 4;
      }
      await platform.write(2, `mcpcat: logout failed: ${(err as Error).message}\n`);
      return 1;
    }
  }

  let resolved;
  try {
    resolved = await resolveLoginTarget(platform, target);
  } catch (err) {
    await platform.write(2, `mcpcat: ${(err as Error).message}\n`);
    return 2;
  }

  const removed = await source.remove(resolved.name, resolved.serverUrl);
  if (removed) {
    await platform.write(1, `Signed out of ${target}\n`);
  } else {
    await platform.write(1, `No credentials stored for ${target}\n`);
  }
  return 0;
}

function concatUint8Arrays(arrays: Uint8Array[]): Uint8Array {
  const total = arrays.reduce((s, a) => s + a.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const a of arrays) {
    result.set(a, offset);
    offset += a.length;
  }
  return result;
}
