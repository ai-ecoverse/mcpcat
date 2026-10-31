import type { Platform } from '../platform/types.ts';
import type { Redactor } from './result.ts';
import { sanitizeJson, sanitizeTerminal } from './sanitize.ts';

const ENCODING_DEPTH = 3;
const NON_ASCII = /[\u007f-\uffff]/g;
const JSON_TOKEN = /"(?:[^"\\]|\\.)*"|[^\s"{}[\],:]+/g;

function jsonForms(text: string): string[] {
  const json = JSON.stringify(text).slice(1, -1);
  const ascii = json.replace(
    NON_ASCII,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
  return [json, sanitizeJson(json), ascii].flatMap((form) => [form, form.replaceAll('/', '\\/')]);
}

function encodedForms(secret: string): string[] {
  const forms = new Set([secret, sanitizeTerminal(secret)]);
  let level = [secret];
  for (let depth = 0; depth < ENCODING_DEPTH; depth++) {
    level = [...new Set(level.flatMap(jsonForms))];
    for (const form of level) forms.add(form);
  }
  return [...forms];
}

export function redactDeep(value: unknown, redact: Redactor): unknown {
  if (typeof value === 'string') return redact(value);
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, redact));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [redact(k), redactDeep(v, redact)])
    );
  }
  return value;
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

export function redactOutput(text: string, redact: Redactor): string {
  const masked = redact(text);
  if (masked === text || isJson(masked) || !isJson(text)) return masked;
  const tokens = text.replace(JSON_TOKEN, (token) => {
    const shown = redact(token);
    return shown === token || token.startsWith('"') ? shown : JSON.stringify(shown);
  });
  return redact(tokens) === tokens ? tokens : masked;
}

export function redactWrites(platform: Platform, redact: Redactor): Platform {
  return Object.assign(Object.create(platform), {
    write: (fd: number, data: Uint8Array | string) =>
      platform.write(fd, typeof data === 'string' ? redactOutput(data, redact) : data),
  });
}

export function secretMasker(secrets: Iterable<string>, mask: string): (text: string) => string {
  const ordered = [...new Set(secrets)].filter((s) => s.length > 0).flatMap(encodedForms);
  if (ordered.length === 0) return (text) => text;
  return (text) => {
    const hidden = new Uint8Array(text.length);
    for (const secret of ordered) {
      for (let at = text.indexOf(secret); at >= 0; at = text.indexOf(secret, at + 1)) {
        hidden.fill(1, at, at + secret.length);
      }
    }
    let out = '';
    let start = 0;
    while (start < text.length) {
      let end = start;
      const masked = hidden[start] === 1;
      while (end < text.length && (hidden[end] === 1) === masked) end++;
      out += masked ? mask : text.slice(start, end);
      start = end;
    }
    return out;
  };
}

export function redactSecrets(text: string, secrets: Iterable<string>): string {
  return secretMasker(secrets, '[REDACTED]')(text);
}
