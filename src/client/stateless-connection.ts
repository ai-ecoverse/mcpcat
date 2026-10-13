import type { CallToolResult, Tool } from '@earendil-works/pi-mcp';
import type { McpConnection, ServerInfo } from './connection.ts';

export const STATELESS_PROTOCOL_VERSION = '2026-07-28';

interface JsonRpcResponse {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
  method?: string;
}

interface SseFrame {
  id?: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
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

function selectSseFrame(body: Uint8Array, targetId: number): SseFrame {
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

function _headerGet(headers: Record<string, string>, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v;
  }
  return undefined;
}

export interface StatelessConnectionOptions {
  url: string;
  headers?: Record<string, string>;
  fetchImpl: typeof globalThis.fetch;
  timeoutMs?: number;
  clientInfo?: { name: string; version: string };
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
  } = options;

  let nextId = 1;
  let negotiatedVersion: string | undefined;

  async function request(method: string, params: unknown): Promise<unknown> {
    const id = nextId++;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      ...extraHeaders,
    };

    if (negotiatedVersion) {
      headers['Mcp-Protocol-Version'] = negotiatedVersion;
    }

    const meta: Record<string, unknown> = {
      protocolVersion: negotiatedVersion ?? STATELESS_PROTOCOL_VERSION,
      clientInfo,
    };

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id,
      method,
      params: { ...(params as Record<string, unknown>), _meta: meta },
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 401) {
      throw new StatelessHttpError(401, 'Unauthorized', method, '');
    }

    if (res.status >= 400) {
      const text = await res.text();
      let rpcError: { code: number; message: string; data?: unknown } | undefined;
      try {
        const parsed = JSON.parse(text) as JsonRpcResponse;
        if (parsed.error && typeof parsed.error.code === 'number') {
          rpcError = parsed.error;
        }
      } catch {}
      if (rpcError) {
        throw new StatelessRpcError(rpcError.code, rpcError.message, rpcError.data);
      }
      throw new StatelessHttpError(res.status, res.statusText, method, text.slice(0, 512));
    }

    const ct = res.headers.get('content-type') ?? '';
    let frame: JsonRpcResponse;
    if (ct.toLowerCase().includes('text/event-stream')) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      frame = selectSseFrame(bytes, id) as JsonRpcResponse;
    } else {
      frame = (await res.json()) as JsonRpcResponse;
    }

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
      const result = discoverResult as Record<string, unknown> | null;
      serverInfoCache = {
        name: (result?.serverInfo as Record<string, unknown>)?.name as string | undefined,
        version: (result?.serverInfo as Record<string, unknown>)?.version as string | undefined,
        title: (result?.serverInfo as Record<string, unknown>)?.title as string | undefined,
        protocolVersion: STATELESS_PROTOCOL_VERSION,
        capabilities: (result?.capabilities as Record<string, unknown>) ?? {},
        instructions: result?.instructions as string | undefined,
      };
      return serverInfoCache;
    },

    async listTools(): Promise<Tool[]> {
      const result = (await request('tools/list', {})) as { tools?: Tool[] } | null;
      return result?.tools ?? [];
    },

    async callTool(name: string, args?: Record<string, unknown>): Promise<CallToolResult> {
      const result = await request('tools/call', { name, arguments: args ?? {} });
      return result as CallToolResult;
    },

    async close(): Promise<void> {},
  };
}
