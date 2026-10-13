import {
  type AuthProvider,
  type CallToolResult,
  McpClient,
  type McpClientOptions,
  type McpRequestOptions,
  type McpTransport,
  type ReadResourceResult,
  type Resource,
  type ResourceTemplate,
  StdioTransport,
  StreamableHttpTransport,
  type Tool,
} from '@earendil-works/pi-mcp';
import type { VerboseLogger } from '../cli/verbose.ts';
import type { Platform } from '../platform/types.ts';
import type {
  CallToolOptions,
  GetPromptResult,
  McpConnection,
  PromptInfo,
  ServerInfo,
} from './connection.ts';
import { PlatformStdioTransport } from './platform-stdio-transport.ts';
import { McpAuthError, McpTimeoutError } from './stateless-connection.ts';

export interface PiConnectionOptions {
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  version?: string;
  fetchImpl?: typeof globalThis.fetch;
  platform?: Platform;
  timeoutMs?: number;
  signal?: AbortSignal;
  verbose?: VerboseLogger;
  authProvider?: AuthProvider;
  roots?: { uri: string; name?: string }[];
}

function buildStderrHandler(options: PiConnectionOptions): ((chunk: string) => void) | undefined {
  if (!options.verbose?.enabled) return undefined;
  return (chunk: string) => {
    for (const l of chunk.split('\n')) {
      if (l.trim()) options.verbose!.server(l);
    }
  };
}

function buildTransport(options: PiConnectionOptions): McpTransport {
  if (options.url) {
    return new StreamableHttpTransport({
      url: options.url,
      headers: options.headers,
      fetch: options.fetchImpl,
      authProvider: options.authProvider,
    });
  }
  if (!options.command) throw new Error('PiConnection requires either a url or a command');
  if (options.platform) {
    return new PlatformStdioTransport({
      command: options.command,
      args: options.args,
      env: options.env,
      cwd: options.cwd,
      inheritEnv: true,
      platform: options.platform,
      onStderr: buildStderrHandler(options),
    }) as unknown as McpTransport;
  }
  return new StdioTransport({
    command: options.command,
    args: options.args,
    env: options.env,
    cwd: options.cwd,
    inheritEnv: true,
    stderr: 'pipe',
    onStderr: buildStderrHandler(options),
  });
}

export async function createPiConnection(options: PiConnectionOptions): Promise<McpConnection> {
  const clientOptions: McpClientOptions = {
    name: 'mcpcat',
    version: options.version ?? '0.0.0',
    requestTimeoutMs: options.timeoutMs,
    capabilities: { elicitation: {} },
    roots: options.roots,
  };

  const client = new McpClient(clientOptions);
  const transport = buildTransport(options);

  if (options.verbose?.enabled) {
    transport.onMessage((msg) => {
      options.verbose!.response(JSON.stringify(msg));
    });
  }

  try {
    const initResult = await client.connect(transport);

    function reqOpts(): McpRequestOptions {
      const o: McpRequestOptions = {};
      if (options.signal) o.signal = options.signal;
      if (options.verbose?.enabled) {
        o.onProgress = (p) => {
          options.verbose!.progress(`progress: ${p.message ?? ''}`);
        };
      }
      return o;
    }

    return {
      async info(): Promise<ServerInfo> {
        return {
          name: initResult.serverInfo?.name,
          version: initResult.serverInfo?.version,
          title: (initResult.serverInfo as unknown as Record<string, unknown>)?.title as
            | string
            | undefined,
          protocolVersion: initResult.protocolVersion,
          capabilities: initResult.capabilities as unknown as Record<string, unknown>,
          instructions: initResult.instructions,
        };
      },
      async listTools(): Promise<Tool[]> {
        return client.listTools(reqOpts());
      },
      async callTool(
        name: string,
        args?: Record<string, unknown>,
        callOptions?: CallToolOptions
      ): Promise<CallToolResult> {
        const o = reqOpts();
        if (callOptions?.onProgress) {
          const outer = callOptions.onProgress;
          const inner = o.onProgress;
          o.onProgress = (p) => {
            outer(p.progress, p.total, p.message);
            inner?.(p);
          };
        }
        const callArgs = callOptions?.inputResponses
          ? { ...args, _meta: { inputResponses: callOptions.inputResponses } }
          : args;
        return client.callTool(name, callArgs, o);
      },
      async listResources(): Promise<Resource[]> {
        return client.listResources(reqOpts());
      },
      async listResourceTemplates(): Promise<ResourceTemplate[]> {
        return client.listResourceTemplates(reqOpts());
      },
      async readResource(uri: string): Promise<ReadResourceResult> {
        return client.readResource(uri, reqOpts());
      },
      async listPrompts(): Promise<PromptInfo[]> {
        const result = await client.request<{ prompts?: PromptInfo[] }>(
          'prompts/list',
          {},
          reqOpts()
        );
        return result?.prompts ?? [];
      },
      async getPrompt(name: string, args?: Record<string, unknown>): Promise<GetPromptResult> {
        return client.request<GetPromptResult>(
          'prompts/get',
          { name, arguments: args ?? {} },
          reqOpts()
        );
      },
      async close(): Promise<void> {
        await client.close();
      },
    };
  } catch (err) {
    const msg = (err as Error).message ?? '';
    if (msg.includes('401') || msg.includes('403') || msg.includes('Unauthorized')) {
      throw new McpAuthError(401, options.url ?? options.command ?? '');
    }
    if (msg.includes('timeout') || msg.includes('Timeout') || msg.includes('ETIMEDOUT')) {
      throw new McpTimeoutError('connect', options.timeoutMs ?? 60_000);
    }
    throw err;
  }
}
