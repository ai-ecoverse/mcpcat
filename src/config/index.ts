import type { Platform } from '../platform/types.ts';
import { type LegacyHint, legacyPathFor } from './legacy.ts';
import { loadConfig } from './merge.ts';
import { lookupKey } from './parse.ts';
import { projectConfigPath, userConfigPath } from './paths.ts';
import type { ConfigSource, McpServerConfig as FlatConfig } from './source.ts';
import type { LoadedConfig, McpServerEntry } from './types.ts';

export class MergedConfigSource implements ConfigSource {
  private readonly entries: Map<string, McpServerEntry>;
  readonly config: LoadedConfig;
  private readonly legacy?: LegacyHint;

  constructor(config: LoadedConfig, legacy?: LegacyHint) {
    this.config = config;
    this.legacy = legacy;
    this.entries = new Map();
    for (const entry of config.servers) {
      this.entries.set(entry.name, entry);
    }
  }

  async get(name: string): Promise<FlatConfig | undefined> {
    const normalizedName = lookupKey(name);
    for (const [key, entry] of this.entries) {
      if (lookupKey(key) === normalizedName) {
        return entry.config as unknown as FlatConfig;
      }
    }
    return undefined;
  }

  async explainMissing(name: string): Promise<string> {
    const path = this.legacy && (await legacyPathFor(this.legacy, name));
    return path ? `not found in mcp.json; found in ${path}` : 'not found in mcp.json';
  }

  entry(name: string): McpServerEntry | undefined {
    return this.entries.get(name);
  }

  list(): McpServerEntry[] {
    return [...this.entries.values()];
  }

  static async load(
    platform: Platform,
    options?: { trustProject?: boolean; configFile?: string; quiet?: boolean }
  ): Promise<MergedConfigSource> {
    const userPath = options?.configFile ?? userConfigPath(platform);
    const projectPath = options?.configFile ? undefined : projectConfigPath(platform);
    const config = await loadConfig({
      userPath,
      projectPath,
      trustProject: options?.trustProject ?? false,
      fs: platform.fs,
    });
    const legacy = options?.configFile ? undefined : { platform, quiet: options?.quiet };
    return new MergedConfigSource(config, legacy);
  }
}
