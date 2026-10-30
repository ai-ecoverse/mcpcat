import { completeModernOutcome, modernDiscoverResult } from '../client/modern.ts';
import type { JsonObjectSchema } from './catalog.ts';

export interface RpcTool {
  name: string;
  description: string;
  inputSchema: JsonObjectSchema;
  annotations?: Record<string, boolean | string>;
}

export interface ToolRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  meta?: Record<string, unknown>;
}

export interface ToolListing {
  tools: RpcTool[];
  hidden?: Record<string, string>;
  hint?: string;
  error?: string;
}

export type ToolSource = RpcTool[] | (() => Promise<ToolListing>);

export interface RpcOutcome {
  status: number;
  contentType: string;
  body: string;
}

const PROTOCOL_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18'] as const;
const OUTPUT_CAP = 1_048_576;
const JSON_CT = 'application/json; charset=utf-8';

type RpcId = string | number | null;

export async function handleJsonRpc(
  raw: string,
  source: ToolSource,
  call: (name: string, args: unknown) => Promise<ToolRunResult>,
  serverName: string,
  serverVersion: string,
  listChanged = false,
  extensions?: Record<string, unknown>
): Promise<RpcOutcome> {
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
  return completeModernOutcome(
    await dispatch(id, method, params, source, call, serverName, serverVersion, {
      listChanged,
      extensions,
    }),
    params
  );
}

async function dispatch(
  id: RpcId,
  method: string,
  params: unknown,
  source: ToolSource,
  call: (name: string, args: unknown) => Promise<ToolRunResult>,
  serverName: string,
  serverVersion: string,
  caps: { listChanged: boolean; extensions?: Record<string, unknown> }
): Promise<RpcOutcome> {
  if (method === 'initialize')
    return rpcOk(id, initializeResult(params, serverName, serverVersion, caps.listChanged));
  if (method === 'server/discover')
    return rpcOk(id, discoverResult(serverName, serverVersion, caps));
  if (method === 'ping') return rpcOk(id, {});
  if (method === 'tools/list' || method === 'tools/call') {
    const listing = Array.isArray(source) ? { tools: source } : await source();
    if (listing.error) return rpcError(id, -32000, listing.error);
    if (method === 'tools/call') return toolCall(id, params, listing, call);
    const hidden = listing.hidden && Object.keys(listing.hidden).length > 0 ? listing.hidden : null;
    const meta = {
      ...(hidden ? { 'io.mcpcat/hidden': hidden } : {}),
      ...(listing.hint ? { 'io.mcpcat/hint': listing.hint } : {}),
    };
    return rpcOk(id, {
      tools: listing.tools,
      ...(Object.keys(meta).length > 0 ? { _meta: meta } : {}),
    });
  }
  return rpcError(id, -32601, `Method not found: ${method}`);
}

async function toolCall(
  id: RpcId,
  params: unknown,
  { tools, hidden, hint }: ToolListing,
  call: (name: string, args: unknown) => Promise<ToolRunResult>
): Promise<RpcOutcome> {
  const name = params && typeof params === 'object' ? readString(params, 'name') : undefined;
  if (!name) return rpcError(id, -32602, 'tools/call requires a name');
  if (!tools.some((tool) => tool.name === name)) {
    const why = hidden && Object.hasOwn(hidden, name) ? hidden[name] : hint;
    return rpcError(id, -32602, why ? `Unknown tool: ${name}: ${why}` : `Unknown tool: ${name}`);
  }
  const args =
    params && typeof params === 'object'
      ? Object.getOwnPropertyDescriptor(params, 'arguments')?.value
      : undefined;
  try {
    const result = await call(name, args);
    return rpcOk(id, toolResult(result));
  } catch (err) {
    const message = err instanceof Error ? err.message : 'tool call failed';
    return rpcError(id, -32000, message);
  }
}

function toolResult(result: ToolRunResult): {
  content: { type: 'text'; text: string }[];
  isError: boolean;
  structuredContent: { stdout: string; stderr: string; exitCode: number };
  _meta?: Record<string, unknown>;
} {
  const stdout = cap(result.stdout);
  const stderr = cap(result.stderr);
  const text = stderr ? (stdout ? `${stdout}\n${stderr}` : stderr) : stdout;
  return {
    content: [{ type: 'text', text }],
    isError: result.exitCode !== 0,
    structuredContent: { stdout, stderr, exitCode: result.exitCode },
    ...(result.meta ? { _meta: result.meta } : {}),
  };
}

function initializeResult(
  params: unknown,
  serverName: string,
  serverVersion: string,
  listChanged: boolean
): {
  protocolVersion: string;
  capabilities: { tools: { listChanged: boolean } };
  serverInfo: { name: string; version: string };
} {
  const requested =
    params && typeof params === 'object' ? readString(params, 'protocolVersion') : undefined;
  const protocolVersion =
    PROTOCOL_VERSIONS.find((version) => version === requested) ?? PROTOCOL_VERSIONS[0];
  return {
    protocolVersion,
    capabilities: { tools: { listChanged } },
    serverInfo: { name: serverName, version: serverVersion },
  };
}

function discoverResult(
  serverName: string,
  serverVersion: string,
  caps: { listChanged: boolean; extensions?: Record<string, unknown> }
): Record<string, unknown> {
  return modernDiscoverResult(
    PROTOCOL_VERSIONS,
    {
      tools: { listChanged: caps.listChanged },
      ...(caps.extensions ? { extensions: caps.extensions } : {}),
    },
    { name: serverName, version: serverVersion }
  );
}

function cap(value: string): string {
  if (value.length <= OUTPUT_CAP) return value;
  const half = Math.floor(OUTPUT_CAP / 2);
  const cut = value.length - OUTPUT_CAP;
  return `${value.slice(0, half)}\n… ${cut} characters cut …\n${value.slice(value.length - half)}`;
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
