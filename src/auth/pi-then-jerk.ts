import type { McpOAuthState } from '@earendil-works/pi-mcp/oauth';
import type { JerkTokenSource } from './jerk-token-source.ts';
import { PiFileTokenSource } from './pi-store.ts';
import type { TokenResult, TokenSource } from './token-source.ts';

export function piStoreForSecrets(source: TokenSource): PiFileTokenSource | undefined {
  if (source instanceof PiFileTokenSource) return source;
  if (source instanceof PiThenJerkTokenSource) return source.pi;
  return undefined;
}

export class PiThenJerkTokenSource implements TokenSource {
  readonly pi: PiFileTokenSource;
  readonly jerk: JerkTokenSource;

  constructor(pi: PiFileTokenSource, jerk: JerkTokenSource) {
    this.pi = pi;
    this.jerk = jerk;
  }

  async getToken(
    name: string,
    serverUrl: string,
    scope?: string
  ): Promise<TokenResult | undefined> {
    const fromPi = await this.pi.getToken(name, serverUrl);
    if (fromPi) return fromPi;
    return this.jerk.getToken(name, serverUrl, scope);
  }

  async load(name: string, serverUrl: string): Promise<McpOAuthState | undefined> {
    const fromPi = await this.pi.load(name, serverUrl);
    if (fromPi) return fromPi;
    return this.jerk.load(name, serverUrl);
  }

  async save(name: string, serverUrl: string, state: McpOAuthState): Promise<void> {
    await this.pi.save(name, serverUrl, state);
  }

  async remove(name: string, serverUrl: string): Promise<boolean> {
    return this.pi.remove(name, serverUrl);
  }
}
