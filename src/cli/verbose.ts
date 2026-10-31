import { isCredentialHeader } from '../config/expand.ts';
import type { Platform } from '../platform/types.ts';
import { redactSecrets } from '../render/redact.ts';
import { sanitizeTerminal } from '../render/sanitize.ts';

const SESSION_HEADER_RE = /session/i;

function isSensitiveHeader(name: string): boolean {
  return isCredentialHeader(name) || SESSION_HEADER_RE.test(name);
}

export interface VerboseLogger {
  enabled: boolean;
  secrets: Set<string>;
  request(method: string, body: string): void;
  response(body: string): void;
  http(direction: string, line: string): void;
  server(line: string): void;
  headerOut(name: string, value: string): void;
  headerIn(name: string, value: string): void;
  progress(message: string): void;
}

function redact(text: string, secrets: Set<string>): string {
  return redactSecrets(text, secrets);
}

export function createVerboseLogger(platform: Platform, enabled: boolean): VerboseLogger {
  const secrets = new Set<string>();

  function write(line: string): void {
    const safe = sanitizeTerminal(redact(line, secrets));
    platform.write(2, `${safe}\n`).catch(() => {});
  }

  return {
    enabled,
    secrets,
    request(method: string, body: string) {
      if (!enabled) return;
      write(`> ${method}`);
      for (const line of body.split('\n')) {
        write(`> ${line}`);
      }
    },
    response(body: string) {
      if (!enabled) return;
      for (const line of body.split('\n')) {
        write(`< ${line}`);
      }
    },
    http(direction: string, line: string) {
      if (!enabled) return;
      write(`${direction} ${line}`);
    },
    server(line: string) {
      if (!enabled) return;
      write(`[server] ${line}`);
    },
    headerOut(name: string, value: string) {
      if (!enabled) return;
      const display = isSensitiveHeader(name) ? '[REDACTED]' : redact(value, secrets);
      write(`> ${name}: ${display}`);
    },
    headerIn(name: string, value: string) {
      if (!enabled) return;
      const display = isSensitiveHeader(name) ? '[REDACTED]' : redact(value, secrets);
      write(`< ${name}: ${display}`);
    },
    progress(message: string) {
      if (!enabled) return;
      write(`* ${message}`);
    },
  };
}
