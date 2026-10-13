import type { McpOAuthState } from '@earendil-works/pi-mcp/oauth';
import { acquireLock } from '../config/lock.ts';
import { userConfigDir } from '../config/paths.ts';
import type { Platform } from '../platform/types.ts';
import type { TokenResult, TokenSource } from './token-source.ts';
import { storeKey } from './token-source.ts';

type StoredStates = Record<string, McpOAuthState>;

const AUTH_FILE = 'mcp-auth.json';
const FILE_MODE = 0o600;

function parseStates(raw: string | undefined): StoredStates {
  if (!raw?.trim()) return {};
  const parsed: unknown = JSON.parse(raw);
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as StoredStates)
    : {};
}

function serializeStates(states: StoredStates): string {
  return `${JSON.stringify(states, null, 2)}\n`;
}

function legacyKey(serverUrl: string): string {
  return String(new URL(serverUrl));
}

export class PiFileTokenSource implements TokenSource {
  private readonly platform: Platform;
  private readonly authPath: string;
  private readonly dirPath: string;

  constructor(platform: Platform) {
    this.platform = platform;
    this.dirPath = userConfigDir(platform);
    this.authPath = `${this.dirPath}/${AUTH_FILE}`;
  }

  get path(): string {
    return this.authPath;
  }

  async getToken(name: string, serverUrl: string): Promise<TokenResult | undefined> {
    const state = await this.load(name, serverUrl);
    if (!state?.tokens?.access_token) return undefined;
    return {
      accessToken: state.tokens.access_token,
      expiresAt: state.tokensExpireAt,
    };
  }

  async load(name: string, serverUrl: string): Promise<McpOAuthState | undefined> {
    const key = storeKey(name, serverUrl);
    const legacy = legacyKey(serverUrl);
    const release = await this.acquireLock();
    try {
      const raw = await this.readRaw();
      const states = parseStates(raw);
      if (states[key]) return states[key];
      if (states[legacy]) {
        states[key] = states[legacy];
        delete states[legacy];
        await this.writeStates(states);
        return states[key];
      }
      return undefined;
    } finally {
      await release();
    }
  }

  async save(name: string, serverUrl: string, state: McpOAuthState): Promise<void> {
    const key = storeKey(name, serverUrl);
    const release = await this.acquireLock();
    try {
      const raw = await this.readRaw();
      const states = parseStates(raw);
      states[key] = state;
      await this.writeStates(states);
    } finally {
      await release();
    }
  }

  async remove(name: string, serverUrl: string): Promise<boolean> {
    const key = storeKey(name, serverUrl);
    const legacy = legacyKey(serverUrl);
    const release = await this.acquireLock();
    try {
      const raw = await this.readRaw();
      const states = parseStates(raw);
      const stored = key in states ? key : legacy in states ? legacy : undefined;
      if (!stored) return false;
      delete states[stored];
      await this.writeStates(states);
      return true;
    } finally {
      await release();
    }
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    await this.ensureDir();
    return acquireLock(this.platform.fs, this.authPath);
  }

  private async ensureDir(): Promise<void> {
    try {
      await this.platform.fs.mkdir(this.dirPath);
    } catch {}
  }

  private async readRaw(): Promise<string | undefined> {
    try {
      const data = await this.platform.fs.readFile(this.authPath);
      return new TextDecoder().decode(data);
    } catch {
      return undefined;
    }
  }

  private async writeStates(states: StoredStates): Promise<void> {
    await this.platform.fs.writeFile(this.authPath, serializeStates(states), { mode: FILE_MODE });
  }
}
