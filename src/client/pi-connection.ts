import {
  type AuthProvider,
  type CallToolResult,
  McpClient,
  type McpClientOptions,
  McpError,
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
import type { Platform, SpawnResult } from '../platform/types.ts';
import type {
  CallToolOptions,
  CompleteResult,
  CompletionRef,
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
  existingProcess?: { proc: SpawnResult; pendingStdout: string };
  onElicit?: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;
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
      existingProcess: options.existingProcess?.proc,
      pendingStdout: options.existingProcess?.pendingStdout,
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
    capabilities: options.onElicit ? { elicitation: { form: {}, url: {} } } : {},
    roots: options.roots,
  };

  const client = new McpClient(clientOptions);
  const onElicit = options.onElicit;
  const inFlight = new Set<(err: unknown) => void>();
  let abortError: { err: unknown } | undefined;
  function abortWith(err: unknown): void {
    abortError ??= { err };
    for (const reject of inFlight) reject(err);
  }
  function guard<T>(p: Promise<T>): Promise<T> {
    if (!onElicit) return p;
    return new Promise<T>((resolve, reject) => {
      if (abortError) reject(abortError.err);
      inFlight.add(reject);
      p.then(resolve, reject).finally(() => inFlight.delete(reject));
    });
  }
  if (onElicit) {
    client.setRequestHandler('elicitation/create', async (params) => {
      try {
        return await onElicit((params ?? {}) as Record<string, unknown>);
      } catch (err) {
        abortWith(err);
        return { action: 'cancel' };
      }
    });
  }
  client.setRequestHandler('sampling/createMessage', () => {
    throw new McpError(-1, 'sampling declined: mcpcat has no LLM');
  });
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
        return guard(client.listTools(reqOpts()));
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
        return guard(client.callTool(name, callArgs, o));
      },
      async listResources(): Promise<Resource[]> {
        return guard(client.listResources(reqOpts()));
      },
      async listResourceTemplates(): Promise<ResourceTemplate[]> {
        return guard(client.listResourceTemplates(reqOpts()));
      },
      async readResource(uri: string): Promise<ReadResourceResult> {
        return guard(client.readResource(uri, reqOpts()));
      },
      async listPrompts(): Promise<PromptInfo[]> {
        const result = await guard(
          client.request<{ prompts?: PromptInfo[] }>('prompts/list', {}, reqOpts())
        );
        return result?.prompts ?? [];
      },
      async getPrompt(name: string, args?: Record<string, unknown>): Promise<GetPromptResult> {
        return guard(
          client.request<GetPromptResult>('prompts/get', { name, arguments: args ?? {} }, reqOpts())
        );
      },
      async complete(
        ref: CompletionRef,
        argument: { name: string; value: string }
      ): Promise<CompleteResult> {
        return client.request<CompleteResult>('completion/complete', { ref, argument }, reqOpts());
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
