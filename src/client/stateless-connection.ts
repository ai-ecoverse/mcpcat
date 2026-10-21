import type {
  AuthProvider,
  CallToolResult,
  ReadResourceResult,
  Resource,
  ResourceTemplate,
  Tool,
} from '@earendil-works/pi-mcp';
import { AuthStepUpError } from '../auth/auth-provider.ts';
import { JerkTimeoutError } from '../auth/jerk-token-source.ts';
import type { VerboseLogger } from '../cli/verbose.ts';
import type {
  CallToolOptions,
  GetPromptResult,
  McpConnection,
  PromptInfo,
  ServerInfo,
} from './connection.ts';

export const STATELESS_PROTOCOL_VERSION = '2026-07-28';

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  method?: string;
}

export class StatelessRpcError extends Error {
  readonly code: number;
  readonly data?: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(`MCP RPC error ${code}: ${message}`);
    this.name = 'StatelessRpcError';
    this.code = code;
    this.data = data;
  }
}

export class StatelessHttpError extends Error {
  readonly status: number;
  constructor(status: number, statusText: string, method: string, snippet: string) {
    super(`MCP HTTP ${status} ${statusText} for ${method}: ${snippet || '(empty body)'}`);
    this.name = 'StatelessHttpError';
    this.status = status;
  }
}

export class InputRequiredError extends Error {
  readonly requestJson: string;
  constructor(requestJson: string) {
    super('Server requires input (resultType: input_required)');
    this.name = 'InputRequiredError';
    this.requestJson = requestJson;
  }
}

export class McpTimeoutError extends Error {
  constructor(method: string, ms: number) {
    super(`timeout after ${ms}ms waiting for ${method}`);
    this.name = 'McpTimeoutError';
  }
}

export class McpAuthError extends Error {
  readonly status: number;
  readonly target: string;
  constructor(status: number, target: string, reason?: string) {
    const why = reason ? ` (${reason})` : '';
    super(`HTTP ${status}: authentication required${why}. Run: mcpcat login ${target}`);
    this.name = 'McpAuthError';
    this.status = status;
    this.target = target;
  }
}

export class TransportRefusalError extends Error {
  readonly status: number;
  readonly reason: string;
  constructor(status: number, reason: string) {
    super(reason);
    this.name = 'TransportRefusalError';
    this.status = status;
    this.reason = reason;
  }
}

class AuthRetryableError extends Error {
  readonly response: Response;
  readonly reason: string | undefined;
  constructor(response: Response, reason: string | undefined) {
    super(`HTTP ${response.status}: auth retry`);
    this.name = 'AuthRetryableError';
    this.response = response;
    this.reason = reason;
  }
}

const KERNEL_REFUSAL = 'nodeTransport refuses ';

function firstLine(text: string): string {
  return text.trim().split('\n')[0].trim().slice(0, 200);
}

async function authReason(
  res: Response,
  redact: (text: string) => string
): Promise<{ raw?: string; reason?: string }> {
  const type = res.headers.get('content-type') ?? '';
  if (!type.toLowerCase().startsWith('text/plain')) return {};
  const text = await res.text();
  return { raw: firstLine(text), reason: firstLine(redact(text)) || undefined };
}

function selectSseFrame(body: Uint8Array, targetId: number): JsonRpcResponse {
  const text = new TextDecoder().decode(body);
  const blocks = text.replace(/\r\n/g, '\n').split(/\n\n/);
  for (const block of blocks) {
    if (!block.trim()) continue;
    const dataLines: string[] = [];
    for (const line of block.split('\n')) {
      if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length === 0) continue;
    try {
      const parsed = JSON.parse(dataLines.join('\n')) as JsonRpcResponse;
      if (parsed.id === targetId) return parsed;
    } catch {}
  }
  throw new Error(`SSE stream ended without response for id ${targetId}`);
}

function mcpNameForMethod(method: string, params: Record<string, unknown>): string | undefined {
  if (method === 'tools/call') return params.name as string | undefined;
  if (method === 'prompts/get') return params.name as string | undefined;
  if (method === 'resources/read') return params.uri as string | undefined;
  return undefined;
}

function makeAbort(
  timeoutMs: number,
  externalSignal?: AbortSignal
): {
  controller: AbortController;
  stopTimer: () => void;
  detach: () => void;
} {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => {
    clearTimeout(timer);
    controller.abort();
  };
  if (externalSignal?.aborted) onAbort();
  else externalSignal?.addEventListener('abort', onAbort, { once: true });
  return {
    controller,
    stopTimer: () => clearTimeout(timer),
    detach: () => {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onAbort);
    },
  };
}

function logHeaders(
  verbose: VerboseLogger,
  dir: '>' | '<',
  entries: Iterable<[string, string]>
): void {
  for (const [k, v] of entries) {
    if (dir === '>') verbose.headerOut(k, v);
    else verbose.headerIn(k, v);
  }
}

function buildServerInfo(discoverResult: Record<string, unknown> | null): ServerInfo {
  return {
    name: (discoverResult?.serverInfo as Record<string, unknown>)?.name as string | undefined,
    version: (discoverResult?.serverInfo as Record<string, unknown>)?.version as string | undefined,
    title: (discoverResult?.serverInfo as Record<string, unknown>)?.title as string | undefined,
    protocolVersion: STATELESS_PROTOCOL_VERSION,
    capabilities: (discoverResult?.capabilities as Record<string, unknown>) ?? {},
    instructions: discoverResult?.instructions as string | undefined,
  };
}

export interface StatelessConnectionOptions {
  url: string;
  headers?: Record<string, string>;
  fetchImpl: typeof globalThis.fetch;
  timeoutMs?: number;
  clientInfo?: { name: string; version: string };
  signal?: AbortSignal;
  verbose?: VerboseLogger;
  authProvider?: AuthProvider;
  transportRefusals?: boolean;
  redact?: (text: string) => string;
}

type RequestFn = (method: string, params: Record<string, unknown>) => Promise<unknown>;

function buildStatelessMethods(
  requestFn: RequestFn,
  discoverResult: Record<string, unknown> | null
): Pick<
  McpConnection,
  | 'info'
  | 'listTools'
  | 'callTool'
  | 'listResources'
  | 'listResourceTemplates'
  | 'readResource'
  | 'listPrompts'
  | 'getPrompt'
> {
  let serverInfoCache: ServerInfo | undefined;
  return {
    async info(): Promise<ServerInfo> {
      if (serverInfoCache) return serverInfoCache;
      serverInfoCache = buildServerInfo(discoverResult);
      return serverInfoCache;
    },
    async listTools(): Promise<Tool[]> {
      return ((await requestFn('tools/list', {})) as { tools?: Tool[] } | null)?.tools ?? [];
    },
    async callTool(
      name: string,
      args?: Record<string, unknown>,
      _callOptions?: CallToolOptions
    ): Promise<CallToolResult> {
      const params: Record<string, unknown> = {
        name,
        arguments: args ?? {},
      };
      if (_callOptions?.inputResponses) {
        params._inputResponses = _callOptions.inputResponses;
      }
      const result = (await requestFn('tools/call', params)) as CallToolResult & {
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
        ((await requestFn('resources/list', {})) as { resources?: Resource[] } | null)?.resources ??
        []
      );
    },
    async listResourceTemplates(): Promise<ResourceTemplate[]> {
      return (
        (
          (await requestFn('resources/templates/list', {})) as {
            resourceTemplates?: ResourceTemplate[];
          } | null
        )?.resourceTemplates ?? []
      );
    },
    async readResource(uri: string): Promise<ReadResourceResult> {
      return (await requestFn('resources/read', { uri })) as ReadResourceResult;
    },
    async listPrompts(): Promise<PromptInfo[]> {
      return (
        ((await requestFn('prompts/list', {})) as { prompts?: PromptInfo[] } | null)?.prompts ?? []
      );
    },
    async getPrompt(name: string, args?: Record<string, unknown>): Promise<GetPromptResult> {
      return (await requestFn('prompts/get', {
        name,
        arguments: args ?? {},
      })) as GetPromptResult;
    },
  };
}

export async function createStatelessConnection(
  options: StatelessConnectionOptions
): Promise<McpConnection> {
  const {
    url,
    headers: extraHeaders,
    fetchImpl,
    timeoutMs = 60_000,
    clientInfo = { name: 'mcpcat', version: '0.0.0' },
    signal: externalSignal,
    verbose,
    authProvider,
    transportRefusals,
    redact = (text: string) => text,
  } = options;

  let nextId = 1;
  let negotiatedVersion: string | undefined;

  function buildHeaders(
    method: string,
    params: Record<string, unknown>,
    token?: string
  ): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Mcp-Method': method,
      ...extraHeaders,
    };
    const n = mcpNameForMethod(method, params);
    if (n) h['Mcp-Name'] = n;
    if (negotiatedVersion) h['Mcp-Protocol-Version'] = negotiatedVersion;
    if (token) h['Authorization'] = `Bearer ${token}`;
    return h;
  }

  async function handleErrorStatus(res: Response, method: string): Promise<never> {
    if (res.status === 401 || res.status === 403) {
      const { raw, reason } = await authReason(res, redact);
      if (
        transportRefusals &&
        res.status === 403 &&
        !res.headers.has('www-authenticate') &&
        raw?.startsWith(KERNEL_REFUSAL)
      ) {
        throw new TransportRefusalError(403, reason ?? '');
      }
      if (authProvider) throw new AuthRetryableError(res, reason);
      throw new McpAuthError(res.status, url, reason);
    }
    const text = await res.text();
    let rpc: { code: number; message: string; data?: unknown } | undefined;
    try {
      const p = JSON.parse(text) as JsonRpcResponse;
      if (p.error && typeof p.error.code === 'number') rpc = p.error;
    } catch {}
    if (rpc) throw new StatelessRpcError(rpc.code, rpc.message, rpc.data);
    throw new StatelessHttpError(res.status, res.statusText, method, redact(text).slice(0, 512));
  }

  async function doFetch(
    method: string,
    params: Record<string, unknown>,
    body: string
  ): Promise<{ res: Response; token: string | undefined; detach: () => void }> {
    const token = await authProvider?.token();
    const headers = buildHeaders(method, params, token);
    if (verbose?.enabled) {
      verbose.request(method, body);
      logHeaders(verbose, '>', Object.entries(headers));
    }
    const { controller, stopTimer, detach } = makeAbort(timeoutMs, externalSignal);
    try {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
      if (verbose?.enabled) {
        verbose.http('<', `HTTP/1.1 ${res.status} ${res.statusText}`);
        logHeaders(verbose, '<', res.headers.entries());
      }
      return { res, token, detach };
    } catch (err) {
      detach();
      if (controller.signal.aborted && !externalSignal?.aborted) {
        throw new McpTimeoutError(method, timeoutMs);
      }
      throw err;
    } finally {
      stopTimer();
    }
  }

  async function parseResponse(res: Response, id: number): Promise<unknown> {
    const ct = res.headers.get('content-type') ?? '';
    let frame: JsonRpcResponse;
    if (ct.toLowerCase().includes('text/event-stream')) {
      frame = selectSseFrame(new Uint8Array(await res.arrayBuffer()), id);
    } else {
      frame = (await res.json()) as JsonRpcResponse;
    }
    if (verbose?.enabled) verbose.response(JSON.stringify(frame));
    if (frame.error) {
      throw new StatelessRpcError(frame.error.code, frame.error.message, frame.error.data);
    }
    return frame.result;
  }

  async function handleAuthError(
    err: AuthRetryableError,
    token: string | undefined
  ): Promise<void> {
    if (!authProvider?.onUnauthorized) throw new McpAuthError(err.response.status, url, err.reason);
    try {
      await authProvider.onUnauthorized({
        response: err.response,
        serverUrl: new URL(url),
        fetch: fetchImpl,
        token,
      });
    } catch (authErr) {
      if (authErr instanceof AuthStepUpError || authErr instanceof JerkTimeoutError) throw authErr;
      throw new McpAuthError(err.response.status, url, err.reason);
    }
  }

  async function request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = nextId++;
    const meta: Record<string, unknown> = {
      protocolVersion: negotiatedVersion ?? STATELESS_PROTOCOL_VERSION,
      clientInfo,
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

    for (let attempt = 0; attempt < 2; attempt++) {
      const { res, token, detach } = await doFetch(method, params, body);
      let retry: AuthRetryableError | undefined;
      try {
        if (res.status >= 400) {
          try {
            await handleErrorStatus(res, method);
          } catch (err) {
            if (!(err instanceof AuthRetryableError && attempt === 0)) throw err;
            retry = err;
          }
        }
        if (!retry) return await parseResponse(res, id);
      } finally {
        detach();
      }
      await handleAuthError(retry, token);
    }
    throw new McpAuthError(401, url);
  }

  const discoverResult = (await request('server/discover', {
    protocolVersion: STATELESS_PROTOCOL_VERSION,
  })) as { supportedVersions?: string[] } | null;
  const supported =
    discoverResult?.supportedVersions?.filter((v): v is string => typeof v === 'string') ?? [];
  if (!supported.includes(STATELESS_PROTOCOL_VERSION)) {
    throw new Error(
      `Server does not support ${STATELESS_PROTOCOL_VERSION} (advertised: ${supported.join(', ') || 'none'})`
    );
  }
  negotiatedVersion = STATELESS_PROTOCOL_VERSION;

  const extra = buildStatelessMethods(request, discoverResult as Record<string, unknown> | null);

  return {
    ...extra,
    async close(): Promise<void> {},
  };
}
