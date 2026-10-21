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
