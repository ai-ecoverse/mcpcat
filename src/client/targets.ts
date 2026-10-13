import type { ConfigSource, McpServerConfig } from '../config/source.ts';

export interface ResolvedTarget {
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export function splitShellStyle(input: string): string[] {
  const result: string[] = [];
  let current = '';
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (inSingle) {
      if (c === "'") {
        inSingle = false;
      } else {
        current += c;
      }
    } else if (inDouble) {
      if (c === '"') {
        inDouble = false;
      } else if (c === '\\' && i + 1 < input.length) {
        current += input[++i];
      } else {
        current += c;
      }
    } else if (c === "'") {
      inSingle = true;
    } else if (c === '"') {
      inDouble = true;
    } else if (c === ' ' || c === '\t') {
      if (current.length > 0) {
        result.push(current);
        current = '';
      }
    } else if (c === '\\' && i + 1 < input.length) {
      current += input[++i];
    } else {
      current += c;
    }
  }
  if (current.length > 0) result.push(current);
  return result;
}

function normalizeUrl(raw: string): string {
  if (raw.startsWith('http://') || raw.startsWith('https://')) return raw;
  if (raw.startsWith('localhost') || raw.startsWith('127.0.0.1') || raw.startsWith('[::1]')) {
    return `http://${raw}`;
  }
  return `https://${raw}`;
}

function looksLikeUrl(value: string): boolean {
  if (value.startsWith('http://') || value.startsWith('https://')) return true;
  if (value.includes('.') && !value.includes(' ')) return true;
  if (value.startsWith('localhost') || value.startsWith('127.0.0.1') || value.startsWith('[::1]'))
    return true;
  return false;
}

export async function resolveTarget(
  target: string,
  trailingArgs: string[] | undefined,
  config: ConfigSource
): Promise<ResolvedTarget> {
  if (trailingArgs && trailingArgs.length > 0) {
    return { command: trailingArgs[0], args: trailingArgs.slice(1) };
  }

  if (!target) {
    throw new Error('no target given');
  }

  if (target.startsWith('stdio:')) {
    const rest = target.slice(6);
    const parts = splitShellStyle(rest);
    if (parts.length === 0) throw new Error('stdio: target requires a command');
    return { command: parts[0], args: parts.slice(1) };
  }

  if (looksLikeUrl(target)) {
    return { url: normalizeUrl(target) };
  }

  const entry = await config.get(target);
  if (entry) {
    return configToTarget(entry);
  }

  throw new Error(`unknown target '${target}': not a URL and not found in mcp.json`);
}

function configToTarget(entry: McpServerConfig): ResolvedTarget {
  if (entry.url) {
    return {
      url: entry.url,
      headers: entry.headers,
    };
  }
  if (entry.command) {
    return {
      command: entry.command,
      args: entry.args,
      env: entry.env,
      cwd: entry.cwd,
    };
  }
  throw new Error('config entry has neither url nor command');
}
