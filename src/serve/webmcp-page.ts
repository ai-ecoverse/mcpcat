import type { ModelContext, PageTool, WebMcpBridge } from './webmcp-api.ts';

export interface PageSnapshot {
  tools: PageTool[];
  unavailable?: boolean;
  mode?: string;
  error?: string;
}

export interface PageBridge {
  refresh(): Promise<PageSnapshot>;
  dispose(): void;
  call(
    name: string,
    input: object,
    allow: boolean,
    origin: string
  ): Promise<Record<string, unknown>>;
}

export function webMcpPage(
  send: (payload: unknown) => void,
  key: string,
  bridge: WebMcpBridge | undefined
): void {
  const doc = document as Document & {
    modelContext?: ModelContext;
    permissionsPolicy?: { features(): string[]; allowsFeature(name: string): boolean };
    featurePolicy?: { features(): string[]; allowsFeature(name: string): boolean };
  };
  const root = globalThis as unknown as Record<string, unknown>;
  const existing = root[key] as Partial<PageBridge> | undefined;
  if (typeof existing?.dispose === 'function') existing.dispose();
  const stringify = JSON.stringify;
  const parse = JSON.parse;
  const apply = Reflect.apply;
  const Target = EventTarget;
  const add = Target.prototype.addEventListener;
  const remove = Target.prototype.removeEventListener;
  const stopTimer = clearInterval;
  const ownOrigin = location.origin;
  let previous = '';
  let listening: ModelContext | undefined;
  let inflight: Promise<PageSnapshot> | undefined;
  let dirty = false;
  let stopped = false;
  const changed = () => void refresh(true);
  const unlisten = () => {
    if (listening instanceof Target) apply(remove, listening, ['toolchange', changed]);
    listening = undefined;
  };
  const permitted = (): boolean | undefined => {
    const policy = doc.permissionsPolicy ?? doc.featurePolicy;
    return policy?.features().includes('tools') ? policy.allowsFeature('tools') : undefined;
  };
  const metadata = (tool: PageTool): PageTool => {
    const annotations = { ...tool.annotations };
    for (const [source, target] of [
      ['readOnly', 'readOnlyHint'],
      ['consequential', 'consequentialHint'],
      ['untrustedContent', 'untrustedContentHint'],
    ]) {
      if (annotations[source!] !== undefined) annotations[target!] = annotations[source!]!;
    }
    return {
      name: tool.name,
      title: tool.title ?? null,
      description: tool.description ?? '',
      inputSchema: tool.inputSchema ?? { type: 'object' },
      origin: tool.origin ?? ownOrigin,
      annotations,
      policy: permitted() === true ? 'allowed' : 'unknown',
    };
  };
  const snapshot = async (): Promise<PageSnapshot> => {
    const api = doc.modelContext;
    const native = 'modelContext' in Document.prototype;
    const mode = native ? 'native' : bridge && !bridge.list().replaced ? 'polyfill' : 'page';
    if (!api || permitted() === false) return { tools: [], unavailable: true, mode };
    if (api !== listening) {
      unlisten();
      listening = api;
      if (api instanceof Target) apply(add, api, ['toolchange', changed]);
    }
    const list = await api.getTools();
    const tools = list
      .filter((tool) => !tool.window || tool.window === window || tool.origin === ownOrigin)
      .map(metadata);
    if (stringify(tools).length > 65536)
      throw new Error('WebMCP tool list exceeds 65536 characters');
    return { tools, mode };
  };
  const readSnapshot = async (): Promise<PageSnapshot> => {
    let value: PageSnapshot;
    do {
      dirty = false;
      try {
        value = await snapshot();
      } catch (error) {
        value = { tools: [], error: String(error).slice(0, 65536) };
      }
    } while (dirty);
    const text = stringify(value);
    if (!stopped && text !== previous) {
      previous = text;
      send({ type: 'tools-changed', origin: ownOrigin, ...parse(text) });
    }
    return value;
  };
  const refresh = (changed = true): Promise<PageSnapshot> => {
    if (stopped) return Promise.resolve({ tools: [], unavailable: true });
    if (changed) dirty = true;
    inflight ??= readSnapshot().finally(() => {
      inflight = undefined;
    });
    return inflight;
  };
  const encodeResult = (result: unknown): string =>
    (typeof result === 'string' ? result : stringify(result ?? null)).slice(0, 65536);
  const validInput = (input: unknown) =>
    input && typeof input === 'object' && !Array.isArray(input);
  const consequential = (tool: PageTool) =>
    tool.annotations?.consequentialHint || tool.annotations?.consequential;
  const inputFor = (api: ModelContext, input: object): unknown => {
    const major = /(?:Chrome|Chromium)\/(\d+)/.exec(navigator.userAgent)?.[1];
    return Number(major) >= 155 && api[Symbol.toStringTag] === 'ModelContext'
      ? input
      : stringify(input);
  };
  const call = async (name: string, input: object, allow: boolean, origin: string) => {
    try {
      if (stopped) return { __webmcp_error: 'absent' };
      if (permitted() === false) return { __webmcp_error: 'tools permission policy denies access' };
      if (location.origin !== origin) return { __webmcp_error: 'document changed' };
      if (!validInput(input)) return { __webmcp_error: 'Tool input must be a JSON object' };
      const api = doc.modelContext;
      if (!api) return { __webmcp_error: 'absent' };
      const tools = (await api.getTools()).filter((tool) => tool.name === name);
      if (tools.length > 1) return { __webmcp_error: 'ambiguous tool name' };
      const tool = tools[0];
      if (!tool) return { __webmcp_error: 'unknown' };
      if (tool.origin && tool.origin !== origin) return { __webmcp_error: 'document changed' };
      if (!allow && consequential(tool))
        return { __webmcp_error: 'consequential', description: tool.description ?? '' };
      const result = await api.executeTool(tool, inputFor(api, input));
      return {
        __webmcp_result: encodeResult(result),
      };
    } catch (error) {
      return { __webmcp_error: 'threw', message: String(error).slice(0, 65536) };
    }
  };
  const dispose = () => {
    stopped = true;
    dirty = false;
    stopTimer(timer);
    unlisten();
    if (root[key] === controller) delete root[key];
  };
  const controller = { refresh, call, dispose };
  const timer = setInterval(() => void refresh(false), 250);
  Object.defineProperty(root, key, { value: controller, configurable: true });
  void refresh(false);
}
