export const MODERN_PROTOCOL_VERSION = '2026-07-28';

export const META_PROTOCOL_VERSION = 'io.modelcontextprotocol/protocolVersion';
export const META_CLIENT_INFO = 'io.modelcontextprotocol/clientInfo';
export const META_CLIENT_CAPABILITIES = 'io.modelcontextprotocol/clientCapabilities';
export const META_SERVER_INFO = 'io.modelcontextprotocol/serverInfo';

export const HEADER_MISMATCH = -32020;
export const MISSING_REQUIRED_CLIENT_CAPABILITY = -32021;
export const UNSUPPORTED_PROTOCOL_VERSION = -32022;

const MODERN_ERROR_CODES = new Set([
  HEADER_MISMATCH,
  MISSING_REQUIRED_CLIENT_CAPABILITY,
  UNSUPPORTED_PROTOCOL_VERSION,
]);

export function isModernErrorCode(code: number): boolean {
  return MODERN_ERROR_CODES.has(code);
}

export const TASKS_EXTENSION = 'io.modelcontextprotocol/tasks';
export const EVENTS_EXTENSION = 'io.modelcontextprotocol/events';
export const META_SUBSCRIPTION_ID = 'io.modelcontextprotocol/subscriptionId';

export function modernRequestMeta(
  protocolVersion: string,
  clientInfo: { name: string; version: string },
  capabilities: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    [META_PROTOCOL_VERSION]: protocolVersion,
    [META_CLIENT_INFO]: clientInfo,
    [META_CLIENT_CAPABILITIES]: capabilities,
  };
}

export function modernRequestParams(
  params: Record<string, unknown>,
  protocolVersion: string,
  clientInfo: { name: string; version: string }
): Record<string, unknown> {
  const { _inputResponses, _tasks, _events, ...rest } = params;
  const out: Record<string, unknown> = { ...rest };
  if (_inputResponses) out.inputResponses = _inputResponses;
  const extensions: Record<string, unknown> = {};
  if (_tasks) extensions[TASKS_EXTENSION] = {};
  if (_events) extensions[EVENTS_EXTENSION] = {};
  const capabilities = Object.keys(extensions).length > 0 ? { extensions } : {};
  out._meta = modernRequestMeta(protocolVersion, clientInfo, capabilities);
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const c = i + 2 < bytes.length ? bytes[i + 2] : 0;
    const n = (a << 16) | (b << 8) | c;
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? B64[n & 63] : '=';
  }
  return out;
}

export function encodeHeaderValue(value: string): string {
  const safe =
    /^[\x20-\x7e\t]*$/.test(value) &&
    value.trim() === value &&
    !(value.startsWith('=?base64?') && value.endsWith('?='));
  return safe ? value : `=?base64?${base64Utf8(value)}?=`;
}

export function isModernRequest(params: unknown): boolean {
  if (!params || typeof params !== 'object') return false;
  const meta = Object.getOwnPropertyDescriptor(params, '_meta')?.value;
  if (!meta || typeof meta !== 'object') return false;
  return typeof Object.getOwnPropertyDescriptor(meta, META_PROTOCOL_VERSION)?.value === 'string';
}

export function completeModernOutcome<T extends { status: number; body: string }>(
  outcome: T,
  params: unknown
): T {
  if (outcome.status !== 200 || !isModernRequest(params)) return outcome;
  const frame = JSON.parse(outcome.body) as { result?: unknown };
  const result = frame.result;
  if (!result || typeof result !== 'object' || Array.isArray(result)) return outcome;
  if (Object.hasOwn(result, 'resultType')) return outcome;
  frame.result = { resultType: 'complete', ...result };
  return { ...outcome, body: JSON.stringify(frame) };
}

export function modernDiscoverResult(
  supportedVersions: readonly string[],
  capabilities: Record<string, unknown>,
  serverInfo: Record<string, unknown>,
  instructions?: string
): Record<string, unknown> {
  return {
    resultType: 'complete',
    supportedVersions,
    capabilities,
    serverInfo,
    ...(instructions ? { instructions } : {}),
    _meta: { [META_SERVER_INFO]: serverInfo },
  };
}
