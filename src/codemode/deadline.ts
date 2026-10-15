type CreateOptions = { wasm?: unknown; interruptHandler?: () => boolean };
type QuickJSClass = { create(options: CreateOptions): Promise<unknown> };

const expiries = new WeakMap<object, () => boolean>();
const hooked = new WeakSet<QuickJSClass>();

export function hookDeadlines(quickjs: QuickJSClass): void {
  if (hooked.has(quickjs)) return;
  hooked.add(quickjs);
  const create = quickjs.create.bind(quickjs);
  quickjs.create = (options) => {
    const expired = options.wasm ? expiries.get(options.wasm) : undefined;
    const inner = options.interruptHandler;
    if (!expired || !inner) return create(options);
    return create({ ...options, interruptHandler: () => expired() || inner() });
  };
}

export interface Deadline {
  start(): void;
  readonly tripped: boolean;
}

export function bindDeadline(wasm: object, timeoutMs: number, now = Date.now): Deadline {
  let endsAt = Number.POSITIVE_INFINITY;
  let tripped = false;
  expiries.set(wasm, () => {
    if (!tripped && now() >= endsAt) tripped = true;
    return tripped;
  });
  return {
    start() {
      endsAt = now() + timeoutMs;
    },
    get tripped() {
      return tripped;
    },
  };
}
