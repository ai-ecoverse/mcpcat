import type { Platform, SpawnResult } from '../platform/types.ts';
import { sanitizeTerminal } from '../render/sanitize.ts';
import {
  drain,
  HOLDER_READY_MS,
  HOLDER_RESTART_MAX_MS,
  HOLDER_RESTART_MIN_MS,
  HOLDER_STABLE_MS,
  HOLDER_STOP_GRACE_MS,
} from './webmcp-origin.ts';

export const EVAL_ATTACH_MIN_VERSION = '1.52.0';

export type AttachScope = { tab: string } | { hosts: string[] } | { matches: string[] };

export interface AttachOptions {
  playwrightCli: string;
  cdp?: string;
  session: string;
  file: string;
  scope: AttachScope;
  world: 'main' | 'isolated';
  early?: boolean;
  label: string;
  readyTimeoutMs?: number;
  report(line: string): Promise<void> | void;
}

export interface AttachEvent {
  event: string;
  attachmentId?: string;
  tab?: string;
  frameId?: string;
  loaderId?: string;
  url?: string;
  world?: string;
  early?: boolean;
  reason?: string;
  payload?: unknown;
}

export interface Attachment {
  ready(): Promise<boolean>;
  onEvent(listener: (event: AttachEvent) => void): void;
  stop(): Promise<void>;
}

export function attachArgv(options: AttachOptions): string[] {
  const argv = [options.playwrightCli];
  if (options.cdp) argv.push('--cdp', options.cdp);
  argv.push('-s', options.session, 'eval-attach', options.file);
  const { scope } = options;
  if ('tab' in scope) argv.push('--tab', scope.tab);
  else if ('hosts' in scope) for (const host of scope.hosts) argv.push('--host', host);
  else for (const match of scope.matches) argv.push('--match', match);
  argv.push('--world', options.world);
  if (options.early) argv.push('--early');
  return argv;
}

export function parseAttachEvent(line: string): AttachEvent | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.event !== 'string') return undefined;
  const out: AttachEvent = { event: record.event };
  for (const key of [
    'attachmentId',
    'tab',
    'frameId',
    'loaderId',
    'url',
    'world',
    'reason',
  ] as const) {
    if (typeof record[key] === 'string') out[key] = record[key] as string;
  }
  if (typeof record.early === 'boolean') out.early = record.early;
  if ('payload' in record) out.payload = record.payload;
  return out;
}

export function startAttachment(platform: Platform, options: AttachOptions): Attachment {
  const listeners: ((event: AttachEvent) => void)[] = [];
  let proc: SpawnResult | undefined;
  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  let stopped = false;
  let delay = HOLDER_RESTART_MIN_MS;
  let readyAt: number | undefined;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let exited: Promise<unknown> = Promise.resolve();
  let isReady = false;
  let waiters: ((ok: boolean) => void)[] = [];

  const report = (line: string) => {
    void Promise.resolve(
      options.report(`${sanitizeTerminal(`${options.label}: ${line}`)}\n`)
    ).catch(() => {});
  };
  const settle = (ok: boolean) => {
    const pending = waiters;
    waiters = [];
    for (const resolve of pending) resolve(ok);
  };

  const onLine = (line: string) => {
    const event = parseAttachEvent(line);
    if (!event) return;
    if (event.event === 'ready') {
      isReady = true;
      readyAt = Date.now();
      settle(true);
    }
    for (const listener of listeners) listener(event);
  };

  const spawn = async () => {
    let child: SpawnResult;
    try {
      child = await platform.spawn({ argv: attachArgv(options), dieWithParent: true });
    } catch (err) {
      report(`cannot start playwright-cli eval-attach: ${(err as Error).message}`);
      scheduleRestart();
      return;
    }
    if (stopped) {
      try {
        await child.stdin.getWriter().close();
      } catch {}
      return;
    }
    proc = child;
    writer = child.stdin.getWriter();
    let lastError: string | undefined;
    const out = drain(child.stdout, onLine);
    const err = drain(child.stderr, (line) => {
      const text = line.trim();
      if (!text) return;
      lastError = text;
      report(`playwright-cli eval-attach: ${text}`);
    });
    exited = Promise.all([out, err, child.wait()]).then(([, , result]) => {
      proc = undefined;
      writer = undefined;
      isReady = false;
      if (readyAt !== undefined && Date.now() - readyAt >= HOLDER_STABLE_MS)
        delay = HOLDER_RESTART_MIN_MS;
      readyAt = undefined;
      if (stopped) return;
      if (result.status === 2) {
        report(`playwright-cli eval-attach refused (${lastError ?? 'exit 2'}); not restarting`);
        settle(false);
        return;
      }
      report(
        `the eval-attach holder exited (${lastError ?? `exit ${result.status}`}); restarting in ${Math.ceil(delay / 1000)}s`
      );
      scheduleRestart();
    });
  };

  const scheduleRestart = () => {
    if (stopped) return;
    const wait = delay;
    delay = Math.min(delay * 2, HOLDER_RESTART_MAX_MS);
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      if (!stopped) void spawn();
    }, wait);
  };

  void spawn();

  return {
    ready() {
      if (isReady) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => {
          waiters = waiters.filter((w) => w !== done);
          resolve(false);
        }, options.readyTimeoutMs ?? HOLDER_READY_MS);
        const done = (ok: boolean) => {
          clearTimeout(timer);
          resolve(ok);
        };
        waiters.push(done);
      });
    },
    onEvent(listener) {
      listeners.push(listener);
    },
    async stop() {
      stopped = true;
      clearTimeout(restartTimer);
      settle(false);
      const child = proc;
      const w = writer;
      writer = undefined;
      try {
        await w?.close();
      } catch {}
      if (!child) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = await Promise.race([
        exited.then(() => true),
        new Promise<false>((resolve) => {
          timer = setTimeout(() => resolve(false), HOLDER_STOP_GRACE_MS);
        }),
      ]);
      clearTimeout(timer);
      if (!done) {
        try {
          await child.kill('SIGKILL');
        } catch {}
      }
    },
  };
}
