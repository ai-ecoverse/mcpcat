import { type ConnectOptions, connect } from '../client/connect.ts';
import type { McpConnection, ServerInfo } from '../client/connection.ts';
import type { Platform } from '../platform/types.ts';
import { secretMasker } from '../render/redact.ts';

export interface ProxyOptions {
  target: string;
  connectOpts: ConnectOptions;
  platform: Platform;
  hiddenHeaders: Set<string>;
}

type RpcId = string | number | null;

type RpcOutcome = { status: number; contentType: string; body: string };

const IDEMPOTENT_METHODS = new Set([
  'initialize',
  'server/discover',
  'tools/list',
  'resources/list',
  'prompts/list',
  'ping',
]);

const PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18'] as const;

const JSON_CT = 'application/json; charset=utf-8';

function readId(value: object): RpcId {
  const id = Object.getOwnPropertyDescriptor(value, 'id')?.value;
  if (typeof id === 'string' || typeof id === 'number' || id === null) return id;
  return null;
}

function readString(value: object, key: string): string | undefined {
  const found = Object.getOwnPropertyDescriptor(value, key)?.value;
  return typeof found === 'string' ? found : undefined;
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function rpcOk(id: RpcId, result: unknown): RpcOutcome {
  return {
    status: 200,
    contentType: JSON_CT,
    body: JSON.stringify({ jsonrpc: '2.0', id, result }),
  };
}

function rpcError(id: RpcId, code: number, message: string): RpcOutcome {
  return {
    status: 200,
    contentType: JSON_CT,
    body: JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }),
  };
}

function scrubValue(value: unknown, scrub: (s: string) => string): unknown {
  if (typeof value === 'string') return scrub(value);
  if (Array.isArray(value)) return value.map((v) => scrubValue(v, scrub));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrubValue(v, scrub);
    }
    return out;
  }
  return value;
}

function translateCapabilities(info: ServerInfo): Record<string, unknown> {
  const caps: Record<string, unknown> = {};
  if (info.capabilities.tools) caps.tools = { listChanged: false };
  if (info.capabilities.resources) caps.resources = { listChanged: false };
  if (info.capabilities.prompts) caps.prompts = { listChanged: false };
  return caps;
}

function buildServerResult(info: ServerInfo, protocolVersion: string): Record<string, unknown> {
  return {
    protocolVersion,
    capabilities: translateCapabilities(info),
    serverInfo: {
      name: info.name ?? 'mcpcat-proxy',
      version: info.version ?? '0.0.0',
      ...(info.title ? { title: info.title } : {}),
    },
    ...(info.instructions ? { instructions: info.instructions } : {}),
  };
}

export function createProxyHandler(options: ProxyOptions): {
  handle: (raw: string) => Promise<RpcOutcome>;
  shutdown: () => Promise<void>;
} {
  let conn: McpConnection | null = null;
  let cachedInfo: ServerInfo | null = null;
  let connecting: Promise<McpConnection> | null = null;
  const scrub = secretMasker(options.hiddenHeaders, '***');

  async function doConnect(): Promise<McpConnection> {
    const c = await connect(options.platform, options.connectOpts);
    cachedInfo = await c.info();
    return c;
  }

  async function getConnection(): Promise<McpConnection> {
    if (conn) return conn;
    if (connecting !== null) return connecting;
    connecting = doConnect();
    try {
      conn = await connecting;
      return conn;
    } finally {
      connecting = null;
    }
  }

  async function reconnect(): Promise<McpConnection> {
    if (conn) {
      try {
        await conn.close();
      } catch {}
    }
    conn = null;
    cachedInfo = null;
    return getConnection();
  }

  function scrubOk(id: RpcId, result: unknown): RpcOutcome {
    return rpcOk(id, scrubValue(result, scrub));
  }

  function scrubErr(id: RpcId, code: number, message: string): RpcOutcome {
    return rpcError(id, code, scrub(message));
  }

  function handleInitialize(id: RpcId, params: unknown): RpcOutcome {
    const requested =
      params && typeof params === 'object'
        ? (Object.getOwnPropertyDescriptor(params, 'protocolVersion')?.value as string | undefined)
        : undefined;
    const pv = PROTOCOL_VERSIONS.find((v) => v === requested) ?? PROTOCOL_VERSIONS[0];
    return scrubOk(id, buildServerResult(cachedInfo!, pv));
  }

  function handleDiscover(id: RpcId): RpcOutcome {
    return scrubOk(id, {
      ...buildServerResult(cachedInfo!, PROTOCOL_VERSIONS[0]),
      supportedVersions: PROTOCOL_VERSIONS,
    });
  }

  async function forwardWithRetry(
    method: string,
    doForward: () => Promise<unknown>,
    id: RpcId
  ): Promise<RpcOutcome> {
    try {
      return scrubOk(id, await doForward());
    } catch (err) {
      if (!IDEMPOTENT_METHODS.has(method)) {
        return scrubErr(id, -32000, (err as Error).message);
      }
      try {
        await reconnect();
        return scrubOk(id, await doForward());
      } catch (retryErr) {
        return scrubErr(id, -32000, (retryErr as Error).message);
      }
    }
  }

  async function handleCall(id: RpcId, params: unknown, c: McpConnection): Promise<RpcOutcome> {
    const name = params && typeof params === 'object' ? readString(params, 'name') : undefined;
    if (!name) return scrubErr(id, -32602, 'tools/call requires a name');
    const args =
      params && typeof params === 'object'
        ? (Object.getOwnPropertyDescriptor(params, 'arguments')?.value as
            | Record<string, unknown>
            | undefined)
        : undefined;
    try {
      return scrubOk(id, await c.callTool(name, args));
    } catch (err) {
      return scrubErr(id, -32000, (err as Error).message);
    }
  }

  async function dispatch(method: string, id: RpcId, params: unknown): Promise<RpcOutcome> {
    try {
      await getConnection();
    } catch (err) {
      if (method === 'ping') return rpcOk(id, {});
      return scrubErr(id, -32000, `upstream connection failed: ${(err as Error).message}`);
    }

    if (method === 'initialize') return handleInitialize(id, params);
    if (method === 'server/discover') return handleDiscover(id);
    if (method === 'ping') return rpcOk(id, {});

    if (method === 'tools/list') {
      return forwardWithRetry(
        method,
        async () => {
          const tools = await (await getConnection()).listTools();
          return { tools };
        },
        id
      );
    }

    if (method === 'tools/call') return handleCall(id, params, conn!);

    return scrubErr(id, -32601, `Method not found: ${method}`);
  }

  async function handle(raw: string): Promise<RpcOutcome> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return rpcError(null, -32700, 'Parse error');
    }
    if (Array.isArray(parsed)) return rpcError(null, -32600, 'Batch requests are not supported');
    if (!parsed || typeof parsed !== 'object') return rpcError(null, -32600, 'Invalid request');
    const method = readString(parsed, 'method');
    if (!method) return rpcError(readId(parsed), -32600, 'Invalid request');
    if (!hasOwn(parsed, 'id')) return { status: 202, contentType: 'text/plain', body: '' };
    const id = readId(parsed);
    const params = Object.getOwnPropertyDescriptor(parsed, 'params')?.value;
    return dispatch(method, id, params);
  }

  async function shutdown(): Promise<void> {
    if (conn) {
      try {
        await conn.close();
      } catch {}
      conn = null;
    }
  }

  return { handle, shutdown };
}
