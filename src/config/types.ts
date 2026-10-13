export type McpExposure = 'codemode' | 'deferred' | 'direct' | 'hidden';

export interface McpStdioServerConfig {
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  enabled?: boolean;
  exposure?: McpExposure;
  toolExposure?: Record<string, McpExposure>;
  description?: string;
  timeout?: number;
}

export interface McpOAuthConfig {
  clientId?: string;
  clientSecret?: string;
  callbackPort?: number;
  callbackUrl?: string;
  scope?: string;
  clientName?: string;
  clientRegistration?: 'dcr' | 'cimd';
  authServerMetadataUrl?: string;
}

export interface McpHttpServerConfig {
  type?: 'http' | 'streamable-http';
  url: string;
  headers?: Record<string, string>;
  oauth?: McpOAuthConfig;
  auth?: { provider: string };
  enabled?: boolean;
  exposure?: McpExposure;
  toolExposure?: Record<string, McpExposure>;
  description?: string;
  timeout?: number;
}

export type McpServerConfig = McpStdioServerConfig | McpHttpServerConfig;

export interface McpConfigProblem {
  server?: string;
  field?: string;
  message: string;
}

export interface McpServerEntry {
  name: string;
  config: McpServerConfig;
  source: string;
  scope?: 'user' | 'project';
  override?: string;
}

export interface LoadedConfig {
  servers: McpServerEntry[];
  problems: McpConfigProblem[];
  autoEnableCodemode?: boolean;
}

export interface AgentWarning {
  server: string;
  message: string;
  advice: string;
}
