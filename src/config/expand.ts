import type { Platform } from '../platform/types.ts';

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const PLACEHOLDER_TEST = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/;
const BANG_COMMAND = /^!(.+)$/;

export function containsPlaceholders(value: string): boolean {
  return PLACEHOLDER_TEST.test(value);
}

export function expandPlaceholders(value: string, env: Record<string, string | undefined>): string {
  return value.replace(PLACEHOLDER, (_, name: string) => env[name] ?? '');
}

export const MIN_VAR_SECRET = 8;

export function placeholderValues(
  value: string,
  env: Record<string, string | undefined>
): string[] {
  const values: string[] = [];
  for (const m of value.matchAll(PLACEHOLDER)) {
    const v = env[m[1]];
    if (v !== undefined && v.length >= MIN_VAR_SECRET) values.push(v);
  }
  return values;
}

export function missingPlaceholders(
  value: string,
  env: Record<string, string | undefined>
): string[] {
  const missing: string[] = [];
  for (const m of value.matchAll(PLACEHOLDER)) {
    const name = m[1];
    if (env[name] === undefined && !missing.includes(name)) missing.push(name);
  }
  return missing;
}

export function expandPlaceholdersStrict(
  value: string,
  env: Record<string, string | undefined>
): string | undefined {
  let hasUndefined = false;
  const result = value.replace(PLACEHOLDER, (_, name: string) => {
    if (env[name] === undefined) {
      hasUndefined = true;
      return '';
    }
    return env[name]!;
  });
  if (hasUndefined) return undefined;
  return result;
}

export async function expandBangCommand(value: string, platform: Platform): Promise<string> {
  const match = BANG_COMMAND.exec(value.trim());
  if (!match) return value;
  const cmd = match[1];
  const result = await platform.spawn({
    argv: ['sh', '-c', cmd],
    env: platform.env as Record<string, string>,
    cwd: platform.cwd,
  });
  const chunks: Uint8Array[] = [];
  const reader = result.stdout.getReader();
  while (true) {
    const { done, value: chunk } = await reader.read();
    if (done) break;
    chunks.push(chunk);
  }
  await result.wait();
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.length;
  }
  return new TextDecoder().decode(merged).trim();
}

export function expandValue(value: string, env: Record<string, string | undefined>): string {
  return expandPlaceholders(value, env);
}

export function expandHeaders(
  headers: Record<string, string> | undefined,
  env: Record<string, string | undefined>,
  warn?: (msg: string) => void
): Record<string, string> | undefined {
  if (!headers) return undefined;
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const missing = missingPlaceholders(v, env);
    if (missing.length > 0) {
      if (warn)
        warn(`header "${k}": unset variable${missing.length > 1 ? 's' : ''} ${missing.join(', ')}`);
      continue;
    }
    result[k] = expandPlaceholders(v, env);
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function expandEnv(
  envMap: Record<string, string> | undefined,
  processEnv: Record<string, string | undefined>
): Record<string, string> | undefined {
  if (!envMap) return undefined;
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(envMap)) {
    result[k] = expandPlaceholders(v, processEnv);
  }
  return result;
}

export function redactValue(value: string): string {
  return value.replace(PLACEHOLDER, '***');
}
