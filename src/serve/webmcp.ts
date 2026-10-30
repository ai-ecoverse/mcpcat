import type { Platform, SpawnResult, WebSocketChannel } from '../platform/types.ts';
import type { JsonObjectSchema } from './catalog.ts';
import type { RpcTool, ToolListing, ToolRunResult } from './jsonrpc.ts';
import { DIALOG_CLAIM_MS, type DialogHolder } from './webmcp-dialog.ts';
import type { ToolsChanged } from './webmcp-polyfill.ts';

export interface WebMcpAnnotations {
  readOnlyHint?: boolean;
  consequentialHint?: boolean;
  untrustedContentHint?: boolean;
}

export interface WebMcpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  origin: string;
  annotations?: WebMcpAnnotations;
  policy?: unknown;
  frameId?: unknown;
}

export interface WebMcpOptions {
  playwrightCli: string;
  tab?: string;
  cdp?: string;
  allowConsequential: boolean;
  ttlMs: number;
  callTimeoutMs: number;
  maxOutput: number;
  fromOrigins?: string[];
  dialogs?: DialogHolder;
  beforeList?: () => Promise<void>;
  late?: () => boolean;
  emptyHint?: (unavailable: boolean) => string | undefined;
  topLoader?: () => string | undefined;
  onChange?: () => void;
}

interface FrameTools {
  tools: WebMcpTool[];
  seq: number;
}

interface CacheEntry {
  tools: WebMcpTool[];
  unavailable: boolean;
  expiresAt: number;
}

const UNAVAILABLE_RE = /WebMCP is unavailable on this page/;

function buildBaseArgs(options: WebMcpOptions): string[] {
  const args: string[] = [];
  if (options.cdp) {
    args.push('--cdp', options.cdp);
  }
  if (options.tab) {
    args.push('--tab', options.tab);
  }
  for (const origin of options.fromOrigins ?? []) {
    args.push('--from-origin', origin);
  }
  return args;
}

function generateNonce(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function wrapUntrusted(content: string): string {
  const nonce = generateNonce();
  const openTag = `<<untrusted-page-content id=${nonce}>>`;
  const closeTag = `<<end id=${nonce}>>`;
  const neutralised = content.replaceAll('<<untrusted-page-content', '< <untrusted-page-content');
  return `${openTag}\n${neutralised}\n${closeTag}`;
}

export const WEBMCP_LIST_FLOOR = 1_048_576;

interface Capped {
  text: string;
  cut: boolean;
}

function capCollector(limit: number) {
  const dec = new TextDecoder();
  const half = Math.floor(limit / 2);
  let head = '';
  let tail = '';
  let total = 0;
  const take = (piece: string) => {
    if (!piece) return;
    total += piece.length;
    if (head.length < limit) head += piece.slice(0, limit - head.length);
    tail = half > 0 ? (tail + piece).slice(-half) : '';
  };
  return {
    push(chunk: Uint8Array) {
      take(dec.decode(chunk, { stream: true }));
    },
    finish(): Capped {
      take(dec.decode());
      if (total <= limit) return { text: head, cut: false };
      return {
        text: `${head.slice(0, half)}\n… ${total - limit} characters cut …\n${tail}`,
        cut: true,
      };
    },
  };
}

export const DIALOG_POLL_MS = 250;
export const DIALOG_READY_MS = 1000;
export const DIALOG_STALL_MS = 1000;

type Watch = () => string | undefined;

function watchLoop(watch: Watch): { result: Promise<string>; stop(): void } {
  let timer: ReturnType<typeof setInterval> | undefined;
  const result = new Promise<string>((resolve) => {
    timer = setInterval(() => {
      const found = watch();
      if (found) {
        clearInterval(timer);
        resolve(found);
      }
    }, DIALOG_POLL_MS);
  });
  return {
    result,
    stop() {
      clearInterval(timer);
    },
  };
}

async function browserSocketUrl(platform: Platform, cdp: string): Promise<string | undefined> {
  if (/^wss?:\/\//i.test(cdp)) return cdp;
  if (!/^https?:\/\//i.test(cdp)) return undefined;
  const res = await platform.fetch(`${cdp.replace(/\/+$/, '')}/json/version`, {
    signal: AbortSignal.timeout(DIALOG_READY_MS),
  });
  const body = (await res.json()) as { webSocketDebuggerUrl?: unknown };
  return typeof body.webSocketDebuggerUrl === 'string' ? body.webSocketDebuggerUrl : undefined;
}

interface CdpMessage {
  id?: number;
  method?: string;
  result?: { sessionId?: unknown };
  params?: { type?: unknown };
}

export interface DialogWatcher {
  ready(): Promise<void>;
  dialog(): string | undefined;
  stalled(): boolean;
  close(): void;
}

interface WatchState {
  open?: string;
  enableSentAt?: number;
  channel?: WebSocketChannel;
}

function parseCdp(data: string | Uint8Array): CdpMessage | undefined {
  try {
    return JSON.parse(
      typeof data === 'string' ? data : new TextDecoder().decode(data)
    ) as CdpMessage;
  } catch {
    return undefined;
  }
}

function applyCdp(
  state: WatchState,
  channel: WebSocketChannel,
  send: (message: unknown) => void,
  msg: CdpMessage,
  settle: () => void
): void {
  if (msg.method === 'Page.javascriptDialogOpening') {
    state.open = typeof msg.params?.type === 'string' ? msg.params.type : 'dialog';
  } else if (msg.method === 'Page.javascriptDialogClosed') {
    state.open = undefined;
  } else if (msg.method === 'Target.detachedFromTarget') {
    channel.close();
  } else if (msg.id === 1) {
    const sessionId = msg.result?.sessionId;
    if (typeof sessionId !== 'string') {
      channel.close();
      return;
    }
    state.enableSentAt = Date.now();
    send({ id: 2, sessionId, method: 'Page.enable' });
  } else if (msg.id === 2) {
    state.enableSentAt = undefined;
    settle();
  }
}

async function pump(
  state: WatchState,
  channel: WebSocketChannel,
  send: (message: unknown) => void,
  settle: () => void
): Promise<void> {
  const reader = channel.readable.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      const msg = parseCdp(value);
      if (msg) applyCdp(state, channel, send, msg, settle);
    }
  } catch {
    return;
  }
}

async function attachSocket(
  platform: Platform,
  state: WatchState,
  url: string,
  targetId: string
): Promise<void> {
  const channel = await platform.websocket!(url).catch(() => undefined);
  if (!channel) return;
  state.channel = channel;
  const writer = channel.writable.getWriter();
  const send = (message: unknown) => {
    writer.write(JSON.stringify(message)).catch(() => channel.close());
  };
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => {
    settle = resolve;
  });
  void pump(state, channel, send, settle).then(() => {
    if (state.channel === channel) {
      state.channel = undefined;
      state.open = undefined;
      state.enableSentAt = undefined;
    }
    channel.close();
    settle();
  });
  send({ id: 1, method: 'Target.attachToTarget', params: { targetId, flatten: true } });
  await settled;
}

export function watchJsDialogs(platform: Platform, cdp: string, targetId: string): DialogWatcher {
  const state: WatchState = {};
  let connecting: Promise<void> | undefined;
  let closed = false;

  const connect = async (): Promise<void> => {
    if (!platform.websocket) return;
    const url = await browserSocketUrl(platform, cdp).catch(() => undefined);
    if (!url || closed) return;
    await attachSocket(platform, state, url, targetId);
  };

  return {
    async ready() {
      if (closed || state.channel) return;
      connecting ??= connect().finally(() => {
        connecting = undefined;
      });
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        connecting,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, DIALOG_READY_MS);
        }),
      ]);
      clearTimeout(timer);
    },
    dialog: () => state.open,
    stalled: () =>
      state.enableSentAt !== undefined && Date.now() - state.enableSentAt >= DIALOG_STALL_MS,
    close() {
      closed = true;
      state.channel?.close();
    },
  };
}

function dialogMessage(tab: string, type: string): string {
  return `tab ${tab} is blocked by a JavaScript ${type.replace(/[^a-z]/gi, '')} dialog; answer or dismiss it in the browser, then retry`;
}

function holderMessage(tab: string, problem: string): string {
  return `tab ${tab} is blocked by a JavaScript dialog that mcpcat does not answer (${problem}); answer or dismiss it in the browser, then retry`;
}

function reportWatch(tab: string, watcher: DialogWatcher): Watch {
  return () => {
    const type = watcher.dialog();
    return type ? dialogMessage(tab, type) : undefined;
  };
}

function answeringWatch(tab: string, dialogs: DialogHolder, watcher?: DialogWatcher): Watch {
  let seenAt: number | undefined;
  return () => {
    const problem = dialogs.problem();
    if (problem) return holderMessage(tab, problem);
    const type = watcher?.dialog();
    if (!type || dialogs.open()) {
      seenAt = undefined;
      return undefined;
    }
    if (!dialogs.attached()) return dialogMessage(tab, type);
    seenAt ??= Date.now();
    return Date.now() - seenAt >= DIALOG_CLAIM_MS ? dialogMessage(tab, type) : undefined;
  };
}

async function settleWatcher(watcher: DialogWatcher): Promise<void> {
  const until = Date.now() + DIALOG_CLAIM_MS;
  while (watcher.dialog() && Date.now() < until) {
    await new Promise((resolve) => setTimeout(resolve, DIALOG_POLL_MS));
  }
}

function timeoutMessage(
  verb: string,
  timeoutMs: number,
  tab: string | undefined,
  watcher?: DialogWatcher
): string {
  const head = `${verb} timed out after ${Math.round(timeoutMs / 1000)}s`;
  if (!watcher) {
    return `${head}; if the page shows a JavaScript dialog (alert, confirm, prompt), answer it, and pass --cdp <url> so mcpcat can detect one`;
  }
  if (watcher.stalled()) {
    return `${head}; tab ${tab} does not answer the DevTools protocol, so a JavaScript dialog opened before mcpcat attached may block it; answer it in the browser, then retry`;
  }
  return head;
}

export async function runProcess(
  platform: Platform,
  argv: string[],
  stdin: string | undefined,
  timeoutMs: number,
  limit: number,
  watch?: Watch
): Promise<{ stdout: string; stderr: string; exitCode: number; cut: boolean; blocked?: string }> {
  let proc: SpawnResult;
  try {
    proc = await platform.spawn({ argv });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EACCES') {
      return { stdout: '', stderr: `command not found: ${argv[0]}`, exitCode: -1, cut: false };
    }
    throw err;
  }

  if (stdin !== undefined) {
    const writer = proc.stdin.getWriter();
    await writer.write(new TextEncoder().encode(stdin));
    await writer.close();
  } else {
    try {
      await proc.stdin.getWriter().close();
    } catch {}
  }

  const out = capCollector(limit);
  const err = capCollector(limit);

  const readStream = async (
    stream: ReadableStream<Uint8Array>,
    into: ReturnType<typeof capCollector>
  ) => {
    const r = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await r.read();
        if (done) break;
        into.push(value);
      }
    } finally {
      r.releaseLock();
    }
  };

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<'timeout'>((resolve) => {
    timeoutId = setTimeout(() => resolve('timeout'), timeoutMs);
  });

  const work = Promise.all([
    readStream(proc.stdout, out),
    readStream(proc.stderr, err),
    proc.wait(),
  ]);

  const watcher = watch ? watchLoop(watch) : undefined;
  const blocked = watcher
    ? watcher.result.then((message) => ({ blocked: message }))
    : new Promise<never>(() => {});

  const result = await Promise.race([work, timer, blocked]);
  clearTimeout(timeoutId);
  watcher?.stop();

  if (result === 'timeout') {
    await proc.kill('SIGTERM');
    return { stdout: '', stderr: 'timed out', exitCode: 124, cut: false };
  }

  if (!Array.isArray(result)) {
    await proc.kill('SIGTERM');
    return { stdout: '', stderr: 'blocked', exitCode: 124, cut: false, blocked: result.blocked };
  }

  const [, , exitResult] = result;
  const stdout = out.finish();
  const stderr = err.finish();
  return {
    stdout: stdout.text,
    stderr: stderr.text,
    exitCode: exitResult.status,
    cut: stdout.cut,
  };
}

interface TabRow {
  id: string;
  active: boolean;
  url: string;
}

type TabRows = { rows: TabRow[] } | { error: string; notFound?: boolean };

export async function listTabs(
  platform: Platform,
  options: Pick<WebMcpOptions, 'playwrightCli' | 'cdp' | 'callTimeoutMs'> & { fullUrls?: boolean }
): Promise<TabRows> {
  const argv = [options.playwrightCli, 'tab-list'];
  if (options.fullUrls) argv.push('--full-urls');
  if (options.cdp) argv.push('--cdp', options.cdp);
  const result = await runProcess(
    platform,
    argv,
    undefined,
    options.callTimeoutMs,
    WEBMCP_LIST_FLOOR
  );
  if (result.exitCode === -1) return { error: result.stderr, notFound: true };
  if (result.exitCode !== 0) {
    return { error: result.stderr.trim() || `tab-list exited ${result.exitCode}` };
  }
  const rows: TabRow[] = [];
  for (const line of result.stdout.split('\n')) {
    const match = /^(\d+): \[([^\]\s]+)\] (\S*)/.exec(line);
    if (!match) continue;
    if (Number(match[1]) !== rows.length + 1) {
      return { error: 'could not read playwright-cli tab-list' };
    }
    rows.push({ id: match[2]!, active: line.endsWith('" (active)'), url: match[3]! });
  }
  const active = rows.filter((r) => r.active);
  if (new Set(rows.map((r) => r.id)).size !== rows.length || active.length > 1) {
    return { error: 'could not read playwright-cli tab-list' };
  }
  return { rows };
}

export async function playwrightCliVersion(
  platform: Platform,
  options: Pick<WebMcpOptions, 'playwrightCli' | 'callTimeoutMs'>
): Promise<string> {
  const result = await runProcess(
    platform,
    [options.playwrightCli, '--version'],
    undefined,
    options.callTimeoutMs,
    WEBMCP_LIST_FLOOR
  );
  return result.exitCode === 0 ? result.stdout : '';
}

export async function resolveWebMcpTab(
  platform: Platform,
  options: Pick<WebMcpOptions, 'playwrightCli' | 'cdp' | 'callTimeoutMs'>
): Promise<{ tab?: string; error?: string; notFound?: boolean }> {
  const listed = await listTabs(platform, options);
  if ('error' in listed) return listed;
  const { rows } = listed;
  const active = rows.filter((r) => r.active);
  if (active.length === 1) return { tab: active[0]!.id };
  if (rows.length === 1) return { tab: rows[0]!.id };
  return {
    error:
      rows.length === 0
        ? 'no browser tab is open; open one or pass --tab <targetId>'
        : 'no current playwright-cli tab; pass --tab <targetId> (see playwright-cli tab-list)',
  };
}

function mapDescriptionAnnotations(ann?: WebMcpAnnotations): Record<string, boolean> {
  const mapped: Record<string, boolean> = { openWorldHint: true };
  if (!ann) return mapped;
  if (ann.readOnlyHint !== undefined) mapped.readOnlyHint = ann.readOnlyHint;
  if (ann.untrustedContentHint) mapped.untrustedContentHint = true;
  if (ann.consequentialHint) {
    mapped.destructiveHint = true;
    mapped.consequentialHint = true;
  }
  return mapped;
}

function bridgeAnnotations(tool: WebMcpTool, late: boolean): Record<string, boolean | string> {
  const mapped: Record<string, boolean | string> = mapDescriptionAnnotations(tool.annotations);
  if (tool.policy === 'allowed' || tool.policy === 'unknown') mapped.policy = tool.policy;
  if (late) mapped.late = true;
  return mapped;
}

function originPrefix(tools: WebMcpTool[]): boolean {
  const origins = new Set(tools.map((t) => t.origin));
  return origins.size > 1;
}

function hostFromOrigin(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

function buildDescription(tool: WebMcpTool): string {
  const parts: string[] = [];
  if (tool.description) parts.push(tool.description);
  parts.push(`[origin: ${tool.origin}]`);
  return parts.join('\n');
}

function buildToolName(tool: WebMcpTool, prefix: boolean): string {
  const base = tool.name;
  if (!prefix) return base;
  const host = hostFromOrigin(tool.origin).replace(/[^a-zA-Z0-9_]/g, '_');
  return `${host}__${base}`;
}

function exposedTools(
  tools: WebMcpTool[]
): { name: string; tool: WebMcpTool; peers: WebMcpTool[] }[] {
  const needPrefix = originPrefix(tools);
  const byBase = new Map<string, WebMcpTool[]>();
  const byName = new Map<string, WebMcpTool[]>();
  for (const tool of tools) {
    const name = buildToolName(tool, needPrefix);
    byBase.set(tool.name, [...(byBase.get(tool.name) ?? []), tool]);
    byName.set(name, [...(byName.get(name) ?? []), tool]);
  }
  return tools.map((tool) => {
    const name = buildToolName(tool, needPrefix);
    const sameBase = byBase.get(tool.name)!;
    const sameName = byName.get(name)!;
    return { name, tool, peers: sameBase.length > 1 ? sameBase : sameName };
  });
}

function ambiguityError(name: string, peers: WebMcpTool[]): Error {
  const origins = [...new Set(peers.map((t) => String(t.origin)))].join(', ');
  return new Error(
    `tool "${name}" is ambiguous: ${peers.length} tools on the page match it (${origins}), and playwright-cli runs the first tool by name and cannot select one by origin, so mcpcat refuses the call`
  );
}

async function blockedNow(
  watcher: DialogWatcher | undefined,
  tab: string | undefined,
  dialogs: DialogHolder | undefined
): Promise<string | undefined> {
  const problem = dialogs?.problem();
  if (problem) return holderMessage(tab!, problem);
  if (!watcher) return undefined;
  await watcher.ready();
  if (dialogs?.open()) return undefined;
  if (dialogs?.attached()) await settleWatcher(watcher);
  const open = watcher.dialog();
  return open ? dialogMessage(tab!, open) : undefined;
}

function urlOrigin(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

async function tabOrigin(platform: Platform, options: WebMcpOptions): Promise<string | undefined> {
  const listed = await listTabs(platform, options);
  if ('error' in listed) return undefined;
  const row = listed.rows.find((r) => r.id === options.tab);
  return row ? urlOrigin(row.url) : undefined;
}

async function tabGone(platform: Platform, options: WebMcpOptions): Promise<string | undefined> {
  const { tab } = options;
  if (!tab) return undefined;
  const listed = await listTabs(platform, options);
  if ('error' in listed || listed.rows.some((r) => r.id === tab)) return undefined;
  return `tab ${tab} is gone (the browser restarted or the tab closed); restart mcpcat serve --webmcp, or pass --tab <targetId> (see playwright-cli tab-list)`;
}

export function hiddenToolMessage(name: string): string {
  return `tool ${name} exists on the page but is hidden because it is consequential (consequentialHint); restart with mcpcat serve --webmcp --allow-consequential to expose it`;
}

function parseListOutput(
  result: { stdout: string; cut: boolean },
  listLimit: number
): WebMcpTool[] | { error: string } {
  if (result.cut) return { error: `webmcp-list output exceeds ${listLimit} characters` };
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return { error: 'webmcp-list returned invalid JSON' };
  }
  if (!Array.isArray(parsed)) return { error: 'webmcp-list did not return an array' };
  return parsed as WebMcpTool[];
}

interface Mark {
  epoch: number;
  seq: number;
}

function createLiveFrames(platform: Platform, options: WebMcpOptions) {
  const { tab } = options;
  const fromOrigins = options.fromOrigins ?? [];
  const frames = new Map<string, FrameTools>();
  let seq = 0;
  let epoch = 0;
  let topOrigin: Promise<string | undefined> | undefined;
  let changes: Promise<void> = Promise.resolve();

  const frameOf = (tool: WebMcpTool): string =>
    typeof tool.frameId === 'string' ? tool.frameId : (tab ?? '');

  async function admitted(frameId: string, origin: string): Promise<boolean> {
    if (frameId === tab || fromOrigins.includes(origin)) return true;
    topOrigin ??= tabOrigin(platform, options);
    const known = await topOrigin.catch(() => undefined);
    if (known === undefined) topOrigin = undefined;
    return origin === known;
  }

  async function applyNow(event: ToolsChanged, at: number): Promise<void> {
    const { frameId, loaderId, origin, tools } = event;
    if (typeof frameId !== 'string' || typeof origin !== 'string' || !Array.isArray(tools)) return;
    const top = options.topLoader?.();
    if (frameId === tab && top !== undefined && loaderId !== top) return;
    if (!(await admitted(frameId, origin)) || at !== epoch) return;
    frames.set(frameId, {
      tools: (tools as WebMcpTool[]).map((tool) => ({ ...tool, frameId })),
      seq: ++seq,
    });
    options.onChange?.();
  }

  return {
    mark: (): Mark => ({ epoch, seq }),
    keep(mark: Mark): boolean {
      if (mark.epoch !== epoch) return false;
      for (const [id, frame] of frames) {
        if (frame.seq <= mark.seq) frames.delete(id);
      }
      return true;
    },
    merged(tools: WebMcpTool[]): WebMcpTool[] {
      if (frames.size === 0) return tools;
      const out = tools.filter((tool) => !frames.has(frameOf(tool)));
      for (const frame of frames.values()) out.push(...frame.tools);
      return out;
    },
    reset(): void {
      frames.clear();
      topOrigin = undefined;
      epoch++;
    },
    apply(event: ToolsChanged): Promise<void> {
      const at = epoch;
      changes = changes.then(() => applyNow(event, at)).catch(() => {});
      return changes;
    },
  };
}

export function createWebMcpHandler(platform: Platform, options: WebMcpOptions) {
  let cache: CacheEntry | undefined;
  const baseArgs = buildBaseArgs(options);

  const listLimit = Math.max(options.maxOutput, WEBMCP_LIST_FLOOR);
  const { cdp, tab, dialogs } = options;
  const watcher = cdp && tab ? watchJsDialogs(platform, cdp, tab) : undefined;
  const watch = watcher ? reportWatch(tab!, watcher) : undefined;
  const live = createLiveFrames(platform, options);
  const remember = (mark: Mark, entry: CacheEntry) => {
    if (live.keep(mark)) cache = entry;
  };

  async function listRaw(fresh = false): Promise<{
    tools: WebMcpTool[];
    error?: string;
    notFound?: boolean;
    unavailable?: boolean;
  }> {
    const blocked = await blockedNow(watcher, tab, dialogs);
    if (blocked) return { tools: [], error: blocked };

    if (!fresh && cache && Date.now() < cache.expiresAt) {
      return { tools: live.merged(cache.tools), unavailable: cache.unavailable };
    }

    await options.beforeList?.();
    const now = Date.now();
    const mark = live.mark();

    const argv = [options.playwrightCli, 'webmcp-list', '--json', ...baseArgs];
    const result = await runProcess(
      platform,
      argv,
      undefined,
      options.callTimeoutMs,
      listLimit,
      watch
    );

    if (result.exitCode === -1) {
      return { tools: [], error: result.stderr, notFound: true };
    }

    if (result.blocked) {
      return { tools: [], error: result.blocked };
    }

    if (result.exitCode === 124) {
      return {
        tools: [],
        error: timeoutMessage('webmcp-list', options.callTimeoutMs, tab, watcher),
      };
    }

    if (result.exitCode === 2 && UNAVAILABLE_RE.test(result.stderr)) {
      remember(mark, { tools: [], unavailable: true, expiresAt: now + options.ttlMs });
      return { tools: live.merged([]), unavailable: true };
    }

    if (result.exitCode !== 0) {
      return { tools: [], error: result.stderr || `webmcp-list exited ${result.exitCode}` };
    }

    const parsed = parseListOutput(result, listLimit);
    if (!Array.isArray(parsed)) return { tools: [], error: parsed.error };

    if (parsed.length === 0) {
      const gone = await tabGone(platform, options);
      if (gone) return { tools: [], error: gone };
    }

    remember(mark, { tools: parsed, unavailable: false, expiresAt: now + options.ttlMs });
    return { tools: live.merged(parsed) };
  }

  async function getRpcTools(): Promise<ToolListing | null> {
    const { tools, error, notFound, unavailable } = await listRaw();
    if (notFound) return null;
    if (error) return { tools: [], error };
    const late = options.late?.() ?? false;

    const rpcTools: RpcTool[] = [];
    const hidden: Record<string, string> = {};

    for (const { name, tool, peers } of exposedTools(tools)) {
      if (peers.length > 1) continue;
      if (tool.annotations?.consequentialHint && !options.allowConsequential) {
        hidden[name] = hiddenToolMessage(name);
        continue;
      }
      const mapped = bridgeAnnotations(tool, late);
      rpcTools.push({
        name,
        description: buildDescription(tool),
        inputSchema: tool.inputSchema as unknown as JsonObjectSchema,
        annotations: mapped,
      });
    }

    const hint = tools.length === 0 ? options.emptyHint?.(unavailable === true) : undefined;
    return hint ? { tools: rpcTools, hidden, hint } : { tools: rpcTools, hidden };
  }

  async function callTool(name: string, args: unknown): Promise<ToolRunResult> {
    await dialogs?.ready();
    const { tools, error } = await listRaw(true);
    if (error) {
      return { stdout: '', stderr: error, exitCode: 2 };
    }

    const match = exposedTools(tools).find((t) => t.name === name);
    if (!match) {
      return { stdout: '', stderr: `unknown tool: ${name}`, exitCode: 2 };
    }
    if (match.peers.length > 1) {
      throw ambiguityError(name, match.peers);
    }
    const { tool } = match;

    const argv = [options.playwrightCli, 'webmcp-call', tool.name, '-', ...baseArgs];
    if (options.allowConsequential) {
      argv.push('--allow-consequential');
    }

    const stdinData = JSON.stringify(args ?? {});
    const disarm = dialogs?.arm();
    const result = await runProcess(
      platform,
      argv,
      stdinData,
      options.callTimeoutMs,
      options.maxOutput,
      dialogs ? answeringWatch(tab!, dialogs, watcher) : watch
    ).finally(disarm);

    if (result.exitCode === -1) {
      throw new Error(result.stderr || 'playwright-cli not found');
    }

    if (result.blocked) {
      throw new Error(result.blocked);
    }

    if (result.exitCode === 124) {
      throw new Error(timeoutMessage('webmcp-call', options.callTimeoutMs, tab, watcher));
    }

    if (result.exitCode === 2) {
      throw new Error(result.stderr || 'webmcp-call error');
    }

    const meta: Record<string, unknown> = {
      'io.mcpcat/untrusted': true,
      origin: tool.origin,
    };

    if (result.exitCode === 1) {
      return {
        stdout: '',
        stderr: wrapUntrusted(result.stderr || result.stdout),
        exitCode: 1,
        meta,
      };
    }

    const text = wrapUntrusted(result.stdout);
    return { stdout: text, stderr: result.stderr, exitCode: 0, meta };
  }

  function invalidateCache(): void {
    cache = undefined;
    live.reset();
  }

  function close(): void {
    watcher?.close();
  }

  return { getRpcTools, callTool, invalidateCache, applyToolsChanged: live.apply, close };
}
