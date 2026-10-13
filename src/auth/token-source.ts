import type { McpOAuthState } from '@earendil-works/pi-mcp/oauth';
import type { Platform } from '../platform/types.ts';

export interface TokenResult {
  accessToken: string;
  expiresAt?: number;
}

export interface OAuthStateAccess {
  load(name: string, serverUrl: string): Promise<McpOAuthState | undefined>;
  save(name: string, serverUrl: string, state: McpOAuthState): Promise<void>;
  remove(name: string, serverUrl: string): Promise<boolean>;
}

export interface TokenSource extends OAuthStateAccess {
  getToken(name: string, serverUrl: string): Promise<TokenResult | undefined>;
}

export function mcpNamespace(server: string): string {
  return `mcp__${server.replace(/-/g, '_')}`;
}

export function storeKey(name: string, serverUrl: string): string {
  const ns = mcpNamespace(name);
  const url = String(new URL(serverUrl));
  return `${ns}|${url}`;
}

export function urlOnlyKey(serverUrl: string): string {
  const u = new URL(serverUrl);
  return `url:${u.origin}${u.pathname}`;
}

export function isKernel(platform: Platform): boolean {
  return platform.kind === 'kernel';
}
