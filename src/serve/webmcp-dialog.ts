import type { Platform, SpawnResult } from '../platform/types.ts';
import { sanitizeTerminal } from '../render/sanitize.ts';
import {
  drain,
  HOLDER_RESTART_MAX_MS,
  HOLDER_RESTART_MIN_MS,
  HOLDER_STABLE_MS,
  HOLDER_STOP_GRACE_MS,
} from './webmcp-polyfill.ts';

export const DIALOG_HOLD_MIN_VERSION = '1.39.0';
export const DIALOG_ANSWER_MS = 7000;
export const DIALOG_CLAIM_MS = 1000;
export const DIALOG_FAIL_FAST = 2;
export const DIALOG_MODES = ['report', 'dismiss', 'accept'] as const;

export type DialogMode = (typeof DIALOG_MODES)[number];

export interface DialogHolderOptions {
  playwrightCli: string;
  cdp?: string;
  tab: string;
  accept: boolean;
  readyTimeoutMs: number;
  answerTimeoutMs?: number;
  report(line: string): Promise<void> | void;
}

export interface DialogHolder {
  ready(): Promise<void>;
  attached(): boolean;
  open(): boolean;
  problem(): string | undefined;
  arm(): () => void;
  stop(): Promise<void>;
}

interface DialogState {
  id: number;
  armed: boolean;
  problem?: string;
}

interface HoldEvent {
  event?: unknown;
  id?: unknown;
  dialogId?: unknown;
  reason?: unknown;
}

const LABEL = 'mcpcat serve --webmcp';
const REFUSED = 'playwright-cli refuses to answer it (protected, unverified or in a frame)';

function parseHoldEvent(line: string): HoldEvent | undefined {
  try {
    const value = JSON.parse(line) as unknown;
    return value && typeof value === 'object' ? (value as HoldEvent) : undefined;
  } catch {
    return undefined;
  }
}

async function within(promise: Promise<unknown>, ms: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = await Promise.race([
    promise.then(() => true),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    }),
  ]);
  clearTimeout(timer);
  return done;
}

function reporter(options: DialogHolderOptions): (line: string) => void {
  return (line) => {
    void Promise.resolve(options.report(sanitizeTerminal(`${LABEL}: ${line}`) + '\n')).catch(
      () => {}
    );
  };
}

function answerProblem(event: string, answerMs: number): string {
  return event === 'timeout'
    ? `playwright-cli dialog-hold did not answer within ${Math.round(answerMs / 1000)}s`
    : `playwright-cli dialog-hold replied ${event}`;
}

function latch() {
  let shut = false;
  let wait: Promise<void> = Promise.resolve();
  let release = () => {};
  return {
    close() {
      if (shut) return;
      shut = true;
      wait = new Promise<void>((resolve) => {
        release = () => {
          shut = false;
          resolve();
        };
      });
    },
    open: () => release(),
    wait: () => wait,
  };
}

const isId = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;

export function startDialogHolder(platform: Platform, options: DialogHolderOptions): DialogHolder {
  const verb = options.accept ? 'dialog-accept' : 'dialog-dismiss';
  const answerMs = options.answerTimeoutMs ?? DIALOG_ANSWER_MS;
  let proc: SpawnResult | undefined;
  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  let stopped = false;
  let isReady = false;
  let waitedOut = false;
  let failing = false;
  let failures = 0;
  let armed = 0;
  let current: DialogState | undefined;
  let nextId = 1;
  let queue: Promise<void> = Promise.resolve();
  let reply: { id: number; resolve(event: string): void } | undefined;
  let delay = HOLDER_RESTART_MIN_MS;
  let readyAt: number | undefined;
  let restartTimer: ReturnType<typeof setTimeout> | undefined;
  const gate = latch();
  const unready = () => {
    isReady = false;
    waitedOut = false;
    gate.close();
  };
  let exited: Promise<unknown> = Promise.resolve();

  const report = reporter(options);

  const send = async (id: number, dialogId: number): Promise<string> => {
    const w = writer;
    if (!w) return 'holder-gone';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const answered = new Promise<string>((resolve) => {
      reply = { id, resolve };
      timer = setTimeout(() => resolve('timeout'), answerMs);
    });
    const line = `${JSON.stringify({ id, dialogId, command: verb })}\n`;
    w.write(new TextEncoder().encode(line)).catch(() => reply?.resolve('holder-gone'));
    const event = await answered;
    clearTimeout(timer);
    reply = undefined;
    return event;
  };

  const answer = (dialog: DialogState) => {
    queue = queue.then(async () => {
      if (current !== dialog) return;
      const event = await send(nextId++, dialog.id);
      if (event === 'handled') {
        report(
          `${options.accept ? 'accepted' : 'dismissed'} a JavaScript dialog on tab ${options.tab}`
        );
        return;
      }
      if (current !== dialog) return;
      dialog.problem = answerProblem(event, answerMs);
    });
  };

  const onEvent = (line: string) => {
    const event = parseHoldEvent(line);
    if (!event || typeof event.event !== 'string') return;
    if (isId(event.id) && reply?.id === event.id) {
      reply.resolve(event.event);
      return;
    }
    if (event.event === 'ready') {
      isReady = true;
      failing = false;
      readyAt = Date.now();
      gate.open();
    } else if (event.event === 'dialog-opened' && isId(event.dialogId)) {
      current = { id: event.dialogId, armed: armed > 0 };
      if (current.armed) answer(current);
    } else if (event.event === 'dialog-refused' && isId(event.dialogId)) {
      current = { id: event.dialogId, armed: armed > 0, problem: REFUSED };
    } else if (event.event === 'dialog-closed') {
      current = undefined;
    } else if (event.event === 'stopped') {
      unready();
      current = undefined;
    }
  };

  const spawn = async () => {
    const argv = [options.playwrightCli];
    if (options.cdp) argv.push('--cdp', options.cdp);
    argv.push('dialog-hold', '--tab', options.tab);
    let child: SpawnResult;
    try {
      child = await platform.spawn({ argv, dieWithParent: true });
    } catch (err) {
      report(`cannot start playwright-cli dialog-hold: ${(err as Error).message}`);
      scheduleRestart(false);
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
    const out = drain(child.stdout, onEvent);
    const err = drain(child.stderr, (text) => {
      if (text.trim()) lastError = text.trim();
    });
    exited = Promise.all([out, err, child.wait()]).then(([, , result]) => {
      proc = undefined;
      writer = undefined;
      current = undefined;
      reply?.resolve('holder-gone');
      if (!stopped) unready();
      const reached = readyAt !== undefined;
      if (reached && Date.now() - readyAt! >= HOLDER_STABLE_MS) delay = HOLDER_RESTART_MIN_MS;
      readyAt = undefined;
      if (stopped) return;
      const why = lastError ?? `exited ${result.status}`;
      report(
        `the dialog holder for tab ${options.tab} stopped (playwright-cli dialog-hold: ${why}); restarting in ${Math.ceil(delay / 1000)}s`
      );
      scheduleRestart(reached);
    });
  };

  const scheduleRestart = (reached: boolean) => {
    if (stopped) return;
    const wait = delay;
    delay = Math.min(delay * 2, HOLDER_RESTART_MAX_MS);
    failures = reached ? 0 : failures + 1;
    failing = failures >= DIALOG_FAIL_FAST || wait >= options.readyTimeoutMs;
    if (failing) gate.open();
    restartTimer = setTimeout(() => {
      restartTimer = undefined;
      if (!stopped) void spawn();
    }, wait);
  };

  unready();
  void spawn();

  return {
    async ready() {
      if (failing || waitedOut || isReady) return;
      if (!(await within(gate.wait(), options.readyTimeoutMs))) waitedOut = true;
    },
    attached: () => isReady,
    open: () => current !== undefined,
    problem() {
      if (!current) return undefined;
      if (current.problem) return current.problem;
      return current.armed ? undefined : 'it opened outside a tool call';
    },
    arm() {
      armed++;
      let done = false;
      return () => {
        if (done) return;
        done = true;
        armed--;
      };
    },
    async stop() {
      stopped = true;
      gate.open();
      clearTimeout(restartTimer);
      const child = proc;
      const w = writer;
      writer = undefined;
      try {
        await w?.close();
      } catch {}
      if (child && !(await within(exited, HOLDER_STOP_GRACE_MS))) {
        try {
          await child.kill('SIGKILL');
        } catch {}
      }
    },
  };
}
