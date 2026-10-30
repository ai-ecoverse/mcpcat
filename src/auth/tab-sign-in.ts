import { discoverOAuthServerInfo, type McpOAuthState } from '@earendil-works/pi-mcp/oauth';
import type { McpOAuthConfig } from '../config/types.ts';
import type { Platform } from '../platform/types.ts';
import { listTabs, runProcess } from '../serve/webmcp.ts';
import type { JerkGrant } from './jerk-token-source.ts';
import { SignInCancelledError, type SignInPrompt } from './oauth.ts';

const PLAYWRIGHT_CLI = 'playwright-cli';
const COMMAND_TIMEOUT_MS = 15_000;
const OUTPUT_LIMIT = 65_536;
const POLL_MS = 500;
const SIGN_IN_TIMEOUT_MS = 300_000;
const MAX_LIST_FAILURES = 5;

export class HeldState {
  state: McpOAuthState | undefined;

  async load(): Promise<McpOAuthState | undefined> {
    return this.state;
  }

  async save(_name: string, _serverUrl: string, state: McpOAuthState): Promise<void> {
    this.state = state;
  }
}

function tabCommand(platform: Platform, cdp: string, args: string[]) {
  const argv = [PLAYWRIGHT_CLI, ...args, '--cdp', cdp];
  return runProcess(platform, argv, undefined, COMMAND_TIMEOUT_MS, OUTPUT_LIMIT);
}

async function openTab(platform: Platform, cdp: string): Promise<string | undefined> {
  const opened = await tabCommand(platform, cdp, ['open', 'about:blank', '--foreground']).catch(
    () => undefined
  );
  if (opened?.exitCode !== 0) return undefined;
  return /\[targetId: ([^\]\s]+)\]/.exec(opened.stdout)?.[1];
}

function atRedirect(url: string, redirect: URL): boolean {
  const seen = URL.parse(url);
  return seen?.origin === redirect.origin && seen.pathname === redirect.pathname;
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function watchTab(
  platform: Platform,
  cdp: string,
  tab: string,
  redirect: URL,
  signal: AbortSignal
): Promise<string> {
  const deadline = Date.now() + SIGN_IN_TIMEOUT_MS;
  let failures = 0;
  while (Date.now() < deadline) {
    if (signal.aborted) throw new SignInCancelledError();
    const listed = await listTabs(platform, {
      playwrightCli: PLAYWRIGHT_CLI,
      cdp,
      callTimeoutMs: COMMAND_TIMEOUT_MS,
      fullUrls: true,
    });
    if ('error' in listed) {
      failures += 1;
      if (failures >= MAX_LIST_FAILURES) throw new Error('lost the browser during the sign-in');
    } else {
      failures = 0;
      const row = listed.rows.find((r) => r.id === tab);
      if (!row) throw new SignInCancelledError();
      if (atRedirect(row.url, redirect)) return row.url;
    }
    await pause(POLL_MS, signal);
  }
  throw new Error('the sign-in timed out');
}

export interface TabPrompt extends SignInPrompt {
  authorizationUrl(): URL;
}

export function tabPrompt(
  platform: Platform,
  options: {
    cdp: string | undefined;
    paste: (signal: AbortSignal) => Promise<string | undefined>;
  }
): TabPrompt {
  let authorization: URL;

  const inTab = async (cdp: string, signal: AbortSignal): Promise<string | undefined> => {
    const tab = await openTab(platform, cdp);
    if (!tab) return undefined;
    await platform.write(2, 'Waiting for the sign-in in the browser tab.\n');
    const redirect = new URL(authorization.searchParams.get('redirect_uri') as string);
    void tabCommand(platform, cdp, ['goto', authorization.href, '--tab', tab]).catch(
      () => undefined
    );
    try {
      return await watchTab(platform, cdp, tab, redirect, signal);
    } finally {
      await tabCommand(platform, cdp, ['close', '--tab', tab]).catch(() => undefined);
    }
  };

  return {
    authorizationUrl: () => authorization,
    showAuthorizationUrl(url: URL) {
      authorization = url;
      void platform.write(2, `Open this URL to sign in:\n${url.href}\n`);
    },
    async promptForRedirectUrl(signal: AbortSignal): Promise<string | undefined> {
      const fromTab = options.cdp ? await inTab(options.cdp, signal) : undefined;
      if (fromTab) return fromTab;
      await platform.write(2, '\nPaste the redirect URL from your browser address bar:\n');
      return options.paste(signal);
    },
  };
}

export async function grantFor(
  platform: Platform,
  server: { serverUrl: string; oauth: McpOAuthConfig | undefined },
  held: HeldState,
  authorization: URL
): Promise<JerkGrant> {
  const { serverUrl, oauth } = server;
  const state = held.state as McpOAuthState;
  const discovery =
    state.discovery ??
    (await discoverOAuthServerInfo(serverUrl, {
      fetch: platform.fetch,
      authorizationServerMetadataUrl: new URL(oauth?.authServerMetadataUrl as string),
    }));
  const tokens = state.tokens as JerkGrant['response'];
  const resource = authorization.searchParams.get('resource');
  return {
    serverUrl,
    response: tokens,
    oauth: {
      tokenUrl:
        discovery.authorizationServerMetadata?.token_endpoint ??
        new URL('/token', discovery.authorizationServerUrl).href,
      clientId: authorization.searchParams.get('client_id') as string,
      ...(tokens.scope ? { scope: tokens.scope } : {}),
      ...(resource ? { resource } : {}),
    },
  };
}
