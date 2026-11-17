import type { Platform } from '../platform/types.ts';
import { type AttachEvent, startAttachment } from './attach.ts';
import { runProcess, type WebMcpTool, wrapUntrusted } from './webmcp.ts';
import { installWebMcp } from './webmcp-api.ts';
import { webMcpPage } from './webmcp-page.ts';
import type { Holder, HolderOptions, HolderStatus, ToolsChanged } from './webmcp-polyfill.ts';

export function webMcpScript(key: string, install: boolean): string {
  return `(${webMcpPage.toString()})(send, ${JSON.stringify(key)}, ${install ? `(${installWebMcp.toString()})()` : 'undefined'});\n`;
}

export interface AttachedPage extends Holder {
  list(
    watch?: () => string | undefined
  ): Promise<{ tools: WebMcpTool[]; unavailable?: boolean; error?: string }>;
  callExpression(name: string, input: unknown, allow: boolean, origin: string): string;
}

export async function attachWebMcp(
  platform: Platform,
  options: HolderOptions & { callTimeoutMs?: number },
  install: boolean
): Promise<AttachedPage> {
  const token = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('');
  const session = `mcpcat-webmcp-${token}`;
  const key = `__mcpcat_webmcp_${token}`;
  const dir = `${(platform.env.TMPDIR ?? '/tmp').replace(/\/+$/, '')}/${session}`;
  const file = `${dir}/api.js`;
  await platform.fs.mkdirExclusive(dir);
  await platform.fs.writeFile(file, webMcpScript(key, install), { mode: 0o600 });
  const evalArgs = (expression: string) => {
    const argv = [options.playwrightCli];
    if (options.cdp) argv.push('--cdp', options.cdp);
    argv.push('eval', expression, '--tab', options.tab);
    return argv;
  };
  const evaluate = (expression: string, watch?: () => string | undefined) =>
    runProcess(
      platform,
      evalArgs(expression),
      undefined,
      options.callTimeoutMs ?? options.readyTimeoutMs,
      1_048_576,
      watch
    );
  const native = await evaluate("'modelContext' in Document.prototype");
  let documentReady: (() => void) | undefined;
  const state: HolderStatus = { late: false, native: false };
  const documents: (() => void)[] = [];
  const changes: ((event: ToolsChanged) => void)[] = [];
  let snapshot: { tools: WebMcpTool[]; unavailable?: boolean; error?: string } = {
    tools: [],
    unavailable: true,
  };
  const reset = () => {
    snapshot = { tools: [], unavailable: true };
    for (const listener of documents) listener();
  };
  const onMessage = (event: AttachEvent) => {
    if (state.refused || !event.payload || typeof event.payload !== 'object') return;
    if (state.loaderId && event.loaderId !== state.loaderId) return;
    const payload = event.payload as Record<string, unknown>;
    if (payload.type !== 'tools-changed' || !Array.isArray(payload.tools)) return;
    state.mode = typeof payload.mode === 'string' ? payload.mode : undefined;
    state.native = state.mode === 'native';
    snapshot = {
      tools: payload.tools as WebMcpTool[],
      unavailable: payload.unavailable === true,
      error: typeof payload.error === 'string' ? payload.error : undefined,
    };
    for (const listener of changes)
      listener({
        frameId: options.tab,
        loaderId: event.loaderId,
        origin: payload.origin,
        tools: payload.tools,
      });
  };
  const onEvent = (event: AttachEvent) => {
    if (event.tab && event.tab !== options.tab) return;
    if (event.event === 'document-ready') {
      state.loaderId = event.loaderId;
      state.late = false;
      state.refused = false;
      state.error = undefined;
      reset();
      documentReady?.();
    } else if (event.event === 'refused') {
      state.late = event.reason === 'late';
      state.refused = true;
      state.error = event.reason ?? 'document refused';
      state.loaderId = undefined;
      reset();
      void options.report(
        `mcpcat serve --webmcp: eval-attach refused tab ${options.tab} (${state.error}); ${state.late ? 'reload the tab or use --webmcp-reload to install before its first script' : 'tools are unavailable in this document'}\n`
      );
    } else if (event.event === 'message') onMessage(event);
  };

  const attachment = startAttachment(platform, {
    playwrightCli: options.playwrightCli,
    cdp: options.cdp,
    session,
    file,
    scope: { tab: options.tab },
    world: 'main',
    early: install && native.stdout.trim() !== 'true',
    label: 'mcpcat serve --webmcp',
    readyTimeoutMs: options.readyTimeoutMs,
    report: options.report,
  });
  attachment.onEvent(onEvent);
  return {
    async ready() {
      if (!(await attachment.ready()))
        state.error = 'playwright-cli eval-attach did not report ready';
      if (options.reload) {
        options = { ...options, reload: false };
        let timer: ReturnType<typeof setTimeout> | undefined;
        const loaded = new Promise<void>((resolve) => {
          documentReady = resolve;
          timer = setTimeout(resolve, options.readyTimeoutMs);
        });
        const result = await evaluate('location.reload()');
        if (result.exitCode === 0) await loaded;
        clearTimeout(timer);
        documentReady = undefined;
        if (result.exitCode !== 0) state.error = result.stderr || 'could not reload the tab';
      }
    },
    status: () => ({ ...state }),
    onDocument: (listener) => {
      documents.push(listener);
    },
    onToolsChanged: (listener) => {
      changes.push(listener);
    },
    async list(watch) {
      if (state.refused) return snapshot;
      const result = await evaluate(
        `(async () => { const bridge = globalThis[${JSON.stringify(key)}]; return bridge ? await bridge.refresh() : { tools: [], unavailable: true }; })()`,
        watch
      );
      if (result.exitCode !== 0)
        return {
          tools: [],
          error: result.blocked ?? wrapUntrusted(result.stderr || 'WebMCP listing failed'),
        };
      try {
        const value = JSON.parse(result.stdout);
        if (!value || !Array.isArray(value.tools)) throw new Error('invalid snapshot');
        if (typeof value.error === 'string') value.error = wrapUntrusted(value.error);
        return value;
      } catch {
        return { tools: [], error: 'WebMCP eval returned an invalid tool list' };
      }
    },
    callExpression: (name, input, allow, origin) =>
      `(async () => { const bridge = globalThis[${JSON.stringify(key)}]; return bridge ? await bridge.call(${JSON.stringify(name)}, ${JSON.stringify(input ?? {})}, ${allow}, ${JSON.stringify(origin)}) : { __webmcp_error: 'absent' }; })()`,
    async stop() {
      await attachment.stop();
      if (platform.fs.unlink) {
        await platform.fs.unlink(file).catch(() => {});
        await platform.fs.rmdir(dir).catch(() => {});
      }
    },
  };
}
