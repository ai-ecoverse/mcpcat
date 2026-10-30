import type { McpConfigProblem, McpExposure, McpServerConfig } from './types.ts';

const SERVER_NAME = /^[A-Za-z0-9_-]+$/;
const EXPOSURES: readonly McpExposure[] = ['codemode', 'deferred', 'direct', 'hidden'];
const EXPOSURE_ALIASES: Record<string, McpExposure> = { 'codemode-deferred': 'codemode' };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((v) => typeof v === 'string');
}

function isExposure(value: unknown): value is McpExposure {
  return typeof value === 'string' && (EXPOSURES as readonly string[]).includes(value);
}

function resolveAlias(value: unknown): unknown {
  return typeof value === 'string' ? (EXPOSURE_ALIASES[value] ?? value) : value;
}

function resolveAliases(value: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...value };
  if (out.exposure !== undefined) out.exposure = resolveAlias(out.exposure);
  if (isRecord(out.toolExposure)) {
    out.toolExposure = Object.fromEntries(
      Object.entries(out.toolExposure).map(([k, v]) => [k, resolveAlias(v)])
    );
  }
  return out;
}

function fail(server: string, message: string, field?: string): McpConfigProblem {
  return { server, ...(field ? { field } : {}), message };
}

function validateCommon(
  name: string,
  value: Record<string, unknown>
): McpConfigProblem | undefined {
  const exposures = EXPOSURES.map((e) => `"${e}"`).join(', ');
  if (value.exposure !== undefined && !isExposure(value.exposure))
    return fail(name, `exposure must be one of ${exposures}`, 'exposure');
  if (value.toolExposure !== undefined) {
    if (!isRecord(value.toolExposure))
      return fail(name, 'toolExposure must map tool names to exposures', 'toolExposure');
    for (const [tool, exp] of Object.entries(value.toolExposure))
      if (!isExposure(exp))
        return fail(
          name,
          `toolExposure "${tool}" must be one of ${exposures}`,
          `toolExposure.${tool}`
        );
  }
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean')
    return fail(name, 'enabled must be a boolean', 'enabled');
  if (value.description !== undefined && typeof value.description !== 'string')
    return fail(name, 'description must be a string', 'description');
  if (value.timeout !== undefined && (typeof value.timeout !== 'number' || !(value.timeout > 0)))
    return fail(name, 'timeout must be a positive number of seconds', 'timeout');
  return undefined;
}

function validateOAuthFields(
  name: string,
  oauth: Record<string, unknown>
): McpConfigProblem | undefined {
  if (oauth.clientId !== undefined && typeof oauth.clientId !== 'string')
    return fail(name, 'oauth.clientId must be a string', 'oauth.clientId');
  if (oauth.clientSecret !== undefined && typeof oauth.clientSecret !== 'string')
    return fail(name, 'oauth.clientSecret must be a string', 'oauth.clientSecret');
  const port = oauth.callbackPort;
  if (
    port !== undefined &&
    (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535)
  )
    return fail(name, 'oauth.callbackPort must be a port number', 'oauth.callbackPort');
  if (oauth.callbackUrl !== undefined && typeof oauth.callbackUrl !== 'string')
    return fail(name, 'oauth.callbackUrl must be a string', 'oauth.callbackUrl');
  if (oauth.scope !== undefined && typeof oauth.scope !== 'string')
    return fail(name, 'oauth.scope must be a string', 'oauth.scope');
  if (
    oauth.clientName !== undefined &&
    (typeof oauth.clientName !== 'string' || !oauth.clientName.trim())
  )
    return fail(name, 'oauth.clientName must be a non-empty string', 'oauth.clientName');
  return undefined;
}

function validateOAuthExtras(
  name: string,
  oauth: Record<string, unknown>
): McpConfigProblem | undefined {
  if (
    oauth.clientRegistration !== undefined &&
    oauth.clientRegistration !== 'dcr' &&
    oauth.clientRegistration !== 'cimd'
  )
    return fail(
      name,
      'oauth.clientRegistration must be "dcr" or "cimd"',
      'oauth.clientRegistration'
    );
  if (oauth.authServerMetadataUrl !== undefined) {
    const url =
      typeof oauth.authServerMetadataUrl === 'string' && URL.canParse(oauth.authServerMetadataUrl)
        ? new URL(oauth.authServerMetadataUrl)
        : undefined;
    if (
      !url ||
      (url.protocol !== 'https:' &&
        !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    )
      return fail(
        name,
        'oauth.authServerMetadataUrl must be an https URL',
        'oauth.authServerMetadataUrl'
      );
  }
  return undefined;
}

function validateOAuth(name: string, value: Record<string, unknown>): McpConfigProblem | undefined {
  const { oauth } = value;
  if (oauth === undefined) return undefined;
  if (!isRecord(oauth)) return fail(name, 'oauth must be an object', 'oauth');
  return validateOAuthFields(name, oauth) ?? validateOAuthExtras(name, oauth);
}

function validateHttpServer(
  name: string,
  value: Record<string, unknown>
): McpConfigProblem | McpServerConfig | undefined {
  if (
    typeof value.url !== 'string' ||
    (value.type !== undefined && value.type !== 'http' && value.type !== 'streamable-http')
  )
    return undefined;
  if (!URL.canParse(value.url) || !/^https?:$/.test(new URL(value.url).protocol))
    return fail(name, 'url must be an http or https URL', 'url');
  if (value.headers !== undefined && !isStringRecord(value.headers))
    return fail(name, 'headers must map names to strings', 'headers');
  const oauthErr = validateOAuth(name, value);
  if (oauthErr) return oauthErr;
  return value as unknown as McpServerConfig;
}

function validateStdioServer(
  name: string,
  value: Record<string, unknown>
): McpConfigProblem | McpServerConfig | undefined {
  if (typeof value.command !== 'string' || (value.type !== undefined && value.type !== 'stdio'))
    return undefined;
  if (
    value.args !== undefined &&
    !(Array.isArray(value.args) && value.args.every((a: unknown) => typeof a === 'string'))
  )
    return fail(name, 'args must be an array of strings', 'args');
  if (value.env !== undefined && !isStringRecord(value.env))
    return fail(name, 'env must map names to strings', 'env');
  if (value.cwd !== undefined && typeof value.cwd !== 'string')
    return fail(name, 'cwd must be a string', 'cwd');
  return value as unknown as McpServerConfig;
}

export function validateServer(name: string, raw: unknown): McpServerConfig | McpConfigProblem {
  if (!SERVER_NAME.test(name))
    return fail(name, `invalid server name "${name}" (use letters, digits, "_" and "-")`);
  if (!isRecord(raw)) return fail(name, 'must be an object');
  const value = resolveAliases(raw);

  if (value.type === 'sse')
    return fail(name, 'legacy SSE transport is not supported; use the streamable HTTP URL', 'type');

  const common = validateCommon(name, value);
  if (common) return common;

  const httpResult = validateHttpServer(name, value);
  if (httpResult) return httpResult;

  const stdioResult = validateStdioServer(name, value);
  if (stdioResult) return stdioResult;

  if (
    value.type !== undefined &&
    !['http', 'streamable-http', 'stdio'].includes(value.type as string)
  )
    return fail(name, 'type must be "stdio", "http", or "streamable-http"', 'type');

  return fail(name, 'needs a "url" or "command"');
}

export function isOverride(value: Record<string, unknown>): boolean {
  return value.command === undefined && value.url === undefined && value.type === undefined;
}

export function canonical(name: string): string {
  return name.replace(/-/g, '_');
}

export function lookupKey(name: string): string {
  return name.replace(/[-_]/g, '').toLowerCase();
}

export interface ParsedMcpFile {
  servers: Array<{ name: string; config: McpServerConfig }>;
  overrides: Array<{ name: string; raw: Record<string, unknown> }>;
  problems: McpConfigProblem[];
  autoEnableCodemode?: boolean;
}

export function parseMcpJson(text: string): ParsedMcpFile {
  const result: ParsedMcpFile = { servers: [], overrides: [], problems: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    result.problems.push({ message: `not valid JSON: ${(error as Error).message}` });
    return result;
  }
  if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers))) {
    result.problems.push({ message: 'mcpServers must be an object' });
    return result;
  }
  if (typeof parsed.autoEnableCodemode === 'boolean')
    result.autoEnableCodemode = parsed.autoEnableCodemode;
  else if (parsed.autoEnableCodemode !== undefined)
    result.problems.push({ message: 'autoEnableCodemode must be a boolean' });

  const seen = new Set<string>();
  for (const [name, raw] of Object.entries((parsed.mcpServers ?? {}) as Record<string, unknown>)) {
    if (!SERVER_NAME.test(name)) {
      result.problems.push(
        fail(name, `invalid server name "${name}" (use letters, digits, "_" and "-")`)
      );
      continue;
    }
    if (seen.has(canonical(name))) {
      result.problems.push(
        fail(name, 'names that differ only in "-" and "_" count as the same server')
      );
      continue;
    }
    seen.add(canonical(name));
    if (isRecord(raw) && isOverride(raw)) {
      result.overrides.push({ name, raw });
      continue;
    }
    const checked = validateServer(name, raw);
    if ('message' in checked) {
      result.problems.push(checked);
      continue;
    }
    result.servers.push({ name, config: checked });
  }
  return result;
}
