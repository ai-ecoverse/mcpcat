import type { AuthProvider, UnauthorizedContext } from '@earendil-works/pi-mcp';
import { parseWwwAuthenticate } from '@earendil-works/pi-mcp/oauth';
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
const OLD_VAULT = /^(unknown op$|name must match)/;

export const SETTINGS_SIGN_IN = 'Sign in under Settings › MCP servers.';
const HEADER_REJECTED = 'The server rejected the explicit Authorization header.';
const PLACEHOLDER_NOT_ACCEPTED =
  "The request carried the signed-in credential's placeholder and the server still answered 401. Seven's vault fills the placeholder in when the request is forwarded, so either that forwarding is not active in this seven yet or the server rejected the credential. Try again from the Settings page's Connect, or ask whoever runs seven.";
const VAULT_NO_ANSWER =
  "Seven's vault did not answer, so the request carried no credential. Try again, or ask whoever runs seven.";
const NO_PLACEHOLDER = `This user gets no placeholder for this server. With no sign-in yet: ${SETTINGS_SIGN_IN} After a sign-in, the agent already has this server's tools, because a Settings sign-in gives it the server as native tools, and a human can use the server from a panel terminal as root.`;

export class SettingsSignInError extends McpcatError {
  readonly advice: string;
  constructor(status: number, advice = SETTINGS_SIGN_IN) {
    super(EXIT_AUTH, `HTTP ${status}: authentication required. ${advice}`);
    this.name = 'SettingsSignInError';
    this.advice = advice;
  }
}

export class AuthStepUpError extends Error {
  readonly scope: string | undefined;
  readonly target: string | undefined;
  readonly report: string;
  constructor(scope: string | undefined, target?: string, kernel = false) {
    super(scope ? `insufficient_scope: ${scope}` : 'insufficient_scope');
    this.name = 'AuthStepUpError';
    this.scope = scope;
    this.target = target;
    this.report = kernel
      ? `insufficient scope${scope ? ` (required: ${scope})` : ''}. ${SETTINGS_SIGN_IN}`
      : `insufficient scope. Run: mcpcat login ${target ?? '<target>'}${scope ? ` --scope ${scope}` : ''}`;
  }
}

function hasAuthorization(headers: Record<string, string> | undefined): boolean {
  return Object.keys(headers ?? {}).some((k) => k.toLowerCase() === 'authorization');
}

export function kernelAuthAdvice(
  platform: Platform,
  headers: Record<string, string> | undefined
): string | undefined {
  if (!isKernel(platform)) return undefined;
  return hasAuthorization(headers) ? HEADER_REJECTED : SETTINGS_SIGN_IN;
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

interface VaultReply {
  placeholder?: unknown;
  kind?: unknown;
  error?: { code?: unknown; message?: unknown };
}

interface VaultAnswer {
  placeholder?: string;
  unavailable?: boolean;
  noAnswer?: boolean;
}

async function askVault(platform: Platform, server: string): Promise<VaultReply | undefined> {
  if (!platform.seal) return undefined;
  let text: string;
  try {
    text = await platform.seal(JSON.stringify({ v: 1, op: 'placeholder', server }));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTCONN' ? undefined : { error: { code } };
  }
  try {
    return JSON.parse(text) as VaultReply;
  } catch {
    return {};
  }
}

async function vaultPlaceholder(platform: Platform, server: string): Promise<VaultAnswer> {
  const reply = await askVault(platform, server);
  if (reply === undefined) return { unavailable: true };
  const error = reply?.error;
  if (error) {
    const message = String(error.message);
    if (error.code === 'ENOTCONN') return { unavailable: true };
    if (error.code === 'ENOENT') return {};
    if (error.code !== 'EINVAL') return { noAnswer: true };
    if (OLD_VAULT.test(message)) return { unavailable: true };
    throw authError(
      message.startsWith('several ')
        ? `seven's vault holds several sign-ins for ${server}, so mcpcat can't tell which to use. Keep one under Settings › MCP servers.`
        : `seven's vault refused the placeholder request for ${server}`
    );
  }
  const placeholder = reply?.placeholder;
  if (reply?.kind !== 'mcp' || typeof placeholder !== 'string' || !PLACEHOLDER.test(placeholder)) {
    throw authError(`seven's vault did not give a placeholder for ${server}; refusing to send it`);
  }
  return { placeholder };
}

export async function placeholderAuthProvider<Inner extends AuthProvider | undefined>(options: {
  platform: Platform;
  name: string | undefined;
  url: string | undefined;
  headers?: Record<string, string>;
  timeoutMs?: number;
  inner?: Inner;
  onCredentialObtained?: (secret: string) => void;
}): Promise<AuthProvider | Inner | undefined> {
  const { platform, name, url, headers, inner, onCredentialObtained } = options;
  const fallback = inner as Inner;
  if (!isKernel(platform) || !url) return fallback;
  if (hasAuthorization(headers)) return undefined;
  const server = platform.uid === 0 ? name : undefined;
  const id = server === undefined ? await jerkIdFor(platform, name, url) : undefined;
  const timeoutMs = options.timeoutMs ?? JERK_TIMEOUT_MS;
  const hidden =
    Boolean(platform.uid) &&
    (id !== undefined || (name !== undefined && !(await jerkAvailable(platform))));
  let noPlaceholder = false;
  let vaultSilent = false;
  const obtain = async (): Promise<string | undefined> => {
    if (server === undefined) return id && placeholderFrom(platform, id, timeoutMs);
    const answer = await vaultPlaceholder(platform, server);
    vaultSilent = answer.noAnswer === true;
    if (!answer.unavailable) return answer.placeholder;
    const fallbackId = await jerkIdFor(platform, name, url);
    return fallbackId && placeholderFrom(platform, fallbackId, timeoutMs);
  };
  return {
    async token(): Promise<string | undefined> {
      const placeholder = await obtain();
      noPlaceholder = !placeholder;
      if (!placeholder) {
        const held = await inner?.token();
        return held !== undefined && PLACEHOLDER.test(held) ? held : undefined;
      }
      onCredentialObtained?.(placeholder);
      return placeholder;
    },
    async onUnauthorized(context: UnauthorizedContext): Promise<void> {
      const { status, headers: replyHeaders } = context.response;
      const placeholderSent = context.token !== undefined && PLACEHOLDER.test(context.token);
      if (status === 401 && placeholderSent) {
        throw new SettingsSignInError(status, PLACEHOLDER_NOT_ACCEPTED);
      }
      if (status === 401 && noPlaceholder) {
        const advice = hidden ? NO_PLACEHOLDER : SETTINGS_SIGN_IN;
        throw new SettingsSignInError(status, vaultSilent ? VAULT_NO_ANSWER : advice);
      }
      const challenge = parseWwwAuthenticate(replyHeaders.get('www-authenticate'));
      if (inner && !placeholderSent && challenge.error === 'insufficient_scope') {
        throw new AuthStepUpError(challenge.scope, name, true);
      }
      throw new SettingsSignInError(status);
    },
  };
}
