import type { Platform } from '../platform/types.ts';
import { type AttachEvent, startAttachment } from './attach.ts';
import {
  HOLDER_STOP_GRACE_MS,
  type Holder,
  type HolderOptions,
  type HolderStatus,
  type ToolsChanged,
} from './holder.ts';
import { runProcess, type WebMcpTool, wrapUntrusted } from './webmcp.ts';
import { installWebMcp } from './webmcp-api.ts';
import { createWebMcpFrames } from './webmcp-frames.ts';
import { webMcpMetadata, webMcpPage } from './webmcp-page.ts';

export function webMcpScript(key: string, install: boolean, localOnly = false): string {
  return `(${webMcpPage.toString()})(send, ${JSON.stringify(key)}, ${install ? `(${installWebMcp.toString()})()` : 'undefined'}, ${localOnly}, (${webMcpMetadata.toString()}));\n`;
}

export interface AttachedPage extends Holder {
  list(watch?: () => string | undefined): Promise<{
    tools: WebMcpTool[];
    unavailable?: boolean;
    error?: string;
    crossOriginOff?: boolean;
  }>;
  callFile(
    name: string,
    input: unknown,
    allow: boolean,
    origin: string,
    topOrigin?: string
  ): Promise<string>;
  callArgs(tool: WebMcpTool): string[];
  releaseCall(file: string): Promise<void>;
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
  await platform.fs.writeFile(
    file,
    webMcpScript(key, install, Boolean(options.fromOrigins?.length)),
    { mode: 0o600 }
  );
  const evalArgs = (expression: string) => {
    const argv = [options.playwrightCli];
    if (options.cdp) argv.push('--cdp', options.cdp);
    argv.push('-s', session, 'eval', expression, '--tab', options.tab);
    return argv;
  };
  const evaluate = (
    expression: string,
    watch?: () => string | undefined,
    timeoutMs = options.callTimeoutMs ?? options.readyTimeoutMs
  ) => runProcess(platform, evalArgs(expression), undefined, timeoutMs, 1_048_576, watch);
  const native = await evaluate("'modelContext' in Document.prototype");
  const document = documentTracker(options.readyTimeoutMs);
  const state: HolderStatus = { late: false, native: false };
  const documents: (() => void)[] = [];
  const changes: ((event: ToolsChanged) => void)[] = [];
  let snapshot: { tools: WebMcpTool[]; unavailable?: boolean; error?: string } = {
    tools: [],
    unavailable: true,
  };
  let attachmentId: string | undefined;
  const frames = createWebMcpFrames(platform, options, state, session, key, () => {
    for (const listener of changes) listener({});
  });
  const reset = () => {
    frames.reset();
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
    if (event.attachmentId && attachmentId && event.attachmentId !== attachmentId) return;
    if (event.event === 'ready') {
      attachmentId = event.attachmentId;
      state.crossOriginOff = false;
      frames.attachment(attachmentId);
      reset();
    } else if (event.event === 'disconnected') {
      attachmentId = undefined;
      frames.attachment(undefined);
      state.loaderId = undefined;
      reset();
    } else if (event.parentFrameId || (event.frameId && event.frameId !== options.tab)) {
      frames.event(event);
    } else if (event.event === 'document-ready') {
      state.loaderId = event.loaderId;
      state.late = false;
      state.refused = false;
      state.error = undefined;
      reset();
      document.observed();
    } else if (event.event === 'refused') {
      state.late = event.reason === 'late';
      state.refused = true;
      state.error = event.reason ?? 'document refused';
      state.loaderId = undefined;
      reset();
      document.observed();
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
    frames: options.fromOrigins?.length ? ['same-origin', ...options.fromOrigins] : undefined,
    label: 'mcpcat serve --webmcp',
    readyTimeoutMs: options.readyTimeoutMs,
    report: options.report,
  });
  attachment.onEvent(onEvent);
  let reload: Promise<void> | undefined;
  const reloadOnce = async () => {
    if (document.revision() === 0 || (state.refused && !state.late)) return;
    const revision = document.revision();
    const result = await evaluate('location.reload()');
    if (result.exitCode === 0) await document.wait(revision);
    else state.error = result.stderr || 'could not reload the tab';
  };
  const calls = createCallFiles(platform, dir, key);
  return {
    async ready() {
      if (!(await attachment.ready())) {
        state.error = 'playwright-cli eval-attach did not report ready';
        return;
      }
      await document.wait(0);
      if (options.reload) await (reload ??= reloadOnce());
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
      await frames.refresh(watch);
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
        value.tools = [...value.tools, ...frames.tools()];
        value.crossOriginOff = state.crossOriginOff;
        return value;
      } catch {
        return { tools: [], error: 'WebMCP eval returned an invalid tool list' };
      }
    },
    callArgs: frames.callArgs,
    callFile: calls.callFile,
    releaseCall: calls.releaseCall,
    async stop() {
      await frames.dispose();
      await attachment.stop();
      await evaluate(
        `globalThis[${JSON.stringify(key)}]?.dispose()`,
        undefined,
        Math.min(options.readyTimeoutMs, HOLDER_STOP_GRACE_MS)
      ).catch(() => {});
      await calls.close();
      if (platform.fs.unlink) {
        await platform.fs.unlink(file).catch(() => {});
        await platform.fs.rmdir(dir).catch(() => {});
      }
    },
  };
}

function createCallFiles(platform: Platform, dir: string, key: string) {
  const callFiles = new Set<string>();
  let callId = 0;
  const releaseCall = async (file: string) => {
    if (!callFiles.delete(file)) return;
    await platform.fs.unlink?.(file).catch(() => {});
  };
  return {
    async callFile(
      name: string,
      input: unknown,
      allow: boolean,
      origin: string,
      topOrigin?: string
    ) {
      const path = `${dir}/call-${++callId}.js`;
      const request = JSON.stringify({ name, input: input ?? {}, allow, origin, topOrigin });
      const source = `(async () => { const request = JSON.parse(${JSON.stringify(request)}); const bridge = globalThis[${JSON.stringify(key)}]; return bridge ? await bridge.call(request.name, request.input, request.allow, request.origin, request.topOrigin) : { __webmcp_error: 'absent' }; })()`;
      callFiles.add(path);
      try {
        await platform.fs.writeFile(path, source, { mode: 0o600 });
      } catch (error) {
        await releaseCall(path);
        throw error;
      }
      return path;
    },
    releaseCall,
    close: () => Promise.all([...callFiles].map(releaseCall)),
  };
}

function documentTracker(timeout: number) {
  let revision = 0;
  const waiters = new Set<() => void>();
  return {
    revision: () => revision,
    observed() {
      revision++;
      for (const resolve of waiters) resolve();
    },
    wait(after: number): Promise<void> {
      if (revision > after) return Promise.resolve();
      return new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          waiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, timeout);
        waiters.add(done);
      });
    },
  };
}
