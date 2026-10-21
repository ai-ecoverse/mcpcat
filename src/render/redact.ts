import type { Platform } from '../platform/types.ts';
import type { Redactor } from './result.ts';

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

export function redactWrites(platform: Platform, redact: Redactor): Platform {
  return Object.assign(Object.create(platform), {
    write: (fd: number, data: Uint8Array | string) =>
      platform.write(fd, typeof data === 'string' ? redact(data) : data),
  });
}

export function secretMasker(secrets: Iterable<string>, mask: string): (text: string) => string {
  const ordered = [...new Set(secrets)].filter((s) => s.length > 0);
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
