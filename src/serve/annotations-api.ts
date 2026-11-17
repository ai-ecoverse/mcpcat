type Json = string | number | boolean | null;

interface ControlDef {
  type: string;
  label: string;
  callback: string;
  reference?: string;
  currentValue?: Json;
  defaultValue?: Json;
  min?: number;
  max?: number;
  step?: number;
  options?: { label: string; value: string }[];
}

interface Registration {
  targets: Set<Element>;
  controls: ControlDef[];
  heading?: string;
  mode: string;
  disposed: boolean;
}

interface HitResult {
  id: string;
  name?: string;
  role?: string;
  metadata?: Record<string, Json>;
  rect?: { x: number; y: number; width: number; height: number };
}

interface SurfaceOptions {
  element: HTMLElement;
  hitTest(point: { clientX: number; clientY: number; signal: AbortSignal }): unknown;
  renderSelection?(state: { hoveredId: string | null; selectedId: string | null }): void;
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: injected into the page as one self-contained function
export function annotationApi(channel: string): void {
  const doc = document as Document & { oai?: Record<string, unknown> };
  if (doc.oai && typeof doc.oai === 'object' && 'annotation' in doc.oai) return;
  const name = (kind: string) => `${channel}:${kind}`;
  const emit = (target: EventTarget, kind: string, detail: unknown) =>
    target.dispatchEvent(new CustomEvent(name(kind), { detail: JSON.stringify(detail) }));
  const read = (event: Event): Record<string, unknown> => {
    try {
      const value = JSON.parse(String((event as CustomEvent).detail));
      return value && typeof value === 'object' ? value : {};
    } catch {
      return {};
    }
  };
  const on = (
    kind: string,
    handler: (target: Element | Document, data: Record<string, unknown>) => void
  ) =>
    document.addEventListener(
      name(kind),
      (event) => {
        const target = event.target;
        if (target instanceof Element || target instanceof Document) handler(target, read(event));
      },
      true
    );

  let active = false;
  let editor = false;
  const registrations = new Set<Registration>();
  const surfaces = new Map<
    string,
    SurfaceOptions & { inflight?: AbortController; busy: boolean }
  >();
  let surfaceSeq = 0;

  const word = /^[A-Za-z][A-Za-z0-9_-]*$/;
  const reference = /^[A-Za-z0-9_./:@$#-]{1,80}$/;
  const plainText = (value: unknown) =>
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.trim().length <= 80 &&
    !/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(value);
  const hex = (value: unknown) =>
    typeof value === 'string' && /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value);
  const finite = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 10_000;

  const fail = (message: string): never => {
    throw new TypeError(message);
  };
  const checkRange = (control: ControlDef, starts: unknown[]) => {
    const min = control.min as number;
    const max = control.max as number;
    const step = control.step;
    if (!finite(min) || !finite(max) || min >= max) fail('range needs finite min < max');
    if (typeof step !== 'number' || step < 0.001 || step > 10_000 || step > max - min)
      fail('range step out of bounds');
    if (starts.some((v) => !finite(v) || (v as number) < min || (v as number) > max))
      fail('range value out of bounds');
  };
  const checkSelect = (control: ControlDef, starts: unknown[]) => {
    const options = control.options;
    if (!Array.isArray(options) || options.length < 1 || options.length > 12)
      fail('select needs 1-12 options');
    const values = new Set<string>();
    for (const option of options as { label: string; value: string }[]) {
      const ok =
        option &&
        plainText(option.label) &&
        typeof option.value === 'string' &&
        option.value.length <= 512;
      if (!ok) fail('invalid select option');
      if (values.has(option.value)) fail('duplicate select value');
      values.add(option.value);
    }
    if (starts.some((v) => typeof v !== 'string' || !values.has(v)))
      fail('select value must match an option');
  };
  const checkers: Record<string, (control: ControlDef, starts: unknown[]) => void> = {
    range: checkRange,
    select: checkSelect,
    color: (_c, starts) => {
      if (!starts.every(hex)) fail('color values must be hex');
    },
    toggle: (_c, starts) => {
      if (!starts.every((v) => typeof v === 'boolean')) fail('toggle values must be booleans');
    },
  };
  const checkControl = (control: ControlDef, callbacks: Set<string>) => {
    if (!control || typeof control !== 'object') fail('control must be an object');
    if (!plainText(control.label)) fail('control label must be 1-80 characters');
    const callback = typeof control.callback === 'string' ? control.callback.trim() : '';
    if (callback.length > 80 || !word.test(callback))
      fail('control callback must start with a letter and use letters, digits, _ or -');
    if (callbacks.has(control.callback)) fail(`duplicate callback ${control.callback}`);
    callbacks.add(control.callback);
    if (
      control.reference !== undefined &&
      !(typeof control.reference === 'string' && reference.test(control.reference))
    )
      fail('control reference must be 1-80 characters without spaces');
    const check = Object.hasOwn(checkers, control.type) ? checkers[control.type] : undefined;
    if (!check) return fail(`unknown control type ${String(control.type)}`);
    check(
      control,
      [control.currentValue, control.defaultValue].filter((v) => v !== undefined)
    );
  };

  const checkControls = (controls: unknown): ControlDef[] => {
    if (!Array.isArray(controls) || controls.length > 12)
      throw new TypeError('controls must be an array of at most 12');
    const callbacks = new Set<string>();
    const copy = JSON.parse(JSON.stringify(controls)) as ControlDef[];
    for (const control of copy) checkControl(control, callbacks);
    if (JSON.stringify(copy).length > 16_384)
      throw new TypeError('controls exceed 16384 characters');
    return copy;
  };

  const targetSet = (targets: unknown): Set<Element> => {
    const list =
      targets instanceof Element
        ? [targets]
        : targets && typeof (targets as Iterable<unknown>)[Symbol.iterator] === 'function'
          ? Array.from(targets as Iterable<unknown>)
          : [];
    if (list.length > 128) throw new TypeError('at most 128 targets');
    for (const t of list)
      if (!(t instanceof Element) || !t.isConnected)
        throw new TypeError('targets must be connected elements');
    return new Set(list as Element[]);
  };

  const heading = (value: unknown) => {
    if (value === undefined) return undefined;
    if (!plainText(value)) throw new TypeError('controlsHeading must be 1-80 characters');
    return (value as string).trim();
  };

  const metadataOf = (value: unknown): Record<string, Json> | undefined => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0 || entries.length > 6) return undefined;
    const out: Record<string, Json> = {};
    for (const [key, v] of entries) {
      if (key.length > 64 || !/^[A-Za-z][A-Za-z0-9_-]*( [A-Za-z0-9_-]+)*$/.test(key))
        return undefined;
      if (
        typeof v === 'string'
          ? v.length > 256
          : !(v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)))
      )
        return undefined;
      out[key] = v as Json;
    }
    return new TextEncoder().encode(JSON.stringify(out)).length <= 2048 ? out : undefined;
  };

  const controlsFor = (element: Element) => {
    let mode = 'extend';
    let title: string | undefined;
    const controls: ControlDef[] = [];
    for (const reg of registrations) {
      if (reg.disposed || !reg.targets.has(element)) continue;
      if (reg.mode === 'replace') mode = 'replace';
      title ??= reg.heading;
      controls.push(...reg.controls);
    }
    return controls.length ? { mode, heading: title, controls } : null;
  };

  let queued: (() => void) | undefined;
  on('hello', () => {
    editor = true;
    const replay = queued;
    queued = undefined;
    replay?.();
  });
  const editorReady = () => {
    if (!editor) emit(document, 'ping', {});
    return editor;
  };
  on('mode', (_target, data) => {
    const next = data.active === true;
    if (next === active) return;
    active = next;
    document.dispatchEvent(new CustomEvent('oaiannotationmodechange', { detail: { active } }));
  });
  on('controls', (target) => {
    emit(target, 'controls:reply', target instanceof Element ? controlsFor(target) : null);
  });
  on('surface', (target) => {
    let found: string | null = null;
    for (const [id, surface] of surfaces)
      if (target instanceof Element && surface.element.contains(target)) found = id;
    emit(target, 'surface:reply', found);
  });
  on('control', (target, data) => {
    const detail: Record<string, unknown> = {
      callback: data.callback,
      value: data.value,
      action: data.action,
    };
    if (data.virtualTarget) detail.virtualTarget = data.virtualTarget;
    target.dispatchEvent(new CustomEvent('oaiannotationcontrolchange', { bubbles: true, detail }));
  });
  on('render', (_target, data) => {
    const surface = surfaces.get(String(data.surfaceId));
    try {
      surface?.renderSelection?.({
        hoveredId: typeof data.hoveredId === 'string' ? data.hoveredId : null,
        selectedId: typeof data.selectedId === 'string' ? data.selectedId : null,
      });
    } catch {}
  });
  const normalizeHit = (hit: unknown): unknown => {
    if (hit === null) return null;
    const h = hit as HitResult;
    if (!h || typeof h !== 'object' || typeof h.id !== 'string' || !h.id) return { fallback: true };
    const rect =
      h.rect && [h.rect.x, h.rect.y, h.rect.width, h.rect.height].every(Number.isFinite)
        ? h.rect
        : undefined;
    return {
      id: h.id,
      name: typeof h.name === 'string' ? h.name.slice(0, 80) : undefined,
      role: typeof h.role === 'string' ? h.role.slice(0, 80) : undefined,
      metadata: metadataOf(h.metadata),
      rect,
    };
  };
  const runHitTest = (
    surface: SurfaceOptions & { inflight?: AbortController; busy: boolean },
    data: Record<string, unknown>
  ) => {
    surface.inflight?.abort();
    const controller = new AbortController();
    surface.inflight = controller;
    surface.busy = true;
    const timer = setTimeout(() => controller.abort(), 250);
    const settle = (value: unknown) => {
      clearTimeout(timer);
      surface.busy = false;
      return value;
    };
    try {
      const value = surface.hitTest({
        clientX: Number(data.clientX),
        clientY: Number(data.clientY),
        signal: controller.signal,
      });
      return Promise.resolve(value).then(
        (hit) => settle(normalizeHit(hit)),
        () => settle({ fallback: true })
      );
    } catch {
      return Promise.resolve(settle({ fallback: true }));
    }
  };
  on('hit', (target, data) => {
    const surface = surfaces.get(String(data.surfaceId));
    const reply = (result: unknown) => emit(target, 'hit:reply', { seq: data.seq, result });
    if (surface?.busy) surface.inflight?.abort();
    if (!surface || surface.busy) return reply({ fallback: true });
    void runHitTest(surface, data).then(reply);
  });

  const rangeRequest = (
    range: Range,
    options: Record<string, unknown>,
    common: Record<string, unknown>
  ) => {
    const text = range.toString();
    const rect = range.getBoundingClientRect();
    const node = range.commonAncestorContainer;
    const host = node instanceof Element ? node : node.parentElement;
    const invalid =
      options.mode === 'advanced' ||
      range.collapsed ||
      !text.trim() ||
      text.length > 20_000 ||
      (rect.width === 0 && rect.height === 0) ||
      !host;
    if (invalid) return { accepted: false };
    emit(host, 'request', {
      ...common,
      kind: 'text',
      text,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    });
    return { accepted: true };
  };
  const elementRequest = (
    target: HTMLElement,
    options: Record<string, unknown>,
    common: Record<string, unknown>
  ) => {
    const r = target.getBoundingClientRect();
    if (
      !target.isConnected ||
      r.bottom < 0 ||
      r.right < 0 ||
      r.top > innerHeight ||
      r.left > innerWidth
    )
      return { accepted: false };
    emit(target, 'request', {
      ...common,
      kind: 'element',
      mode: options.mode === 'advanced' ? 'advanced' : 'default',
      metadata:
        target.getRootNode() instanceof ShadowRoot ? undefined : metadataOf(options.metadata),
    });
    return { accepted: true };
  };
  const request = (
    target: unknown,
    options: Record<string, unknown> = {}
  ): { accepted: boolean } => {
    if (!editorReady()) {
      const queueable =
        target instanceof Range || (target instanceof HTMLElement && target.isConnected);
      if (queued || !queueable) return { accepted: false };
      queued = () => request(target, options);
      return { accepted: true };
    }
    const common = {
      comment:
        typeof options.initialComment === 'string'
          ? options.initialComment.slice(0, 240)
          : undefined,
      enter: options.enterAnnotationMode === true,
      omitScreenshot: options.omitScreenshot === true,
    };
    if (target instanceof Range) return rangeRequest(target, options, common);
    if (target instanceof HTMLElement) return elementRequest(target, options, common);
    return { accepted: false };
  };

  const api = {
    request,
    toggle(force?: boolean) {
      if (!editorReady()) return { accepted: false };
      emit(document, 'toggle', { active: typeof force === 'boolean' ? force : !active });
      return { accepted: true };
    },
    isActive() {
      return active;
    },
    registerControls(options: Record<string, unknown>) {
      if (registrations.size >= 64) throw new TypeError('at most 64 registrations per document');
      const reg: Registration = {
        targets: targetSet(options.targets),
        controls: checkControls(options.controls),
        heading: heading(options.controlsHeading),
        mode: options.controlsMode === 'replace' ? 'replace' : 'extend',
        disposed: false,
      };
      if (reg.targets.size === 0) throw new TypeError('at least one target');
      registrations.add(reg);
      return {
        update(patch: Record<string, unknown>) {
          if (reg.disposed) throw new TypeError('registration disposed');
          const next = {
            targets: 'targets' in patch ? targetSet(patch.targets) : reg.targets,
            controls: 'controls' in patch ? checkControls(patch.controls) : reg.controls,
            heading: 'controlsHeading' in patch ? heading(patch.controlsHeading) : reg.heading,
            mode:
              'controlsMode' in patch
                ? patch.controlsMode === 'replace'
                  ? 'replace'
                  : 'extend'
                : reg.mode,
          };
          Object.assign(reg, next);
        },
        dispose() {
          reg.disposed = true;
          registrations.delete(reg);
        },
      };
    },
    registerSurface(options: SurfaceOptions) {
      if (!(options?.element instanceof HTMLElement) || !options.element.isConnected)
        throw new TypeError('surface element must be a connected HTML element');
      if (options.element.getRootNode() instanceof ShadowRoot)
        throw new TypeError('surface element cannot be in shadow DOM');
      if (typeof options.hitTest !== 'function') throw new TypeError('hitTest must be a function');
      const id = `${channel.slice(-8)}-${++surfaceSeq}`;
      surfaces.set(id, { ...options, busy: false });
      return {
        invalidate() {},
        dispose() {
          surfaces.get(id)?.inflight?.abort();
          surfaces.delete(id);
        },
      };
    },
  };
  const oai = (doc.oai && typeof doc.oai === 'object' ? doc.oai : {}) as Record<string, unknown>;
  Object.defineProperty(oai, 'annotation', { value: Object.freeze(api), enumerable: true });
  if (!doc.oai)
    Object.defineProperty(doc, 'oai', { value: oai, configurable: true, enumerable: false });
  emit(document, 'ping', {});
}
