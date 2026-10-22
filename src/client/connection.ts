import type {
  CallToolResult,
  ReadResourceResult,
  Resource,
  ResourceTemplate,
  Tool,
} from '@earendil-works/pi-mcp';

export interface PromptArgument {
  name: string;
  description?: string;
  required?: boolean;
}

export interface PromptInfo {
  name: string;
  title?: string;
  description?: string;
  arguments?: PromptArgument[];
}

export interface PromptMessage {
  role: string;
  content: { type: string; text?: string; data?: string; mimeType?: string };
}

export interface GetPromptResult {
  description?: string;
  messages: PromptMessage[];
}

export interface ServerInfo {
  name?: string;
  version?: string;
  title?: string;
  protocolVersion: string;
  capabilities: Record<string, unknown>;
  instructions?: string;
}

export interface CallToolOptions {
  onProgress?: (progress: number, total?: number, message?: string) => void;
  inputResponses?: Record<string, unknown>;
}

export interface McpConnection {
  info(): Promise<ServerInfo>;
  listTools(): Promise<Tool[]>;
  hiddenTool?(name: string): string | undefined;
  callTool(
    name: string,
    args?: Record<string, unknown>,
    options?: CallToolOptions
  ): Promise<CallToolResult>;
  listResources(): Promise<Resource[]>;
  listResourceTemplates(): Promise<ResourceTemplate[]>;
  readResource(uri: string): Promise<ReadResourceResult>;
  listPrompts(): Promise<PromptInfo[]>;
  getPrompt(name: string, args?: Record<string, unknown>): Promise<GetPromptResult>;
  close(): Promise<void>;
}
