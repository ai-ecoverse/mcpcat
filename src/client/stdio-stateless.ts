import type {
  CallToolResult,
  ReadResourceResult,
  Resource,
  ResourceTemplate,
  Tool,
} from '@earendil-works/pi-mcp';
import type { VerboseLogger } from '../cli/verbose.ts';
import type { Platform, SpawnResult } from '../platform/types.ts';
import type {
  CallToolOptions,
  GetPromptResult,
  McpConnection,
  PromptInfo,
  ServerInfo,
} from './connection.ts';
import { InputRequiredError, McpTimeoutError, StatelessRpcError } from './stateless-connection.ts';
import { trackStdio } from './stdio-registry.ts';

const PROTOCOL_VERSION = '2026-07-28';

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

interface StdioStatelessOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  platform: Platform;
  version?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  verbose?: VerboseLogger;
}

interface StdioJsonRpc {
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  close(): void;
  pendingBuffer(): string;
}

function createStdioJsonRpc(
  proc: SpawnResult,
  platform: Platform,
  options: { version?: string; timeoutMs?: number; signal?: AbortSignal; verbose?: VerboseLogger }
): StdioJsonRpc {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let nextId = 1;
  let readBuffer = '';
  const reader = proc.stdout.getReader();
  let negotiatedVersion: string | undefined;
  const { version = '0.0.0', timeoutMs = 60_000, signal: externalSignal, verbose } = options;

  async function readLine(): Promise<string> {
    while (true) {
      const nlIdx = readBuffer.indexOf('\n');
      if (nlIdx >= 0) {
        const line = readBuffer.slice(0, nlIdx).trim();
        readBuffer = readBuffer.slice(nlIdx + 1);
        if (line) return line;
        continue;
      }
      const { done, value } = await reader.read();
      if (done) throw new Error('stdio server closed unexpectedly');
      readBuffer += decoder.decode(value, { stream: true });
    }
  }

  async function send(msg: string): Promise<void> {
    const writer = proc.stdin.getWriter();
    try {
      await writer.write(encoder.encode(`${msg}\n`));
    } finally {
      writer.releaseLock();
    }
  }

  async function request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = nextId++;
    const meta: Record<string, unknown> = {
      protocolVersion: negotiatedVersion ?? PROTOCOL_VERSION,
      clientInfo: { name: 'mcpcat', version },
    };
    const cleanParams = { ...params };
    if (cleanParams._inputResponses) {
      meta.inputResponses = cleanParams._inputResponses;
      delete cleanParams._inputResponses;
    }
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params: { ...cleanParams, _meta: meta },
    });

    if (verbose?.enabled) verbose.request(method, body);
    await send(body);

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const remaining = deadline - Date.now();
      if (externalSignal?.aborted) throw new McpTimeoutError(method, timeoutMs);
      const linePromise = readLine();
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new McpTimeoutError(method, timeoutMs)), remaining)
      );
      const line = await Promise.race([linePromise, timeoutPromise]);
      const parsed = JSON.parse(line) as JsonRpcMessage;
      if (verbose?.enabled) verbose.response(line);
      if (parsed.id === id) {
        if (parsed.error) {
          throw new StatelessRpcError(parsed.error.code, parsed.error.message, parsed.error.data);
        }
        return parsed.result;
      }
    }
    throw new McpTimeoutError(method, timeoutMs);
  }

  return {
    request,
    close() {
      try {
        reader.releaseLock();
      } catch {}
    },
    pendingBuffer() {
      return readBuffer;
    },
  };
}

function buildServerInfo(discoverResult: Record<string, unknown> | null): ServerInfo {
  return {
    name: (discoverResult?.serverInfo as Record<string, unknown>)?.name as string | undefined,
    version: (discoverResult?.serverInfo as Record<string, unknown>)?.version as string | undefined,
    title: (discoverResult?.serverInfo as Record<string, unknown>)?.title as string | undefined,
    protocolVersion: PROTOCOL_VERSION,
    capabilities: (discoverResult?.capabilities as Record<string, unknown>) ?? {},
    instructions: discoverResult?.instructions as string | undefined,
  };
}

function buildConnectionMethods(
  rpc: StdioJsonRpc,
  discoverResult: Record<string, unknown> | null,
  proc: SpawnResult
): McpConnection {
  return {
    async info(): Promise<ServerInfo> {
      return buildServerInfo(discoverResult);
    },
    async listTools(): Promise<Tool[]> {
      return ((await rpc.request('tools/list', {})) as { tools?: Tool[] } | null)?.tools ?? [];
    },
    async callTool(
      name: string,
      args?: Record<string, unknown>,
      callOptions?: CallToolOptions
    ): Promise<CallToolResult> {
      const params: Record<string, unknown> = { name, arguments: args ?? {} };
      if (callOptions?.inputResponses) {
        params._inputResponses = callOptions.inputResponses;
      }
      const result = (await rpc.request('tools/call', params)) as CallToolResult & {
        resultType?: string;
      };
      if ((result.resultType ?? 'complete') === 'input_required') {
        throw new InputRequiredError(
          JSON.stringify({ name, arguments: args ?? {}, result }, null, 2)
        );
      }
      return result;
    },
    async listResources(): Promise<Resource[]> {
      return (
        ((await rpc.request('resources/list', {})) as { resources?: Resource[] } | null)
          ?.resources ?? []
      );
    },
    async listResourceTemplates(): Promise<ResourceTemplate[]> {
      return (
        (
          (await rpc.request('resources/templates/list', {})) as {
            resourceTemplates?: ResourceTemplate[];
          } | null
        )?.resourceTemplates ?? []
      );
    },
    async readResource(uri: string): Promise<ReadResourceResult> {
      return (await rpc.request('resources/read', { uri })) as ReadResourceResult;
    },
    async listPrompts(): Promise<PromptInfo[]> {
      return (
        ((await rpc.request('prompts/list', {})) as { prompts?: PromptInfo[] } | null)?.prompts ??
        []
      );
    },
    async getPrompt(name: string, args?: Record<string, unknown>): Promise<GetPromptResult> {
      return (await rpc.request('prompts/get', { name, arguments: args ?? {} })) as GetPromptResult;
    },
    async close(): Promise<void> {
      rpc.close();
      try {
        await proc.kill('SIGTERM');
      } catch {}
    },
  };
}

export interface StdioFallbackProcess {
  proc: SpawnResult;
  pendingStdout: string;
}

export async function createStdioStatelessConnection(
  options: StdioStatelessOptions
): Promise<McpConnection> {
  const result = await probeStdioStateless(options);
  if ('proc' in result) throw result.error;
  return result;
}

export async function probeStdioStateless(
  options: StdioStatelessOptions
): Promise<McpConnection | { proc: SpawnResult; pendingStdout: string; error: Error }> {
  const inheritedEnv = {
    ...(options.platform.env as Record<string, string>),
    ...options.env,
  };
  const proc = await options.platform.spawn({
    argv: [options.command, ...(options.args ?? [])],
    env: inheritedEnv,
    cwd: options.cwd,
    dieWithParent: true,
  });
  trackStdio(proc);

  const rpc = createStdioJsonRpc(proc, options.platform, {
    version: options.version,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    verbose: options.verbose,
  });

  let discoverRaw;
  try {
    discoverRaw = await rpc.request('server/discover', {
      protocolVersion: PROTOCOL_VERSION,
    });
  } catch (err) {
    const pending = rpc.pendingBuffer();
    rpc.close();
    return { proc, pendingStdout: pending, error: err as Error };
  }

  void readStderr(proc, options.verbose);
  const discoverResult = discoverRaw as Record<string, unknown>;
  const supported = ((discoverResult?.supportedVersions as string[] | undefined) ?? []).filter(
    (v): v is string => typeof v === 'string'
  );
  if (!supported.includes(PROTOCOL_VERSION)) {
    await proc.kill('SIGTERM');
    throw new Error(
      `Server does not support ${PROTOCOL_VERSION} (advertised: ${supported.join(', ') || 'none'})`
    );
  }

  return buildConnectionMethods(rpc, discoverResult, proc);
}

async function readStderr(
  proc: { stderr: ReadableStream<Uint8Array> },
  verbose?: VerboseLogger
): Promise<void> {
  if (!verbose?.enabled) return;
  const reader = proc.stderr.getReader();
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split('\n')) {
        if (line.trim()) verbose.server(line);
      }
    }
  } catch {}
}
