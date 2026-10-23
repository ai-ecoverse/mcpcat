import type { Platform, SpawnResult } from '../platform/types.ts';
import { sanitizeTerminal } from '../render/sanitize.ts';

export const POLYFILL_MIN_VERSION = '1.32.0';
export const TOOLS_CHANGED_MIN_VERSION = '1.40.0';
export const HOLDER_RESTART_MIN_MS = 500;
export const HOLDER_RESTART_MAX_MS = 30_000;
export const HOLDER_STABLE_MS = 30_000;
export const HOLDER_STOP_GRACE_MS = 2000;
export const HOLDER_READY_MS = 20_000;

export interface HolderOptions {
  playwrightCli: string;
  cdp?: string;
  tab: string;
  reload: boolean;
  readyTimeoutMs: number;
  watch?: boolean;
  report(line: string): Promise<void> | void;
}

export interface HolderStatus {
  mode?: string;
  late: boolean;
  native: boolean;
  loaderId?: string;
  error?: string;
}

export interface ToolsChanged {
  frameId?: unknown;
  loaderId?: unknown;
  origin?: unknown;
  tools?: unknown;
}

export interface Holder {
  ready(): Promise<void>;
  status(): HolderStatus;
  onDocument(listener: () => void): void;
  onToolsChanged(listener: (event: ToolsChanged) => void): void;
  stop(): Promise<void>;
}

const LABEL = 'mcpcat serve --webmcp';

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function parseCliVersion(text: string): string | undefined {
  return /playwright-cli\s+v?(\d+\.\d+\.\d+)/.exec(text)?.[1];
}

export async function drain(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        onLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    }
  } catch {}
  buffer += dec.decode();
  if (buffer) onLine(buffer);
}

interface HolderEvent extends ToolsChanged {
  event?: unknown;
  mode?: unknown;
  late?: unknown;
}

function loaderOf(event: HolderEvent): string | undefined {
  return typeof event.loaderId === 'string' ? event.loaderId : undefined;
}

function parseEvent(line: string): HolderEvent | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === 'object' ? (value as HolderEvent) : undefined;
  } catch {
    return undefined;
  }
}

export function startHolder(platform: Platform, options: HolderOptions): Holder {
  const state: HolderStatus = { late: false, native: false };
  const listeners: (() => void)[] = [];
  const changeListeners: ((event: ToolsChanged) => void)[] = [];
  let proc: SpawnResult | undefined;
  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  let stopped = false;
  let first = true;
  let delay = HOLDER_RESTART_MIN_MS;
  let readyAt: number | undefined;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  let pending!: Promise<void>;
  let settle!: () => void;
  let waitedOut = false;
  let exited: Promise<unknown> = Promise.resolve();

  const report = (line: string) => {
    void Promise.resolve(options.report(sanitizeTerminal(`${LABEL}: ${line}`) + '\n')).catch(
      () => {}
    );
  };

  const onEvent = (line: string) => {
    const event = parseEvent(line);
    if (!event) return;
    if (event.event === 'ready') {
      state.mode = typeof event.mode === 'string' ? event.mode : undefined;
      state.late = event.late === true;
      state.loaderId = loaderOf(event);
      state.error = undefined;
      readyAt = Date.now();
      if (state.mode === 'native' && !options.watch) {
        state.native = true;
        void closeInput();
      }
      settle();
    } else if (event.event === 'document-ready') {
      state.late = false;
      state.loaderId = loaderOf(event);
      for (const listener of listeners) listener();
    } else if (event.event === 'tools-changed') {
      for (const listener of changeListeners) listener(event);
    }
  };

  const closeInput = async () => {
    const w = writer;
    writer = undefined;
    try {
      await w?.close();
    } catch {}
  };

  const spawn = async () => {
    const argv = [options.playwrightCli];
    if (options.cdp) argv.push('--cdp', options.cdp);
    argv.push('webmcp-polyfill', '--tab', options.tab);
    if (options.reload && first) argv.push('--reload');
    first = false;
    waitedOut = false;
    pending = new Promise<void>((resolve) => {
      settle = resolve;
    });
    let child: SpawnResult;
    try {
      child = await platform.spawn({ argv, dieWithParent: true });
    } catch (err) {
      state.error = `cannot start playwright-cli webmcp-polyfill: ${(err as Error).message}`;
      settle();
      scheduleRestart();
      return;
    }
    if (stopped) {
      try {
        await child.stdin.getWriter().close();
      } catch {}
      settle();
      return;
    }
    proc = child;
    writer = child.stdin.getWriter();
    let lastError: string | undefined;
    const out = drain(child.stdout, onEvent);
    const err = drain(child.stderr, (line) => {
      const text = line.trim();
      if (!text) return;
      lastError = text;
      report(`playwright-cli webmcp-polyfill: ${text}`);
    });
    exited = Promise.all([out, err, child.wait()]).then(([, , result]) => {
      proc = undefined;
      writer = undefined;
      settle();
      if (readyAt !== undefined && Date.now() - readyAt >= HOLDER_STABLE_MS) {
        delay = HOLDER_RESTART_MIN_MS;
      }
      readyAt = undefined;
      if (stopped || state.native) return;
      state.late = false;
      state.mode = undefined;
      state.loaderId = undefined;
      state.error = lastError ?? `playwright-cli webmcp-polyfill exited ${result.status}`;
      report(
        `the WebMCP polyfill holder for tab ${options.tab} exited (${state.error}); restarting in ${Math.ceil(delay / 1000)}s`
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
    async ready() {
      if (waitedOut) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        pending.then(() => 'ready' as const),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), options.readyTimeoutMs);
        }),
      ]);
      clearTimeout(timer);
      if (outcome === 'timeout') waitedOut = true;
    },
    status: () => ({ ...state }),
    onDocument(listener) {
      listeners.push(listener);
    },
    onToolsChanged(listener) {
      changeListeners.push(listener);
    },
    async stop() {
      stopped = true;
      clearTimeout(restartTimer);
      const child = proc;
      await closeInput();
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
