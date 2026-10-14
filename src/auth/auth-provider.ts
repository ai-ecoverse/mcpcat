import type { AuthProvider, UnauthorizedContext } from '@earendil-works/pi-mcp';
import {
  authorizeMcp,
  McpOAuthAuthorizationRequiredError,
  McpOAuthProvider,
  type McpOAuthState,
  type McpOAuthStateStore,
  type OAuthClientMetadataDocument,
  parseWwwAuthenticate,
} from '@earendil-works/pi-mcp/oauth';
import type { McpOAuthConfig } from '../config/types.ts';
import type { Platform } from '../platform/types.ts';
import { JerkSignInRequiredError, JerkTokenSource } from './jerk-token-source.ts';
import { PiFileTokenSource } from './pi-store.ts';
import type { TokenSource } from './token-source.ts';

const CIMD_URL = 'https://mcpcat.sliccy.ai/oauth/client.json';
const CLIENT_NAME = 'mcpcat';
const CALLBACK_HOST = '127.0.0.1';
const CALLBACK_PATH = '/callback';
const REQUEST_TIMEOUT_MS = 15_000;
const REFRESH_SKEW_MS = 30_000;
const FALLBACK_REDIRECT_URL = `http://${CALLBACK_HOST}${CALLBACK_PATH}`;

function timedFetch(fetchImpl: typeof globalThis.fetch): typeof globalThis.fetch {
  return (input, init) => {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    return fetchImpl(input as string | URL, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
    });
  };
}

class SourceBackedStore implements McpOAuthStateStore {
  private readonly source: TokenSource;
  private readonly name: string;
  private readonly serverUrl: string;
  private readonly platform: Platform;

  constructor(source: TokenSource, name: string, serverUrl: string, platform: Platform) {
    this.source = source;
    this.name = name;
    this.serverUrl = serverUrl;
    this.platform = platform;
  }

  async load(): Promise<McpOAuthState | undefined> {
    return this.source.load(this.name, this.serverUrl);
  }

  async save(state: McpOAuthState): Promise<void> {
    await this.source.save(this.name, this.serverUrl, state);
  }

  async withRefreshLock<T>(fn: () => Promise<T>): Promise<T> {
    if (!(this.source instanceof PiFileTokenSource)) return fn();
    const refreshPath = `${this.source.path}.refresh`;
    const { acquireLock } = await import('../config/lock.ts');
    const release = await acquireLock(this.platform.fs, refreshPath);
    try {
      return await fn();
    } finally {
      await release();
    }
  }
}

function cimdFn(redirectUrl: string): (
  metadata:
    | {
        client_id_metadata_document_supported?: boolean;
        token_endpoint_auth_methods_supported?: string[];
        authorization_response_iss_parameter_supported?: boolean;
      }
    | undefined
) => OAuthClientMetadataDocument | undefined {
  return (metadata) => {
    if (!metadata?.client_id_metadata_document_supported) return undefined;
    if (!metadata.token_endpoint_auth_methods_supported?.includes('none')) return undefined;
    if (!metadata.authorization_response_iss_parameter_supported) return undefined;
    return { url: CIMD_URL, redirectUrl };
  };
}

export class AuthStepUpError extends Error {
  readonly scope: string | undefined;
  readonly target: string | undefined;
  constructor(scope: string | undefined, target?: string) {
    super(scope ? `insufficient_scope: ${scope}` : 'insufficient_scope');
    this.name = 'AuthStepUpError';
    this.scope = scope;
    this.target = target;
  }
}

export function createMcpAuthProvider(options: {
  name: string;
  serverUrl: string;
  source: TokenSource;
  oauth: McpOAuthConfig | undefined;
  platform: Platform;
  onCredentialObtained?: (secret: string) => void;
}): AuthProvider {
  if (options.source instanceof JerkTokenSource) {
    return createJerkAuthProvider({ ...options, source: options.source });
  }
  return createPiAuthProvider(options);
}

function createJerkAuthProvider(options: {
  name: string;
  serverUrl: string;
  source: JerkTokenSource;
  oauth: McpOAuthConfig | undefined;
  platform: Platform;
  onCredentialObtained?: (secret: string) => void;
}): AuthProvider {
  const { name, serverUrl, source } = options;
  let currentToken: string | undefined;

  function registerCredential(token: string | undefined): void {
    if (token && options.onCredentialObtained) options.onCredentialObtained(token);
  }

  return {
    async token(): Promise<string | undefined> {
      return currentToken;
    },
    async onUnauthorized(context: UnauthorizedContext): Promise<void> {
      const challenge = parseWwwAuthenticate(context.response.headers.get('www-authenticate'));
      if (challenge.error === 'insufficient_scope') {
        try {
          const result = await source.getToken(name, serverUrl, challenge.scope);
          if (result) {
            currentToken = result.accessToken;
            registerCredential(currentToken);
            return;
          }
        } catch (err) {
          if (err instanceof JerkSignInRequiredError) {
            throw new AuthStepUpError(challenge.scope, options.name);
          }
          throw err;
        }
        throw new AuthStepUpError(challenge.scope, options.name);
      }
      const result = await source.getToken(name, serverUrl);
      if (result) {
        currentToken = result.accessToken;
        registerCredential(currentToken);
        return;
      }
      throw new McpOAuthAuthorizationRequiredError();
    },
  };
}

function createPiAuthProvider(options: {
  name: string;
  serverUrl: string;
  source: TokenSource;
  oauth: McpOAuthConfig | undefined;
  platform: Platform;
  onCredentialObtained?: (secret: string) => void;
}): AuthProvider {
  const { name, serverUrl, source, oauth, platform } = options;
  const store = new SourceBackedStore(source, name, serverUrl, platform);
  let refreshing: Promise<void> | undefined;

  function registerCredential(token: string | undefined): void {
    if (token && options.onCredentialObtained) options.onCredentialObtained(token);
  }

  const refresh = async (staleToken: string | undefined) => {
    refreshing ??= store
      .withRefreshLock(async () => {
        const state = await store.load();
        if (state?.tokens?.access_token !== staleToken) return;
        if (!state?.tokens?.refresh_token) throw new McpOAuthAuthorizationRequiredError();
        const registered =
          state.clientInformation && 'redirect_uris' in state.clientInformation
            ? state.clientInformation.redirect_uris
            : [];
        const redirectUrl = registered[0] ?? FALLBACK_REDIRECT_URL;
        const provider = new McpOAuthProvider({
          serverUrl,
          redirectUrl,
          clientMetadata: { client_name: oauth?.clientName ?? CLIENT_NAME },
          clientMetadataDocument: oauth?.clientId ? undefined : cimdFn(redirectUrl),
          clientId: oauth?.clientId,
          clientSecret: oauth?.clientSecret,
          store,
          onRedirect() {},
        });
        const result = await authorizeMcp(provider, {
          serverUrl,
          authorizationServerMetadataUrl: oauth?.authServerMetadataUrl
            ? new URL(oauth.authServerMetadataUrl)
            : undefined,
          fetch: timedFetch(platform.fetch),
        });
        if (result === 'REDIRECT') throw new McpOAuthAuthorizationRequiredError();
      })
      .finally(() => {
        refreshing = undefined;
      });
    return refreshing;
  };

  let cachedToken: string | undefined;
  let tokenLoaded = false;

  return {
    async token(): Promise<string | undefined> {
      await refreshing?.catch(() => undefined);
      if (tokenLoaded) return cachedToken;
      const state = await store.load();
      cachedToken = state?.tokens?.access_token;
      registerCredential(cachedToken);
      if (state?.tokens?.refresh_token) registerCredential(state.tokens.refresh_token);
      const expired =
        state?.tokensExpireAt !== undefined && state.tokensExpireAt - REFRESH_SKEW_MS <= Date.now();
      if (expired && state?.tokens?.refresh_token) {
        await refresh(cachedToken).catch(() => undefined);
        const refreshedState = await store.load();
        cachedToken = refreshedState?.tokens?.access_token;
        registerCredential(cachedToken);
        if (refreshedState?.tokens?.refresh_token)
          registerCredential(refreshedState.tokens.refresh_token);
      }
      tokenLoaded = true;
      return cachedToken;
    },
    async onUnauthorized(context: UnauthorizedContext): Promise<void> {
      const challenge = parseWwwAuthenticate(context.response.headers.get('www-authenticate'));
      if (challenge.error === 'insufficient_scope') {
        throw new AuthStepUpError(challenge.scope, options.name);
      }
      await refresh(context.token);
      const state = await store.load();
      cachedToken = state?.tokens?.access_token;
      tokenLoaded = true;
      registerCredential(cachedToken);
      if (state?.tokens?.refresh_token) registerCredential(state.tokens.refresh_token);
    },
  };
}
