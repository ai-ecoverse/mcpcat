import type { McpServerConfig } from './types.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((v) => typeof v === 'string');
}

export interface ImportResult {
  servers: Array<{ name: string; config: McpServerConfig }>;
  errors: string[];
}

function tryParse(text: string): { parsed: unknown; error?: string } {
  try {
    return { parsed: JSON.parse(text) };
  } catch (e) {
    return { parsed: undefined, error: `not valid JSON: ${(e as Error).message}` };
  }
}

function filterNames(
  entries: Iterable<[string, unknown]>,
  names?: string[]
): Array<[string, unknown]> {
  const result: Array<[string, unknown]> = [];
  for (const [name, value] of entries) {
    if (names && names.length > 0 && !names.includes(name)) continue;
    result.push([name, value]);
  }
  return result;
}

function replaceInputVars(value: string): string {
  return value.replace(
    /\$\{input:([^}]+)\}/g,
    (_, name: string) => `\${${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}}`
  );
}

export function importClaude(text: string, names?: string[]): ImportResult {
  const result: ImportResult = { servers: [], errors: [] };
  const { parsed, error } = tryParse(text);
  if (error) {
    result.errors.push(error);
    return result;
  }
  if (!isRecord(parsed)) {
    result.errors.push('expected an object');
    return result;
  }
  const mcpServers = parsed.mcpServers;
  if (!isRecord(mcpServers)) {
    result.errors.push('no "mcpServers" object');
    return result;
  }
  for (const [name, entry] of filterNames(Object.entries(mcpServers), names)) {
    if (!isRecord(entry)) {
      result.errors.push(`${name}: not an object`);
      continue;
    }
    result.servers.push({ name, config: entry as unknown as McpServerConfig });
  }
  return result;
}

export function importVSCode(text: string, names?: string[]): ImportResult {
  const result: ImportResult = { servers: [], errors: [] };
  const { parsed, error } = tryParse(text);
  if (error) {
    result.errors.push(error);
    return result;
  }
  if (!isRecord(parsed)) {
    result.errors.push('expected an object');
    return result;
  }
  const servers = parsed.servers ?? parsed.mcpServers;
  if (!isRecord(servers)) {
    result.errors.push('no "servers" or "mcpServers" object');
    return result;
  }
  for (const [name, entry] of filterNames(Object.entries(servers), names)) {
    if (!isRecord(entry)) {
      result.errors.push(`${name}: not an object`);
      continue;
    }
    result.servers.push({ name, config: convertVSCodeEntry(entry) });
  }
  return result;
}

function convertVSCodeEntry(entry: Record<string, unknown>): McpServerConfig {
  const config: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(entry)) {
    if (key === 'type' || key === 'command' || key === 'args' || key === 'cwd' || key === 'url') {
      config[key] = value;
    } else if (key === 'headers' && isStringRecord(value)) {
      const headers: Record<string, string> = {};
      for (const [h, v] of Object.entries(value)) headers[h] = replaceInputVars(v);
      config.headers = headers;
    } else if (key === 'env' && isStringRecord(value)) {
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(value)) env[k] = replaceInputVars(v);
      config.env = env;
    } else {
      config[key] = value;
    }
  }
  return config as unknown as McpServerConfig;
}

export function importSixServers(text: string, names?: string[]): ImportResult {
  const result: ImportResult = { servers: [], errors: [] };
  const { parsed, error } = tryParse(text);
  if (error) {
    result.errors.push(error);
    return result;
  }
  if (!isRecord(parsed)) {
    result.errors.push('expected an object');
    return result;
  }
  const servers = parsed.servers;
  if (!isRecord(servers)) {
    result.errors.push('no "servers" object');
    return result;
  }
  for (const [name, entry] of filterNames(Object.entries(servers), names)) {
    if (!isRecord(entry)) {
      result.errors.push(`${name}: not an object`);
      continue;
    }
    const config: Record<string, unknown> = {};
    if (typeof entry.url === 'string') config.url = entry.url;
    if (isStringRecord(entry.headers)) config.headers = entry.headers;
    if (typeof entry.exposure === 'string') config.exposure = entry.exposure;
    if (isRecord(entry.toolExposure)) config.toolExposure = entry.toolExposure;
    result.servers.push({ name, config: config as unknown as McpServerConfig });
  }
  return result;
}

export function importCodexToml(text: string, names?: string[]): ImportResult {
  const result: ImportResult = { servers: [], errors: [] };
  const sections = parseTomlSections(text);
  for (const [sectionName, fields] of sections) {
    const prefix = 'mcp_servers.';
    if (!sectionName.startsWith(prefix)) continue;
    const name = sectionName.slice(prefix.length);
    if (names && names.length > 0 && !names.includes(name)) continue;
    const config: Record<string, unknown> = {};
    if (fields.command) config.command = fields.command;
    if (fields.args) config.args = fields.args;
    if (fields.url) config.url = fields.url;
    if (fields.env && isRecord(fields.env)) config.env = fields.env;
    result.servers.push({ name, config: config as unknown as McpServerConfig });
  }
  return result;
}

function parseTomlSections(text: string): Array<[string, Record<string, unknown>]> {
  const sections: Array<[string, Record<string, unknown>]> = [];
  let current: Record<string, unknown> | undefined;
  let currentName = '';
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#') || trimmed === '') continue;
    const sectionMatch = /^\[([^\]]+)\]/.exec(trimmed);
    if (sectionMatch) {
      if (current) sections.push([currentName, current]);
      currentName = sectionMatch[1].trim();
      current = {};
      continue;
    }
    if (!current) continue;
    const kvMatch = /^(\w+)\s*=\s*(.+)/.exec(trimmed);
    if (kvMatch) {
      current[kvMatch[1]] = parseTomlValue(kvMatch[2].trim());
    }
  }
  if (current) sections.push([currentName, current]);
  return sections;
}

function parseTomlValue(raw: string): unknown {
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1);
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  if (raw.startsWith('[')) {
    try {
      return JSON.parse(raw.replace(/'/g, '"'));
    } catch {
      return raw;
    }
  }
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  const num = Number(raw);
  if (!Number.isNaN(num)) return num;
  return raw;
}

function convertOpenCodeLocal(entry: Record<string, unknown>): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  if (Array.isArray(entry.command) && entry.command.length > 0) {
    config.command = entry.command[0];
    if (entry.command.length > 1) config.args = entry.command.slice(1);
  } else if (typeof entry.command === 'string') {
    config.command = entry.command;
  }
  if (isRecord(entry.environment)) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(entry.environment)) {
      if (typeof v === 'string')
        env[k] = v.replace(/\{env:([^}]+)\}/g, (_, n: string) => `\${${n}}`);
    }
    config.env = env;
  }
  return config;
}

function convertOpenCodeRemote(entry: Record<string, unknown>): Record<string, unknown> {
  const config: Record<string, unknown> = {};
  config.url = entry.url;
  if (isStringRecord(entry.headers)) config.headers = entry.headers;
  return config;
}

export function importOpenCode(text: string, names?: string[]): ImportResult {
  const result: ImportResult = { servers: [], errors: [] };
  const { parsed, error } = tryParse(text);
  if (error) {
    result.errors.push(error);
    return result;
  }
  if (!isRecord(parsed)) {
    result.errors.push('expected an object');
    return result;
  }
  const mcpServers = parsed.mcpServers ?? parsed.mcp;
  if (!isRecord(mcpServers)) {
    result.errors.push('no mcp servers found');
    return result;
  }
  for (const [name, entry] of filterNames(Object.entries(mcpServers), names)) {
    if (!isRecord(entry)) {
      result.errors.push(`${name}: not an object`);
      continue;
    }
    const isLocal = entry.type === 'local' || entry.command;
    const config = isLocal ? convertOpenCodeLocal(entry) : convertOpenCodeRemote(entry);
    result.servers.push({ name, config: config as unknown as McpServerConfig });
  }
  return result;
}

export function detectFormat(text: string, filename: string): string {
  if (filename.endsWith('.toml')) return 'codex';
  if (filename.includes('servers.json')) return 'six';
  if (filename.includes('.vscode')) return 'vscode';
  try {
    const parsed = JSON.parse(text);
    if (isRecord(parsed)) {
      if (parsed.servers && isRecord(parsed.servers) && parsed.version !== undefined) return 'six';
      if (parsed.servers && isRecord(parsed.servers)) return 'vscode';
      if (parsed.mcpServers) return 'claude';
      if (parsed.mcp) return 'opencode';
    }
  } catch {}
  if (text.includes('[mcp_servers.')) return 'codex';
  return 'claude';
}

export function importFile(text: string, filename: string, names?: string[]): ImportResult {
  const format = detectFormat(text, filename);
  switch (format) {
    case 'claude':
      return importClaude(text, names);
    case 'vscode':
      return importVSCode(text, names);
    case 'six':
      return importSixServers(text, names);
    case 'codex':
      return importCodexToml(text, names);
    case 'opencode':
      return importOpenCode(text, names);
    default:
      return importClaude(text, names);
  }
}
