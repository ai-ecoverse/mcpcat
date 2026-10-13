import type { CallToolResult, Tool } from '@earendil-works/pi-mcp';
import type { VerboseLogger } from '../cli/verbose.ts';
import type { CallToolOptions, McpConnection, ServerInfo } from './connection.ts';

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
  constructor(status: number, target: string) {
    super(`HTTP ${status}: authentication required. Run: mcpcat login ${target}`);
    this.name = 'McpAuthError';
    this.status = status;
    this.target = target;
  }
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

export interface StatelessConnectionOptions {
  url: string;
  headers?: Record<string, string>;
  fetchImpl: typeof globalThis.fetch;
  timeoutMs?: number;
  clientInfo?: { name: string; version: string };
  signal?: AbortSignal;
  verbose?: VerboseLogger;
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
  } = options;

  let nextId = 1;
  let negotiatedVersion: string | undefined;

  function buildHeaders(method: string, params: Record<string, unknown>): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'Mcp-Method': method,
      ...extraHeaders,
    };
    const n = mcpNameForMethod(method, params);
    if (n) h['Mcp-Name'] = n;
    if (negotiatedVersion) h['Mcp-Protocol-Version'] = negotiatedVersion;
    return h;
  }

  function makeAbort(): {
    controller: AbortController;
    timer: ReturnType<typeof setTimeout>;
  } {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (externalSignal) {
      if (externalSignal.aborted) {
        clearTimeout(timer);
        controller.abort();
      } else {
        externalSignal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            controller.abort();
          },
          { once: true }
        );
      }
    }
    return { controller, timer };
  }

  function logHeaders(dir: '>' | '<', entries: Iterable<[string, string]>): void {
    if (!verbose?.enabled) return;
    for (const [k, v] of entries) {
      if (dir === '>') verbose.headerOut(k, v);
      else verbose.headerIn(k, v);
    }
  }

  async function handleErrorStatus(res: Response, method: string): Promise<never> {
    if (res.status === 401 || res.status === 403) throw new McpAuthError(res.status, url);
    const text = await res.text();
    let rpc: { code: number; message: string; data?: unknown } | undefined;
    try {
      const p = JSON.parse(text) as JsonRpcResponse;
      if (p.error && typeof p.error.code === 'number') rpc = p.error;
    } catch {}
    if (rpc) throw new StatelessRpcError(rpc.code, rpc.message, rpc.data);
    throw new StatelessHttpError(res.status, res.statusText, method, text.slice(0, 512));
  }

  async function request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const id = nextId++;
    const headers = buildHeaders(method, params);
    const meta: Record<string, unknown> = {
      protocolVersion: negotiatedVersion ?? STATELESS_PROTOCOL_VERSION,
      clientInfo,
    };
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params: { ...params, _meta: meta },
    });

    if (verbose?.enabled) {
      verbose.request(method, body);
      logHeaders('>', Object.entries(headers));
    }

    const { controller, timer } = makeAbort();
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
    } catch (err) {
      clearTimeout(timer);
      if (controller.signal.aborted && !externalSignal?.aborted) {
        throw new McpTimeoutError(method, timeoutMs);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (verbose?.enabled) {
      verbose.http('<', `HTTP/1.1 ${res.status} ${res.statusText}`);
      logHeaders('<', res.headers.entries());
    }
    if (res.status >= 400) await handleErrorStatus(res, method);

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

  const discoverResult = (await request('server/discover', {
    protocolVersion: STATELESS_PROTOCOL_VERSION,
  })) as { supportedVersions?: string[] } | null;
  const supported = Array.isArray(discoverResult?.supportedVersions)
    ? discoverResult.supportedVersions.filter((v): v is string => typeof v === 'string')
    : [];
  if (!supported.includes(STATELESS_PROTOCOL_VERSION)) {
    throw new Error(
      `Server does not support ${STATELESS_PROTOCOL_VERSION} (advertised: ${supported.join(', ') || 'none'})`
    );
  }
  negotiatedVersion = STATELESS_PROTOCOL_VERSION;

  let serverInfoCache: ServerInfo | undefined;

  return {
    async info(): Promise<ServerInfo> {
      if (serverInfoCache) return serverInfoCache;
      const r = discoverResult as Record<string, unknown> | null;
      serverInfoCache = {
        name: (r?.serverInfo as Record<string, unknown>)?.name as string | undefined,
        version: (r?.serverInfo as Record<string, unknown>)?.version as string | undefined,
        title: (r?.serverInfo as Record<string, unknown>)?.title as string | undefined,
        protocolVersion: STATELESS_PROTOCOL_VERSION,
        capabilities: (r?.capabilities as Record<string, unknown>) ?? {},
        instructions: r?.instructions as string | undefined,
      };
      return serverInfoCache;
    },
    async listTools(): Promise<Tool[]> {
      return ((await request('tools/list', {})) as { tools?: Tool[] } | null)?.tools ?? [];
    },
    async callTool(
      name: string,
      args?: Record<string, unknown>,
      _callOptions?: CallToolOptions
    ): Promise<CallToolResult> {
      const result = (await request('tools/call', {
        name,
        arguments: args ?? {},
      })) as CallToolResult & { resultType?: string };
      if ((result.resultType ?? 'complete') === 'input_required') {
        throw new InputRequiredError(
          JSON.stringify({ name, arguments: args ?? {}, result }, null, 2)
        );
      }
      return result;
    },
    async close(): Promise<void> {},
  };
}
