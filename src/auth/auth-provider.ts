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

  constructor(source: TokenSource, name: string, serverUrl: string) {
    this.source = source;
    this.name = name;
    this.serverUrl = serverUrl;
  }

  async load(): Promise<McpOAuthState | undefined> {
    return this.source.load(this.name, this.serverUrl);
  }

  async save(state: McpOAuthState): Promise<void> {
    await this.source.save(this.name, this.serverUrl, state);
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
  constructor(scope: string | undefined) {
    super(scope ? `insufficient_scope: ${scope}` : 'insufficient_scope');
    this.name = 'AuthStepUpError';
    this.scope = scope;
  }
}

export function createMcpAuthProvider(options: {
  name: string;
  serverUrl: string;
  source: TokenSource;
  oauth: McpOAuthConfig | undefined;
  platform: Platform;
}): AuthProvider {
  const { name, serverUrl, source, oauth, platform } = options;
  const store = new SourceBackedStore(source, name, serverUrl);
  let refreshing: Promise<void> | undefined;

  const refresh = async (staleToken: string | undefined) => {
    refreshing ??= (async () => {
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
    })().finally(() => {
      refreshing = undefined;
    });
    return refreshing;
  };

  return {
    async token(): Promise<string | undefined> {
      await refreshing?.catch(() => undefined);
      const state = await store.load();
      const token = state?.tokens?.access_token;
      const expired =
        state?.tokensExpireAt !== undefined && state.tokensExpireAt - REFRESH_SKEW_MS <= Date.now();
      if (!expired || !state?.tokens?.refresh_token) return token;
      await refresh(token).catch(() => undefined);
      return (await store.load())?.tokens?.access_token;
    },
    async onUnauthorized(context: UnauthorizedContext): Promise<void> {
      const challenge = parseWwwAuthenticate(context.response.headers.get('www-authenticate'));
      if (challenge.error === 'insufficient_scope') {
        throw new AuthStepUpError(challenge.scope);
      }
      await refresh(context.token);
    },
  };
}
