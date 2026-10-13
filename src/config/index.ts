import type { Platform } from '../platform/types.ts';
import { loadConfig } from './merge.ts';
import { projectConfigPath, userConfigPath } from './paths.ts';
import type { ConfigSource, McpServerConfig as FlatConfig } from './source.ts';
import type { LoadedConfig, McpServerEntry } from './types.ts';

export class MergedConfigSource implements ConfigSource {
  private readonly entries: Map<string, McpServerEntry>;
  readonly config: LoadedConfig;

  constructor(config: LoadedConfig) {
    this.config = config;
    this.entries = new Map();
    for (const entry of config.servers) {
      this.entries.set(entry.name, entry);
    }
  }

  async get(name: string): Promise<FlatConfig | undefined> {
    const normalizedName = name.replace(/[-_]/g, '').toLowerCase();
    for (const [key, entry] of this.entries) {
      if (key.replace(/[-_]/g, '').toLowerCase() === normalizedName) {
        return entry.config as unknown as FlatConfig;
      }
    }
    return undefined;
  }

  entry(name: string): McpServerEntry | undefined {
    return this.entries.get(name);
  }

  list(): McpServerEntry[] {
    return [...this.entries.values()];
  }

  static async load(
    platform: Platform,
    options?: { trustProject?: boolean; configFile?: string }
  ): Promise<MergedConfigSource> {
    const userPath = options?.configFile ?? userConfigPath(platform);
    const projectPath = options?.configFile ? undefined : projectConfigPath(platform);
    const config = await loadConfig({
      userPath,
      projectPath,
      trustProject: options?.trustProject ?? false,
      fs: platform.fs,
    });
    return new MergedConfigSource(config);
  }
}
