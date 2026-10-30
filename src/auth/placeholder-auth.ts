import type { AuthProvider, UnauthorizedContext } from '@earendil-works/pi-mcp';
import { authError, EXIT_AUTH, McpcatError } from '../cli/exit-codes.ts';
import type { Platform } from '../platform/types.ts';
import {
  canonicalJerkUrl,
  JERK_TIMEOUT_MS,
  jerkAvailable,
  jerkEnv,
  jerkHasUrlIds,
  jerkId,
  jerkKnows,
  runJerk,
} from './jerk-token-source.ts';
import { isKernel } from './token-source.ts';

const PLACEHOLDER = /^fnox_proxy_[0-9a-f]{24}$/;

const SETTINGS_SIGN_IN = 'Sign in under Settings › MCP servers.';
const NO_PLACEHOLDER = `jerk gave this user no placeholder. With no sign-in yet: ${SETTINGS_SIGN_IN} After a sign-in, the agent already has this server's tools, because a Settings sign-in gives it the server as native tools, and a human can use the server from a panel terminal as root.`;

export class SettingsSignInError extends McpcatError {
  readonly advice: string;
  constructor(status: number, advice = SETTINGS_SIGN_IN) {
    super(EXIT_AUTH, `HTTP ${status}: authentication required. ${advice}`);
    this.name = 'SettingsSignInError';
    this.advice = advice;
  }
}

async function jerkIdFor(
  platform: Platform,
  name: string | undefined,
  url: string
): Promise<string | undefined> {
  if (!(await jerkAvailable(platform))) return undefined;
  if (name === undefined) {
    if (!canonicalJerkUrl(url) || !(await jerkHasUrlIds(platform))) return undefined;
    return jerkId('url:', url);
  }
  const id = jerkId(name, url);
  return (await jerkKnows(platform, id)) ? id : undefined;
}

async function placeholderFrom(
  platform: Platform,
  id: string,
  timeoutMs: number
): Promise<string | undefined> {
  const result = await runJerk(platform, ['jerk', id, 'get'], timeoutMs, jerkEnv(platform));
  if (result.status !== 0) return undefined;
  const placeholder = result.stdout.trim();
  if (!PLACEHOLDER.test(placeholder)) {
    throw authError(`jerk ${id} get did not give a placeholder; refusing to send it`);
  }
  return placeholder;
}

export async function placeholderAuthProvider<Inner extends AuthProvider | undefined>(options: {
  platform: Platform;
  name: string | undefined;
  url: string | undefined;
  headers?: Record<string, string>;
  timeoutMs?: number;
  inner?: Inner;
  onCredentialObtained?: (secret: string) => void;
}): Promise<AuthProvider | Inner> {
  const { platform, name, url, headers, inner, onCredentialObtained } = options;
  const fallback = inner as Inner;
  if (!isKernel(platform) || !url) return fallback;
  if (Object.keys(headers ?? {}).some((k) => k.toLowerCase() === 'authorization')) return fallback;
  const id = await jerkIdFor(platform, name, url);
  const timeoutMs = options.timeoutMs ?? JERK_TIMEOUT_MS;
  let noPlaceholder = false;
  return {
    async token(): Promise<string | undefined> {
      const placeholder = id && (await placeholderFrom(platform, id, timeoutMs));
      noPlaceholder = !placeholder;
      if (!placeholder) return inner?.token();
      onCredentialObtained?.(placeholder);
      return placeholder;
    },
    async onUnauthorized(context: UnauthorizedContext): Promise<void> {
      if (context.response.status === 401 && noPlaceholder && !context.token) {
        throw new SettingsSignInError(
          context.response.status,
          platform.uid ? NO_PLACEHOLDER : SETTINGS_SIGN_IN
        );
      }
      if (!inner?.onUnauthorized || (context.token && PLACEHOLDER.test(context.token))) {
        throw new SettingsSignInError(context.response.status);
      }
      await inner.onUnauthorized(context);
    },
  };
}
