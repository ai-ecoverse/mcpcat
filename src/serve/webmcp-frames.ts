import type { Platform } from '../platform/types.ts';
import type { AttachEvent } from './attach.ts';
import { HOLDER_STOP_GRACE_MS, type HolderOptions, type HolderStatus } from './holder.ts';
import { runProcess, type WebMcpTool } from './webmcp.ts';
import { childToolAllowed } from './webmcp-policy.ts';

interface Frame {
  event: AttachEvent;
  tools: WebMcpTool[];
}

function descendant(event: AttachEvent, frameId: string | undefined): boolean {
  return (
    Array.isArray(event.ancestors) &&
    event.ancestors.some((ancestor) => ancestor?.frameId === frameId)
  );
}

function admitted(event: AttachEvent, options: HolderOptions, state: HolderStatus): boolean {
  const top = Array.isArray(event.ancestors) ? event.ancestors[0] : undefined;
  return (
    top?.loaderId === state.loaderId &&
    (event.origin === top?.origin || Boolean(options.fromOrigins?.includes(event.origin ?? '')))
  );
}

export function createWebMcpFrames(
  platform: Platform,
  options: HolderOptions,
  state: HolderStatus,
  session: string,
  key: string,
  changed: () => void
) {
  const frames = new Map<string, Frame>();
  const requests = new Map<string, { frame: Frame; resolve(): void }>();
  let attachmentId: string | undefined;
  let sequence = 0;
  const selectors = (event: AttachEvent): string[] => {
    if (!attachmentId || !event.frameId || !event.loaderId)
      throw new Error('WebMCP attachment document is unavailable');
    return [
      '-s',
      session,
      '--attachment',
      attachmentId,
      '--frame',
      event.frameId,
      '--loader',
      event.loaderId,
    ];
  };
  const evaluate = async (
    event: AttachEvent,
    expression: string,
    timeout: number,
    watch?: () => string | undefined
  ) => {
    const argv = [options.playwrightCli];
    if (options.cdp) argv.push('--cdp', options.cdp);
    argv.push('eval', expression, '--tab', options.tab, ...selectors(event));
    return runProcess(platform, argv, undefined, timeout, 1_048_576, watch);
  };
  const remove = (frameId: string | undefined) => {
    for (const [id, frame] of frames)
      if (id === frameId || descendant(frame.event, frameId)) frames.delete(id);
  };
  const message = (event: AttachEvent) => {
    const frame = event.frameId && frames.get(event.frameId);
    if (!frame || frame.event.loaderId !== event.loaderId) return;
    const payload = event.payload as Record<string, unknown> | null;
    if (payload?.type !== 'tools-changed' || !Array.isArray(payload.tools)) return;
    frame.event = event;
    const previous = JSON.stringify(frame.tools);
    frame.tools = admitted(event, options, state)
      ? (payload.tools as WebMcpTool[])
          .filter(
            (tool) =>
              tool && typeof tool.name === 'string' && childToolAllowed(event, tool.exposedTo)
          )
          .map((tool) => ({
            ...tool,
            origin: event.origin!,
            frameId: event.frameId,
            loaderId: event.loaderId,
            policy: 'allowed',
            late: true,
            topOrigin: (event.ancestors as { origin: string }[])[0]!.origin,
          }))
      : [];
    const request =
      typeof payload.requestId === 'string' ? requests.get(payload.requestId) : undefined;
    if (request?.frame === frame) request.resolve();
    if (JSON.stringify(frame.tools) !== previous) changed();
  };
  const refresh = async (frame: Frame, watch?: () => string | undefined) => {
    const id = String(++sequence);
    let received = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const response = new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(timer);
        requests.delete(id);
        resolve();
      };
      timer = setTimeout(done, options.readyTimeoutMs);
      requests.set(id, {
        frame,
        resolve() {
          received = true;
          done();
        },
      });
    });
    try {
      const result = await evaluate(
        frame.event,
        `globalThis[${JSON.stringify(key)}]?.refresh(${JSON.stringify(id)})`,
        options.readyTimeoutMs,
        watch
      );
      if (result.exitCode !== 0) {
        frame.tools = [];
        requests.get(id)?.resolve();
      }
      await response;
      if (!received) frame.tools = [];
    } catch {
      frame.tools = [];
      requests.get(id)?.resolve();
    }
  };
  return {
    attachment(id: string | undefined) {
      state.crossOriginOff = false;
      attachmentId = id;
      frames.clear();
    },
    reset() {
      frames.clear();
    },
    event(event: AttachEvent) {
      if (event.event === 'document-ready' && event.frameId) {
        remove(event.frameId);
        frames.set(event.frameId, { event, tools: [] });
        changed();
      } else if (event.event === 'message') message(event);
      else if (event.event === 'refused') {
        remove(event.frameId);
        if (event.reason === 'cross-origin child tools are unavailable')
          state.crossOriginOff = true;
        changed();
      }
    },
    tools: () => [...frames.values()].flatMap((frame) => frame.tools),
    refresh: (watch?: () => string | undefined) =>
      Promise.all([...frames.values()].map((frame) => refresh(frame, watch))),
    callArgs(tool: WebMcpTool) {
      if (typeof tool.frameId !== 'string') return [];
      const frame = frames.get(tool.frameId);
      if (
        !frame ||
        frame.event.loaderId !== tool.loaderId ||
        !admitted(frame.event, options, state) ||
        !childToolAllowed(frame.event, tool.exposedTo)
      )
        throw new Error('WebMCP child tool permission changed');
      return selectors(frame.event);
    },
    async dispose() {
      await Promise.all(
        [...frames.values()].map(async (frame) => {
          await evaluate(
            frame.event,
            `globalThis[${JSON.stringify(key)}]?.dispose()`,
            HOLDER_STOP_GRACE_MS
          ).catch(() => {});
        })
      );
    },
  };
}
