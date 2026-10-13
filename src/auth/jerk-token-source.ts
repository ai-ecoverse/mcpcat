import type { McpOAuthState } from '@earendil-works/pi-mcp/oauth';
import type { Platform } from '../platform/types.ts';
import type { TokenResult, TokenSource } from './token-source.ts';

const MIN_VERSION = [0, 14, 1];
const VERSION_TIMEOUT_MS = 2_000;

let cachedAvailable: boolean | undefined;

export function resetJerkCache(): void {
  cachedAvailable = undefined;
}

function parseVersion(raw: string): number[] | undefined {
  const match = raw.trim().match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function versionSatisfied(actual: number[]): boolean {
  for (let i = 0; i < 3; i++) {
    if (actual[i] > MIN_VERSION[i]) return true;
    if (actual[i] < MIN_VERSION[i]) return false;
  }
  return true;
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
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

async function jerkOnPath(platform: Platform): Promise<boolean> {
  const pathVar = platform.env.PATH ?? platform.env.Path ?? '';
  const sep = pathVar.includes(';') ? ';' : ':';
  const dirs = pathVar.split(sep).filter(Boolean);
  for (const dir of dirs) {
    if (await platform.fs.exists(`${dir}/jerk`)) return true;
  }
  return false;
}

export async function jerkAvailable(platform: Platform): Promise<boolean> {
  if (cachedAvailable !== undefined) return cachedAvailable;
  if (!(await jerkOnPath(platform))) {
    cachedAvailable = false;
    return false;
  }
  try {
    const proc = await platform.spawn({ argv: ['jerk', '--version'] });
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('timeout')), VERSION_TIMEOUT_MS);
    });
    const work = Promise.all([readAll(proc.stdout), proc.wait()]).then(([out, result]) => {
      proc.stderr.cancel().catch(() => {});
      if (result.status !== 0) return false;
      const ver = parseVersion(out);
      return ver !== undefined && versionSatisfied(ver);
    });
    cachedAvailable = await Promise.race([work, timeout]);
  } catch {
    cachedAvailable = false;
  }
  return cachedAvailable;
}

function jerkId(name: string): string {
  if (name.startsWith('mcp:')) return name;
  if (name.startsWith('url:')) return `mcp:${name}`;
  return `mcp:${name}`;
}

export const JERK_EXIT_SIGN_IN = 3;
export const JERK_EXIT_UNAVAILABLE = 4;

export class JerkSignInRequiredError extends Error {
  readonly id: string;
  readonly scope: string | undefined;
  constructor(id: string, scope?: string) {
    const scopeHint = scope ? ` --scope ${scope}` : '';
    super(`sign-in required. Run: jerk ${id} create${scopeHint}`);
    this.name = 'JerkSignInRequiredError';
    this.id = id;
    this.scope = scope;
  }
}

export class JerkTokenSource implements TokenSource {
  private readonly platform: Platform;

  constructor(platform: Platform) {
    this.platform = platform;
  }

  async getToken(
    name: string,
    serverUrl: string,
    scope?: string
  ): Promise<TokenResult | undefined> {
    const id = jerkId(name);
    const argv = ['jerk', id, 'get', '--reveal', '--json'];
    if (scope) {
      argv.push('--scope', scope);
    }
    const proc = await this.platform.spawn({ argv });
    const [outRaw, , result] = await Promise.all([
      readAll(proc.stdout),
      readAll(proc.stderr),
      proc.wait(),
    ]);

    if (result.status === JERK_EXIT_SIGN_IN) {
      throw new JerkSignInRequiredError(id, scope);
    }

    if (result.status === JERK_EXIT_UNAVAILABLE) {
      return undefined;
    }

    if (result.status !== 0) {
      return undefined;
    }

    const parsed = JSON.parse(outRaw.trim()) as {
      token?: string;
      expires_at?: number;
      scope?: string;
    };
    if (!parsed.token) return undefined;

    return {
      accessToken: parsed.token,
      expiresAt: parsed.expires_at,
    };
  }

  async load(_name: string, _serverUrl: string): Promise<McpOAuthState | undefined> {
    return undefined;
  }

  async save(_name: string, _serverUrl: string, _state: McpOAuthState): Promise<void> {}

  async remove(_name: string, _serverUrl: string): Promise<boolean> {
    return false;
  }
}
