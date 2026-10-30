import type { McpFetch } from '@earendil-works/pi-mcp';
import {
  type AuthorizationServerMetadata,
  authorizeMcp,
  McpOAuthAuthorizationRequiredError,
  McpOAuthProvider,
  type McpOAuthState,
  type McpOAuthStateStore,
  type OAuthCallback,
  OAuthCallbackServer,
  type OAuthClientMetadataDocument,
  stepUpScope,
} from '@earendil-works/pi-mcp/oauth';
import type { McpOAuthConfig } from '../config/types.ts';
import type { Platform } from '../platform/types.ts';
import type { OAuthStateAccess } from './token-source.ts';

const CALLBACK_HOST = '127.0.0.1';
const CALLBACK_PATH = '/callback';
const CIMD_URL = 'https://mcpcat.sliccy.ai/oauth/client.json';
const CLIENT_NAME = 'mcpcat';
const REQUEST_TIMEOUT_MS = 15_000;
const _REFRESH_SKEW_MS = 30_000;
const EPHEMERAL_PORTS = 16_384;
const EPHEMERAL_BASE = 49_152;

function timedFetch(fetchImpl: typeof globalThis.fetch): McpFetch {
  return (input, init) => {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    return fetchImpl(input, {
      ...init,
      signal: init?.signal ? AbortSignal.any([init.signal, timeout]) : timeout,
    });
  };
}

function callbackSettings(oauth: McpOAuthConfig | undefined): {
  host: string;
  redirectHost: string;
  port: number | undefined;
  path: string;
  fixedRedirectUrl: string | undefined;
} {
  const raw = oauth?.callbackUrl ?? `http://${CALLBACK_HOST}${CALLBACK_PATH}`;
  const url = new URL(raw);
  const address = url.hostname.replace(/^\[|\]$/g, '');
  const port = url.port ? Number(url.port) : oauth?.callbackPort;
  let fixedRedirectUrl: string | undefined;
  if (url.port) fixedRedirectUrl = oauth?.callbackUrl;
  else if (port !== undefined) {
    url.port = String(port);
    fixedRedirectUrl = url.href;
  }
  return {
    host: address === 'localhost' ? CALLBACK_HOST : address,
    redirectHost: address,
    port,
    path: url.pathname,
    fixedRedirectUrl,
  };
}

function unboundRedirectUrl(): string {
  const [random] = crypto.getRandomValues(new Uint16Array(1));
  const port = EPHEMERAL_BASE + ((random as number) % EPHEMERAL_PORTS);
  return `http://${CALLBACK_HOST}:${port}${CALLBACK_PATH}`;
}

function cimdForServer(
  metadata: AuthorizationServerMetadata | undefined,
  redirectUrl: string
): OAuthClientMetadataDocument | undefined {
  if (!metadata?.client_id_metadata_document_supported) return undefined;
  if (!metadata.token_endpoint_auth_methods_supported?.includes('none')) return undefined;
  if (!metadata.authorization_response_iss_parameter_supported) return undefined;
  return {
    url: CIMD_URL,
    redirectUrl,
  };
}

function buildClientMetadataDocumentFn(
  oauth: McpOAuthConfig | undefined,
  redirectUrl: string
):
  | ((metadata: AuthorizationServerMetadata | undefined) => OAuthClientMetadataDocument | undefined)
  | undefined {
  if (oauth?.clientRegistration === 'dcr') return undefined;
  if (oauth?.clientId) return undefined;
  return (metadata) => {
    if (oauth?.clientRegistration === 'cimd') {
      if (
        !metadata?.client_id_metadata_document_supported ||
        !metadata.token_endpoint_auth_methods_supported?.includes('none')
      ) {
        return undefined;
      }
      if (!metadata.authorization_response_iss_parameter_supported) return undefined;
      return { url: CIMD_URL, redirectUrl };
    }
    return cimdForServer(metadata, redirectUrl);
  };
}

function createProvider(
  serverUrl: string,
  store: McpOAuthStateStore,
  oauth: McpOAuthConfig | undefined,
  redirectUrl: string,
  onRedirect: (url: URL) => void
): McpOAuthProvider {
  const cimdFn = buildClientMetadataDocumentFn(oauth, redirectUrl);
  return new McpOAuthProvider({
    serverUrl,
    redirectUrl,
    clientMetadata: { client_name: oauth?.clientName ?? CLIENT_NAME },
    clientMetadataDocument: cimdFn,
    clientId: oauth?.clientId,
    clientSecret: oauth?.clientSecret,
    store,
    onRedirect,
  });
}

type SignInStore = Pick<OAuthStateAccess, 'load' | 'save'>;

class SourceBackedStateStore implements McpOAuthStateStore {
  private readonly source: SignInStore;
  private readonly name: string;
  private readonly serverUrl: string;

  constructor(source: SignInStore, name: string, serverUrl: string) {
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

export interface SignInPrompt {
  showAuthorizationUrl(url: URL): void;
  promptForRedirectUrl(signal: AbortSignal): Promise<string | undefined>;
}

export class SignInCancelledError extends Error {
  constructor() {
    super('Sign-in cancelled');
    this.name = 'SignInCancelledError';
  }
}

function responseFromRedirectUrl(
  input: string,
  state: string,
  redirectUrl: URL
): Pick<OAuthCallback, 'code' | 'iss'> {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error('Expected the full redirect URL from the browser address bar');
  }
  if (url.origin !== redirectUrl.origin || url.pathname !== redirectUrl.pathname) {
    throw new Error("The redirect URL does not match this sign-in's redirect URI");
  }
  const error = url.searchParams.get('error');
  if (error) throw new Error(url.searchParams.get('error_description') ?? error);
  if (url.searchParams.get('state') !== state) {
    throw new Error('The redirect URL belongs to a different sign-in');
  }
  const code = url.searchParams.get('code');
  if (!code) throw new Error('The redirect URL does not contain an authorization code');
  return { code, iss: url.searchParams.get('iss') ?? undefined };
}

async function waitForAuthorizationResponse(
  callback: OAuthCallbackServer | undefined,
  state: string,
  redirectUrl: URL,
  prompt: SignInPrompt,
  signal: AbortSignal | undefined
): Promise<Pick<OAuthCallback, 'code' | 'iss'>> {
  const controller = new AbortController();
  const promptSignal = signal ? AbortSignal.any([controller.signal, signal]) : controller.signal;
  const fromBrowser = callback?.waitForCallback(state, redirectUrl.pathname);
  const fromUser = prompt.promptForRedirectUrl(promptSignal).then((input) => {
    if (!input?.trim()) throw new SignInCancelledError();
    return responseFromRedirectUrl(input, state, redirectUrl);
  });
  try {
    return await Promise.race(fromBrowser ? [fromBrowser, fromUser] : [fromUser]);
  } finally {
    controller.abort();
    fromBrowser?.catch(() => undefined);
    fromUser.catch(() => undefined);
  }
}

function mergeScopes(...scopes: (string | undefined)[]): string | undefined {
  const merged = [...new Set(scopes.flatMap((s) => s?.split(/\s+/).filter(Boolean) ?? []))];
  return merged.length > 0 ? merged.join(' ') : undefined;
}

export async function signIn(options: {
  name: string;
  serverUrl: string;
  source: SignInStore;
  oauth: McpOAuthConfig | undefined;
  prompt: SignInPrompt;
  platform: Platform;
  scope?: string;
  stepUp?: boolean;
  listen?: boolean;
  signal?: AbortSignal;
}): Promise<void> {
  const { name, serverUrl, source, oauth, prompt, platform, signal } = options;
  if (signal?.aborted) throw new SignInCancelledError();

  const store = new SourceBackedStateStore(source, name, serverUrl);
  const stored = await store.load();
  const cbSettings = callbackSettings(oauth);
  const registered =
    stored?.clientInformation && 'redirect_uris' in stored.clientInformation
      ? stored.clientInformation.redirect_uris
      : [];
  const preferredPort =
    cbSettings.port ??
    (registered[0] ? Number(new URL(registered[0]).port) || undefined : undefined);

  const callback =
    options.listen === false
      ? undefined
      : await OAuthCallbackServer.listen({
          host: cbSettings.host,
          redirectHost: cbSettings.redirectHost,
          port: preferredPort ?? 0,
          path: cbSettings.path,
        });
  const redirectUrl =
    cbSettings.fixedRedirectUrl ??
    callback?.redirectUrl ??
    oauth?.callbackUrl ??
    unboundRedirectUrl();

  try {
    if (stored) {
      const next: McpOAuthState = { ...stored };
      delete next.oauthState;
      const hasCimd = buildClientMetadataDocumentFn(oauth, redirectUrl) !== undefined;
      const keepClient =
        oauth?.clientId || (hasCimd ? !stored.clientInformation : registered.includes(redirectUrl));
      if (!keepClient) {
        delete next.clientInformation;
        delete next.tokens;
        delete next.tokensExpireAt;
      }
      await store.save(next);
    }

    let authorizationUrl: URL | undefined;
    const provider = createProvider(serverUrl, store, oauth, redirectUrl, (url) => {
      authorizationUrl = url;
    });

    const flow = {
      serverUrl,
      fetch: timedFetch(platform.fetch),
      signal,
      authorizationServerMetadataUrl: oauth?.authServerMetadataUrl
        ? new URL(oauth.authServerMetadataUrl)
        : undefined,
      scope: mergeScopes(
        oauth?.scope,
        options.stepUp ? stepUpScope(stored?.tokens?.scope, options.scope) : options.scope
      ),
    };

    const skipRefresh = options.stepUp === true;
    if ((await authorizeMcp(provider, { ...flow, skipRefresh })) === 'AUTHORIZED') return;
    if (!authorizationUrl) throw new Error('OAuth flow did not produce an authorization URL');

    const state = await provider.state();
    const authRedirectUrl = new URL(
      authorizationUrl.searchParams.get('redirect_uri') ?? redirectUrl
    );
    prompt.showAuthorizationUrl(authorizationUrl);
    const { code, iss } = await waitForAuthorizationResponse(
      callback,
      state,
      authRedirectUrl,
      prompt,
      signal
    );
    await authorizeMcp(provider, { ...flow, authorizationCode: code, iss });
  } catch (err) {
    if (signal?.aborted) throw new SignInCancelledError();
    throw err;
  } finally {
    await callback?.close();
  }
}

export function createMcpAuthHeaders(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

export { McpOAuthAuthorizationRequiredError };
