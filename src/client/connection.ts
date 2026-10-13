import type { CallToolResult, Tool } from '@earendil-works/pi-mcp';

export interface ServerInfo {
  name?: string;
  version?: string;
  title?: string;
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  instructions?: string;
}

export interface McpConnection {
  info(): Promise<ServerInfo>;
  listTools(): Promise<Tool[]>;
  callTool(name: string, args?: Record<string, unknown>): Promise<CallToolResult>;
  close(): Promise<void>;
}
