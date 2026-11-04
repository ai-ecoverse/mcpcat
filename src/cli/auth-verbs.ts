import { OAuthError } from '@earendil-works/pi-mcp/oauth';
import { withInjectedCallbackPortIfNeeded } from '../auth/callback-port.ts';
import {
  formatJerkVersion,
  JERK_EXIT_INVALID,
  JERK_EXIT_SIGN_IN,
  JERK_LOGIN_MIN_VERSION,
  JERK_TIMEOUT_MS,
  JerkTimeoutError,
  JerkTokenSource,
  jerkAvailable,
  jerkDetectedVersion,
  jerkHasUrlIds,
  jerkId,
  jerkKnows,
  jerkMeetsLoginMin,
  jerkMessage,
  noJerkEnv,
  runJerk,
} from '../auth/jerk-token-source.ts';
import { SignInCancelledError, signIn } from '../auth/oauth.ts';
import { PiFileTokenSource } from '../auth/pi-store.ts';
import { PiThenJerkTokenSource } from '../auth/pi-then-jerk.ts';
import type { TokenSource } from '../auth/token-source.ts';
import { isKernel } from '../auth/token-source.ts';
import { MergedConfigSource } from '../config/index.ts';
import type { McpOAuthConfig } from '../config/types.ts';
import type { Platform } from '../platform/types.ts';
import { sanitizeTerminal } from '../render/sanitize.ts';

export async function createTokenSource(
  platform: Platform,
  name: string,
  timeoutMs: number = JERK_TIMEOUT_MS
): Promise<TokenSource> {
  if (isKernel(platform) || !(await jerkAvailable(platform)) || noJerkEnv(platform)) {
    return new PiFileTokenSource(platform);
  }
  const viaJerk = name.startsWith('url:')
    ? await jerkHasUrlIds(platform)
    : await jerkKnows(platform, jerkId(name, ''));
  if (viaJerk) {
    return new PiThenJerkTokenSource(
      new PiFileTokenSource(platform),
      new JerkTokenSource(platform, timeoutMs)
    );
  }
  return new PiFileTokenSource(platform);
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

function withScheme(target: string): string {
  return /^https?:\/\//i.test(target) ? target : `https://${target}`;
}

function resolveServerName(target: string): { name: string; isUrl: boolean } {
  try {
    const u = new URL(withScheme(target));
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
  namedEntry: boolean;
}> {
  const config = await MergedConfigSource.load(platform);
  const entry = config.entry(target);
  if (entry && 'url' in entry.config && entry.config.url) {
    const httpConfig = entry.config as { url: string; oauth?: McpOAuthConfig };
    return {
      name: target,
      serverUrl: httpConfig.url,
      oauth: httpConfig.oauth,
      namedEntry: true,
    };
  }

  const resolved = resolveServerName(target);
  if (resolved.isUrl) {
    const url = withScheme(target);
    return { name: resolved.name, serverUrl: url, oauth: undefined, namedEntry: false };
  }

  throw new Error(`unknown target '${target}': not a URL and not found in mcp.json`);
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

type LoginTarget = Awaited<ReturnType<typeof resolveLoginTarget>>;

async function jerkLogin(
  platform: Platform,
  target: string,
  resolved: LoginTarget,
  args: string[]
): Promise<number> {
  const id = jerkId(resolved.name, resolved.serverUrl);
  const argv = ['jerk', id, 'create'];
  const scopeIdx = args.indexOf('--scope');
  if (scopeIdx !== -1 && args[scopeIdx + 1]) {
    argv.push('--scope', args[scopeIdx + 1]);
  }
  if (args.includes('--no-browser')) {
    argv.push('--no-browser');
  }
  return withInjectedCallbackPortIfNeeded(
    platform,
    resolved.name,
    { namedEntry: resolved.namedEntry, oauth: resolved.oauth },
    async (env) => {
      const proc = await platform.spawn({ argv, env });
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
        await platform.write(2, sanitizeTerminal(errText));
      }
      if (result.status === JERK_EXIT_SIGN_IN) return 4;
      return result.status;
    }
  );
}

async function jerkLogout(
  platform: Platform,
  target: string,
  resolved: LoginTarget,
  source: JerkTokenSource
): Promise<number> {
  const id = jerkId(resolved.name, resolved.serverUrl);
  const result = await runJerk(platform, ['jerk', id, 'drop', '--yes'], source.timeoutMs);
  if (result.status === JERK_EXIT_INVALID && resolved.name.startsWith('url:')) {
    await platform.write(2, sanitizeTerminal(`mcpcat: ${jerkMessage(result.stderr)}\n`));
    return 2;
  }
  if (result.status === 0) {
    await platform.write(1, `Signed out of ${target}\n`);
  } else {
    await platform.write(1, `No credentials stored for ${target}\n`);
  }
  return 0;
}

export function loginFailure(err: unknown): string {
  if (!(err instanceof OAuthError)) return (err as Error).message;
  const status = /^HTTP \d+/.exec(err.message)?.[0];
  if (status) return status;
  return /^[a-z0-9_]{1,64}$/.test(err.code) ? err.code : 'the token endpoint refused the sign-in';
}

async function loginPathNote(
  platform: Platform,
  verbose: boolean,
  path: 'jerk' | 'own',
  reason?: string,
  knownVersion?: number[] | undefined
): Promise<void> {
  if (verbose) {
    let ver = knownVersion;
    if (ver === undefined) ver = await jerkDetectedVersion(platform);
    const verText = ver ? formatJerkVersion(ver) : 'none';
    await platform.write(
      2,
      `mcpcat: login via ${path === 'jerk' ? 'jerk create' : 'own sign-in'} (jerk ${verText})\n`
    );
  }
  if (path === 'own' && reason) {
    await platform.write(2, `mcpcat: ${reason}\n`);
  }
}

function wantNoJerk(args: string[], platform: Platform): boolean {
  return args.includes('--no-jerk') || noJerkEnv(platform);
}

export async function runLogin(
  platform: Platform,
  args: string[],
  timeoutMs?: number,
  verbose = false
): Promise<number> {
  if (isKernel(platform)) {
    await platform.write(
      2,
      'mcpcat: login is not available in seven. Sign in under Settings › MCP servers.\n'
    );
    return 4;
  }

  const positional = positionals(args);
  if (positional.length === 0) {
    await platform.write(2, 'mcpcat: login requires a target\n');
    return 2;
  }

  const target = positional[0];
  let resolved: LoginTarget;
  try {
    resolved = await resolveLoginTarget(platform, target);
  } catch (err) {
    await platform.write(2, `mcpcat: ${(err as Error).message}\n`);
    return 2;
  }

  const skipJerk = wantNoJerk(args, platform);
  let useJerk = false;
  let ownReason: string | undefined;
  let knownVersion: number[] | undefined;
  if (skipJerk) {
    ownReason = args.includes('--no-jerk')
      ? 'skipping jerk (--no-jerk); using own sign-in'
      : 'skipping jerk (MCPCAT_NO_JERK); using own sign-in';
  } else if (await jerkAvailable(platform)) {
    knownVersion = await jerkDetectedVersion(platform);
    if (await jerkMeetsLoginMin(platform)) {
      const viaJerk = resolved.name.startsWith('url:')
        ? await jerkHasUrlIds(platform)
        : await jerkKnows(platform, jerkId(resolved.name, ''));
      useJerk = viaJerk;
    } else {
      const have = knownVersion ? formatJerkVersion(knownVersion) : 'unknown';
      const need = formatJerkVersion(JERK_LOGIN_MIN_VERSION);
      ownReason = `jerk ${have} is older than ${need}; using own sign-in (upgrade jerk; MCPCAT_NO_JERK=1 is a workaround, not required)`;
    }
  }

  if (useJerk) {
    await loginPathNote(platform, verbose, 'jerk', undefined, knownVersion);
    try {
      const code = await jerkLogin(platform, target, resolved, args);
      if (code === 0) {
        await new PiFileTokenSource(platform).remove(resolved.name, resolved.serverUrl);
      }
      return code;
    } catch (err) {
      await platform.write(2, `mcpcat: login failed: ${(err as Error).message}\n`);
      return 4;
    }
  }

  await loginPathNote(platform, verbose, 'own', ownReason, knownVersion);

  const source = new PiFileTokenSource(platform);
  await source.ensureWritable();

  const noBrowser = args.includes('--no-browser');

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
    await platform.write(2, sanitizeTerminal(`mcpcat: login failed: ${loginFailure(err)}\n`));
    return 4;
  }
}

export async function runLogout(
  platform: Platform,
  args: string[],
  timeoutMs?: number
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
  let resolved: LoginTarget;
  try {
    resolved = await resolveLoginTarget(platform, target);
  } catch (err) {
    await platform.write(2, `mcpcat: ${(err as Error).message}\n`);
    return 2;
  }
  const source = await createTokenSource(platform, resolved.name, timeoutMs);

  if (source instanceof JerkTokenSource) {
    try {
      return await jerkLogout(platform, target, resolved, source);
    } catch (err) {
      if (err instanceof JerkTimeoutError) {
        await platform.write(2, `mcpcat: ${err.message}\n`);
        return 4;
      }
      await platform.write(2, `mcpcat: logout failed: ${(err as Error).message}\n`);
      return 1;
    }
  }

  if (source instanceof PiThenJerkTokenSource) {
    try {
      return await piThenJerkLogout(platform, target, resolved, source);
    } catch (err) {
      if (err instanceof JerkTimeoutError) {
        await platform.write(2, `mcpcat: ${err.message}\n`);
        return 4;
      }
      await platform.write(2, `mcpcat: logout failed: ${(err as Error).message}\n`);
      return 1;
    }
  }

  const removed = await source.remove(resolved.name, resolved.serverUrl);
  if (removed) {
    await platform.write(1, `Signed out of ${target}\n`);
  } else {
    await platform.write(1, `No credentials stored for ${target}\n`);
  }
  return 0;
}

async function piThenJerkLogout(
  platform: Platform,
  target: string,
  resolved: LoginTarget,
  source: PiThenJerkTokenSource
): Promise<number> {
  const piRemoved = await source.pi.remove(resolved.name, resolved.serverUrl).catch(() => false);
  const id = jerkId(resolved.name, resolved.serverUrl);
  let jerkRemoved = false;
  try {
    const result = await runJerk(platform, ['jerk', id, 'drop', '--yes'], source.jerk.timeoutMs);
    if (result.status === JERK_EXIT_INVALID && resolved.name.startsWith('url:')) {
      await platform.write(2, sanitizeTerminal(`mcpcat: ${jerkMessage(result.stderr)}\n`));
      return 2;
    }
    jerkRemoved = result.status === 0;
  } catch (err) {
    if (!piRemoved) throw err;
  }
  if (jerkRemoved || piRemoved) {
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
