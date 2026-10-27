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
  async?: boolean;
}

export interface CompletionRef {
  type: 'ref/prompt' | 'ref/resource';
  name?: string;
  uri?: string;
}

export interface CompleteResult {
  completion: { values: string[]; total?: number; hasMore?: boolean };
}

export interface EventDescriptor {
  name: string;
  description?: string;
  delivery?: string[];
  inputSchema?: Record<string, unknown>;
  payloadSchema?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export interface EventOccurrence {
  eventId: string;
  name: string;
  timestamp: string;
  data: Record<string, unknown>;
  cursor?: string | null;
  _meta?: Record<string, unknown>;
}

export interface EventSubscription {
  name: string;
  arguments: Record<string, unknown>;
  cursor: string | null;
  maxAgeMs?: number;
}

export interface PollEventsResult {
  events?: EventOccurrence[];
  cursor?: string | null;
  truncated?: boolean;
  hasMore?: boolean;
  nextPollMs?: number;
}

export type StreamMessageHandler = (
  method: string,
  params: Record<string, unknown>
) => Promise<'stop' | undefined>;

export type StreamEnd = 'closed' | 'stale' | 'dropped' | 'stopped' | 'aborted';

export interface StreamOptions {
  idleMs: number;
  signal?: AbortSignal;
}

export interface EventsApi {
  list(): Promise<EventDescriptor[]>;
  subscribe(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  unsubscribe(params: Record<string, unknown>): Promise<Record<string, unknown>>;
  poll(subscription: EventSubscription): Promise<PollEventsResult>;
  stream(
    subscription: EventSubscription,
    onMessage: StreamMessageHandler,
    options: StreamOptions
  ): Promise<StreamEnd>;
}

export interface McpConnection {
  info(): Promise<ServerInfo>;
  listTools(): Promise<Tool[]>;
  hiddenTool?(name: string): string | undefined;
  listHint?(): string | undefined;
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
  complete(ref: CompletionRef, argument: { name: string; value: string }): Promise<CompleteResult>;
  getTask(taskId: string): Promise<Record<string, unknown>>;
  cancelTask(taskId: string): Promise<Record<string, unknown>>;
  events?: EventsApi;
  close(): Promise<void>;
}
