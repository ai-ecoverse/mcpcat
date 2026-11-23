export interface ToolOptions {
  signal?: AbortSignal;
}

export interface RegisterToolOptions extends ToolOptions {
  exposedTo?: string[];
}

export interface PageTool {
  name: string;
  title?: string | null;
  description?: string;
  inputSchema?: Record<string, unknown> | null;
  outputSchema?: Record<string, unknown> | null;
  annotations?: Record<string, boolean> | null;
  exposedTo?: string[];
  origin?: string;
  policy?: 'allowed' | 'unknown';
  source?: Window | null;
  window?: Window;
  execute?(input: object, options: ToolOptions): unknown;
}

interface Entry {
  execute: NonNullable<PageTool['execute']>;
  name: string;
  title: string | null;
  description: string;
  inputSchema: string | null;
  outputSchema: string | null;
  annotations: Record<string, boolean> | null;
  exposedTo: string[];
  signal?: AbortSignal;
  onabort?: () => void;
}

interface ToolSlot {
  entry: Entry;
  values: Record<string, unknown>;
}

export interface ModelContext extends EventTarget {
  [Symbol.toStringTag]?: string;
  ontoolchange: ((event: Event) => void) | null;
  getTools(): Promise<PageTool[]>;
  executeTool(tool: PageTool, input?: unknown, options?: ToolOptions): Promise<string>;
}

export interface WebMcpBridge {
  list(): { error?: string; toolsJson?: string; changes?: number; replaced?: boolean };
  call(name: string, input: unknown, allow: boolean): Promise<Record<string, unknown>>;
}

export function installWebMcp(): WebMcpBridge | undefined {
  if (
    !isSecureContext ||
    'modelContext' in Document.prototype ||
    'modelContext' in document ||
    'modelContext' in navigator
  )
    return;
  const apply = Reflect.apply;
  const define = Object.defineProperty;
  const descriptor = Object.getOwnPropertyDescriptor;
  const parse = JSON.parse;
  const stringify = JSON.stringify;
  const isArray = Array.isArray;
  const then = Promise.prototype.then;
  const StringValue = String;
  const ErrorValue = DOMException;
  const Controller = AbortController;
  const PromiseValue = Promise;
  const resolve = Promise.resolve.bind(Promise);
  const mapGet = Map.prototype.get;
  const mapSet = Map.prototype.set;
  const mapDelete = Map.prototype.delete;
  const mapValues = Map.prototype.values;
  const iteratorNext = Object.getPrototypeOf(new Map().values()).next;
  const push = Array.prototype.push;
  const sort = Array.prototype.sort;
  const slice = String.prototype.slice;
  const add = EventTarget.prototype.addEventListener;
  const remove = EventTarget.prototype.removeEventListener;
  const dispatch = EventTarget.prototype.dispatchEvent;
  const EventValue = Event;
  const abort = AbortController.prototype.abort;
  const create = Object.create;
  const reject = Promise.reject.bind(Promise);
  const slotGet = WeakMap.prototype.get;
  const slotSet = WeakMap.prototype.set;
  const ownOrigin = location.origin;
  const registry = new Map<string, Entry>();
  const slots = new WeakMap<object, ToolSlot>();
  const context = new EventTarget() as ModelContext;
  const cap = 65536;
  let changes = 0;
  const bounded = (value: unknown) => apply(slice, StringValue(value), [0, cap]);
  const copy = <T>(value: T): T => parse(stringify(value));
  const schemaText = (value: unknown, label: string) => {
    if (value === undefined) return null;
    if (typeof value !== 'object' || value === null || isArray(value))
      throw new TypeError(`${label} must be an object`);
    return stringify(value);
  };
  const hints = (value: Record<string, boolean> | null | undefined) => {
    if (value === undefined || value === null) return null;
    const pick = (hint: string, legacy: string) =>
      Boolean(value[legacy] !== undefined ? value[legacy] : value[hint]);
    return {
      readOnlyHint: pick('readOnlyHint', 'readOnly'),
      untrustedContentHint: pick('untrustedContentHint', 'untrustedContent'),
      consequentialHint: pick('consequentialHint', 'consequential'),
      debugging: Boolean(value.debugging),
    };
  };
  const toolPrototype = create(Object.prototype) as object;
  for (const field of [
    'name',
    'title',
    'description',
    'inputSchema',
    'outputSchema',
    'source',
    'origin',
    'annotations',
  ])
    define(toolPrototype, field, {
      configurable: true,
      enumerable: true,
      get(this: object) {
        const slot = apply(slotGet, slots, [this]) as ToolSlot | undefined;
        if (!slot) throw new TypeError('Illegal invocation');
        return slot.values[field];
      },
    });
  define(toolPrototype, Symbol.toStringTag, { configurable: true, value: 'Tool' });
  const createTool = (entry: Entry) => {
    const tool = create(toolPrototype) as PageTool;
    apply(slotSet, slots, [
      tool,
      {
        entry,
        values: {
          name: entry.name,
          title: entry.title ?? '',
          description: entry.description,
          inputSchema: entry.inputSchema === null ? null : parse(entry.inputSchema),
          outputSchema: entry.outputSchema === null ? null : parse(entry.outputSchema),
          source: window,
          origin: ownOrigin,
          annotations: entry.annotations === null ? null : copy(entry.annotations),
        },
      },
    ]);
    return tool;
  };
  const describe = (entry: Entry): PageTool => ({
    name: entry.name,
    title: entry.title,
    description: entry.description,
    inputSchema: entry.inputSchema === null ? null : parse(entry.inputSchema),
    outputSchema: entry.outputSchema === null ? null : parse(entry.outputSchema),
    annotations: entry.annotations === null ? null : copy(entry.annotations),
    origin: ownOrigin,
    exposedTo: copy(entry.exposedTo),
  });
  const entries = () => {
    const result: Entry[] = [];
    const iterator = apply(mapValues, registry, []);
    for (;;) {
      const entry = apply(iteratorNext, iterator, []) as IteratorResult<Entry>;
      if (entry.done) break;
      apply(push, result, [entry.value]);
    }
    apply(sort, result, [(a: Entry, b: Entry) => (a.name < b.name ? -1 : 1)]);
    return result;
  };
  const changed = () => {
    changes += 1;
    const event = new EventValue('toolchange');
    apply(dispatch, context, [event]);
    if (typeof context.ontoolchange === 'function') context.ontoolchange(event);
  };
  const unregister = (entry: Entry) => {
    if (apply(mapGet, registry, [entry.name]) !== entry) return;
    apply(mapDelete, registry, [entry.name]);
    if (entry.signal) apply(remove, entry.signal, ['abort', entry.onabort]);
    changed();
  };
  const register = (tool: PageTool, options: RegisterToolOptions = {}) => {
    if (!tool || typeof tool.name !== 'string' || !tool.name || typeof tool.execute !== 'function')
      throw new TypeError('A tool needs a name and execute function');
    if (apply(mapGet, registry, [tool.name]))
      throw new ErrorValue('Duplicate tool name', 'InvalidStateError');
    const inputSchema = schemaText(tool.inputSchema, 'inputSchema');
    const outputSchema = schemaText(tool.outputSchema, 'outputSchema');
    if (options.signal?.aborted) throw options.signal.reason;
    const entry: Entry = {
      execute: tool.execute,
      name: tool.name,
      title: tool.title ?? null,
      description: tool.description ?? '',
      inputSchema,
      outputSchema,
      annotations: hints(tool.annotations),
      exposedTo: copy(options.exposedTo ?? tool.exposedTo ?? []),
      signal: options.signal,
    };
    entry.onabort = () => unregister(entry);
    if (entry.signal) apply(add, entry.signal, ['abort', entry.onabort, { once: true }]);
    apply(mapSet, registry, [entry.name, entry]);
    changed();
  };
  const registerTool = (tool: PageTool, options: RegisterToolOptions = {}) => {
    try {
      register(tool, options);
    } catch (error) {
      return reject(error);
    }
    return resolve(undefined);
  };
  const getTools = async () => {
    const tools: PageTool[] = [];
    const records = entries();
    for (let index = 0; index < records.length; index += 1)
      apply(push, tools, [createTool(records[index])]);
    for (let index = 0; index < window.frames.length; index += 1) {
      try {
        const child = window.frames[index] as Window & {
          document: Document & { modelContext?: ModelContext };
        };
        if (child.location.origin !== ownOrigin || !child.document.modelContext) continue;
        const nested = await child.document.modelContext.getTools();
        for (let at = 0; at < nested.length; at += 1) apply(push, tools, [nested[at]]);
      } catch {}
    }
    apply(sort, tools, [
      (a: PageTool, b: PageTool) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    ]);
    return tools;
  };
  const run = async (entry: Entry, input: unknown, options: ToolOptions = {}) => {
    const signal = options.signal;
    if (signal?.aborted) throw new ErrorValue('Tool invocation aborted', 'AbortError');
    const controller = new Controller();
    let onabort: (() => void) | undefined;
    try {
      return await new PromiseValue<string>((fulfill, rejected) => {
        onabort = () => {
          apply(abort, controller, []);
          rejected(new ErrorValue('Tool invocation aborted', 'AbortError'));
        };
        if (signal) apply(add, signal, ['abort', onabort, { once: true }]);
        const parsed = input === undefined ? {} : typeof input === 'string' ? parse(input) : input;
        if (!parsed || typeof parsed !== 'object' || isArray(parsed))
          throw new TypeError('Tool input must be an object');
        apply(then, resolve(entry.execute(parsed, { signal: controller.signal })), [
          (result: unknown) =>
            fulfill(typeof result === 'string' ? result : stringify(result ?? null)),
          (error: unknown) => rejected(new ErrorValue(bounded(error), 'UnknownError')),
        ]);
      });
    } catch (error) {
      if (
        error instanceof ErrorValue &&
        (error.name === 'AbortError' || error.name === 'UnknownError')
      )
        throw error;
      throw new ErrorValue(bounded(error), 'UnknownError');
    } finally {
      if (signal && onabort) apply(remove, signal, ['abort', onabort]);
    }
  };
  const executeTool = async (tool: PageTool, input?: unknown, options: ToolOptions = {}) => {
    const object = typeof tool === 'object' && tool !== null;
    const slot = object ? (apply(slotGet, slots, [tool]) as ToolSlot | undefined) : undefined;
    if (slot) {
      if (apply(mapGet, registry, [slot.entry.name]) !== slot.entry)
        throw new ErrorValue('Unknown tool', 'NotFoundError');
      return run(slot.entry, input, options);
    }
    const source = object ? (tool.source ?? tool.window) : undefined;
    if (!source || source === window)
      throw new TypeError("Failed to execute 'executeTool': parameter 1 is not of type 'Tool'.");
    let target: ModelContext | undefined;
    try {
      if (source.location.origin === ownOrigin)
        target = (source.document as Document & { modelContext?: ModelContext }).modelContext;
    } catch {}
    if (!target) throw new ErrorValue('Cross-origin tool access is not allowed', 'SecurityError');
    return target.executeTool(tool, input, options);
  };
  define(context, '__slicc_webmcp_shim', { value: true });
  define(context, Symbol.toStringTag, { value: 'ModelContext' });
  define(context, 'registerTool', { value: registerTool });
  define(context, 'unregisterTool', {
    value: (name: string) => {
      const entry = apply(mapGet, registry, [name]);
      if (entry) unregister(entry);
    },
  });
  const clearContext = () => {
    for (const entry of entries()) unregister(entry);
  };
  define(context, 'clearContext', { value: clearContext });
  define(context, 'provideContext', {
    value: (value: { tools?: PageTool[] }) => {
      clearContext();
      for (const tool of value.tools ?? []) register(tool);
    },
  });
  define(context, 'getTools', { value: getTools });
  define(context, 'executeTool', { value: executeTool });
  context.ontoolchange = null;
  const alias = (owner: Document | Navigator, prototype: object) => {
    define(owner, 'modelContext', {
      configurable: true,
      get() {
        const native = descriptor(prototype, 'modelContext');
        return native?.get ? apply(native.get, this, []) : context;
      },
      set(value) {
        define(owner, 'modelContext', { configurable: true, writable: true, value });
      },
    });
  };
  alias(document, Document.prototype);
  alias(navigator, Navigator.prototype);
  return {
    list() {
      const described: PageTool[] = [];
      const records = entries();
      for (let index = 0; index < records.length; index += 1)
        apply(push, described, [describe(records[index])]);
      const tools = stringify(described);
      if (tools.length > cap) return { error: 'limit' };
      return {
        toolsJson: tools,
        changes,
        replaced: (document as Document & { modelContext?: ModelContext }).modelContext !== context,
      };
    },
    async call(name: string, input: unknown, allowConsequential: boolean) {
      const entry = apply(mapGet, registry, [name]);
      if (!entry) return { __webmcp_error: 'unknown' };
      if (!allowConsequential && entry.annotations?.consequentialHint)
        return {
          __webmcp_error: 'consequential',
          description: bounded(entry.description),
        };
      try {
        return { __webmcp_result: bounded(await run(entry, input)) };
      } catch (error) {
        return { __webmcp_error: 'threw', message: bounded(error) };
      }
    },
  };
}
