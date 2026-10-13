export type McpServerConfig = {
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
};

export interface ConfigSource {
  get(name: string): Promise<McpServerConfig | undefined>;
}
