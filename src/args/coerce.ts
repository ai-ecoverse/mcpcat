interface JsonSchemaProperty {
  type?: string;
  description?: string;
  items?: { type?: string };
}

interface JsonSchemaObject {
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

type ArgValue = string | number | boolean | null | ArgValue[] | ArgObject;

interface ArgObject {
  [key: string]: ArgValue;
}

export type ToolArguments = ArgObject;

export interface CoerceOk {
  ok: true;
  value: ToolArguments;
}

export interface CoerceErr {
  ok: false;
  error: string;
}

export type CoerceResult = CoerceOk | CoerceErr;

function asSchemaObject(schema: unknown): JsonSchemaObject {
  return (schema ?? {}) as JsonSchemaObject;
}

function emptyArgObject(): ArgObject {
  return Object.create(null) as ArgObject;
}

function isUnsafeObjectKey(key: string): boolean {
  return key === '__proto__' || key === 'prototype' || key === 'constructor';
}

function isPlainObject(value: unknown): value is ArgObject {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    value !== Object.prototype
  );
}

function splitFlag(a: string): { key: string; inlineValue: string | undefined } {
  const eq = a.indexOf('=');
  if (eq > 2) return { key: a.slice(2, eq), inlineValue: a.slice(eq + 1) };
  return { key: a.slice(2), inlineValue: undefined };
}

function coerceScalar(
  raw: string,
  type: string
): { ok: true; value: ArgValue } | { ok: false; error: string } {
  switch (type) {
    case 'integer': {
      if (!/^-?\d+$/.test(raw)) return { ok: false, error: `expected integer, got "${raw}"` };
      return { ok: true, value: Number(raw) };
    }
    case 'number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) return { ok: false, error: `expected number, got "${raw}"` };
      return { ok: true, value: n };
    }
    case 'boolean': {
      if (raw === 'true' || raw === '1' || raw === 'yes') return { ok: true, value: true };
      if (raw === 'false' || raw === '0' || raw === 'no') return { ok: true, value: false };
      return { ok: false, error: `expected boolean, got "${raw}"` };
    }
    case 'object':
      return coerceJsonObject(raw);
    default:
      return { ok: true, value: raw };
  }
}

function coerceJsonObject(
  raw: string
): { ok: true; value: ArgObject } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: `expected object JSON, got "${raw}"` };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, error: `expected object JSON, got "${raw}"` };
  }
  return { ok: true, value: parsed };
}

interface ResolvedToolFlag {
  ok: true;
  rootKey: string;
  dottedPath: string[] | null;
  meta: JsonSchemaProperty;
}

function resolveToolFlag(
  key: string,
  properties: Record<string, JsonSchemaProperty>
): ResolvedToolFlag | CoerceErr {
  if (Object.hasOwn(properties, key)) {
    return { ok: true, rootKey: key, dottedPath: null, meta: properties[key] ?? {} };
  }
  const dot = key.indexOf('.');
  if (dot <= 0) return { ok: false, error: `unknown flag: --${key}` };
  const rootKey = key.slice(0, dot);
  const rest = key.slice(dot + 1);
  if (!Object.hasOwn(properties, rootKey) || rest.length === 0) {
    return { ok: false, error: `unknown flag: --${key}` };
  }
  const parts = rest.split('.');
  if (isUnsafeObjectKey(rootKey) || parts.some((p) => p.length === 0 || isUnsafeObjectKey(p))) {
    return { ok: false, error: `unknown flag: --${key}` };
  }
  return { ok: true, rootKey, dottedPath: parts, meta: properties[rootKey] ?? {} };
}

interface FlagRaw {
  ok: true;
  raw: string;
  nextIndex: number;
  bareBoolean: boolean;
}

function readFlagRaw(
  args: string[],
  i: number,
  key: string,
  inlineValue: string | undefined,
  type: string,
  dottedPath: string[] | null
): FlagRaw | CoerceErr {
  if (inlineValue !== undefined) {
    return { ok: true, raw: inlineValue, nextIndex: i + 1, bareBoolean: false };
  }
  const next = args[i + 1];
  if (!dottedPath && type === 'boolean' && (next === undefined || next.startsWith('--'))) {
    return { ok: true, raw: '', nextIndex: i + 1, bareBoolean: true };
  }
  if (next === undefined) {
    return { ok: false, error: `flag --${key} requires a value` };
  }
  return { ok: true, raw: next, nextIndex: i + 2, bareBoolean: false };
}

function setDotted(
  out: ToolArguments,
  rootKey: string,
  path: string[],
  value: ArgValue
): CoerceErr | { ok: true } {
  if (isUnsafeObjectKey(rootKey) || path.some((p) => p.length === 0 || isUnsafeObjectKey(p))) {
    return { ok: false, error: `unknown flag: --${rootKey}.${path.join('.')}` };
  }
  const existing = Object.hasOwn(out, rootKey) ? out[rootKey] : undefined;
  if (existing === undefined) {
    out[rootKey] = emptyArgObject();
  } else if (!isPlainObject(existing)) {
    return { ok: false, error: `--${rootKey}: cannot nest into a ${typeof existing} value` };
  }
  let cursor = out[rootKey] as ArgObject;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = path[i];
    const next = Object.hasOwn(cursor, seg) ? cursor[seg] : undefined;
    if (next === undefined) {
      cursor[seg] = emptyArgObject();
    } else if (!isPlainObject(next)) {
      return {
        ok: false,
        error: `--${rootKey}.${path.slice(0, i + 1).join('.')}: cannot nest into a ${typeof next} value`,
      };
    }
    cursor = cursor[seg] as ArgObject;
  }
  cursor[path[path.length - 1]] = value;
  return { ok: true };
}

function assignFlagValue(
  out: ToolArguments,
  rootKey: string,
  dottedPath: string[] | null,
  value: ArgValue,
  isArray: boolean
): CoerceErr | { ok: true } {
  if (dottedPath) return setDotted(out, rootKey, dottedPath, value);
  if (isArray) {
    const prev = out[rootKey];
    if (Array.isArray(prev)) prev.push(value);
    else out[rootKey] = [value];
    return { ok: true };
  }
  const existing = out[rootKey];
  if (isPlainObject(existing) && isPlainObject(value)) {
    Object.assign(existing, value);
    return { ok: true };
  }
  out[rootKey] = value;
  return { ok: true };
}

function parseOneFlag(
  args: string[],
  i: number,
  properties: Record<string, JsonSchemaProperty>,
  out: ToolArguments
): (CoerceErr & { nextIndex?: never }) | { ok: true; nextIndex: number } {
  const a = args[i];
  if (a === '--') return { ok: true, nextIndex: args.length };
  if (a.startsWith('--no-') && a.length > 5) {
    const key = a.slice(5);
    if (Object.hasOwn(properties, key) && properties[key]?.type === 'boolean') {
      out[key] = false;
      return { ok: true, nextIndex: i + 1 };
    }
    return { ok: false, error: `unknown flag: ${a}` };
  }
  if (!a.startsWith('--')) {
    return { ok: false, error: `unexpected positional argument "${a}"` };
  }
  const { key, inlineValue } = splitFlag(a);
  const resolved = resolveToolFlag(key, properties);
  if (!resolved.ok) return resolved;

  const { rootKey, dottedPath, meta } = resolved;
  const declaredType = meta.type;
  const type = declaredType ?? 'string';
  const isArray = type === 'array';
  const itemType = (isArray ? meta.items?.type : undefined) ?? 'string';
  if (dottedPath && declaredType !== undefined && declaredType !== 'object') {
    return { ok: false, error: `unknown flag: --${key}` };
  }

  const taken = readFlagRaw(args, i, key, inlineValue, type, dottedPath);
  if (!taken.ok) return taken;
  if (taken.bareBoolean) {
    out[rootKey] = true;
    return { ok: true, nextIndex: taken.nextIndex };
  }

  const valueType = dottedPath ? 'string' : isArray ? itemType : type;
  const coerced = coerceScalar(taken.raw, valueType);
  if (!coerced.ok) return { ok: false, error: `--${key}: ${coerced.error}` };
  const assigned = assignFlagValue(out, rootKey, dottedPath, coerced.value, isArray);
  if (!assigned.ok) return assigned;
  return { ok: true, nextIndex: taken.nextIndex };
}

export function coerceArgsBySchema(
  args: string[],
  schema: unknown,
  options?: { noValidate?: boolean }
): CoerceResult {
  const s = asSchemaObject(schema);
  const properties = s.properties ?? {};
  const required = new Set(Array.isArray(s.required) ? s.required : []);
  const out: ToolArguments = emptyArgObject();

  let i = 0;
  while (i < args.length) {
    const result = parseOneFlag(args, i, properties, out);
    if (!result.ok) return result;
    i = result.nextIndex;
  }

  if (!options?.noValidate) {
    for (const r of required) {
      if (!Object.hasOwn(out, r)) {
        return { ok: false, error: `missing required flag --${r}` };
      }
    }
  }
  return { ok: true, value: out };
}

export function mergeArgs(
  base: Record<string, unknown>,
  flags: ToolArguments
): Record<string, unknown> {
  const result = { ...base };
  for (const [k, v] of Object.entries(flags)) {
    result[k] = v;
  }
  return result;
}
