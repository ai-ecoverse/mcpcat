import type { Platform } from '../platform/types.ts';

export interface McpServerConfig {
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  headers?: Record<string, string>;
  enabled?: boolean;
  description?: string;
  exposure?: string;
  timeout?: number;
}

export interface ConfigSource {
  get(name: string): Promise<McpServerConfig | undefined>;
}

interface McpJsonFile {
  mcpServers?: Record<string, McpServerConfig>;
}

export function createConfigSource(platform: Platform): ConfigSource {
  const home = platform.env.HOME ?? platform.env.USERPROFILE ?? '';
  const piDir = platform.env.PI_CODING_AGENT_DIR ?? `${home}/.pi/agent`;
  const configPath = `${piDir}/mcp.json`;

  return {
    async get(name: string): Promise<McpServerConfig | undefined> {
      try {
        const exists = await platform.fs.exists(configPath);
        if (!exists) return undefined;
        const data = await platform.fs.readFile(configPath);
        const text = new TextDecoder().decode(data);
        const parsed = JSON.parse(text) as McpJsonFile;
        if (!parsed.mcpServers) return undefined;
        const normalizedName = name.replace(/[-_]/g, '').toLowerCase();
        for (const [key, value] of Object.entries(parsed.mcpServers)) {
          if (key.replace(/[-_]/g, '').toLowerCase() === normalizedName) {
            return value;
          }
        }
        return undefined;
      } catch {
        return undefined;
      }
    },
  };
}
