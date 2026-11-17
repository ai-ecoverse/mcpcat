type Json = string | number | boolean | null;
type Send = (payload: unknown) => void;

interface Control {
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

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Pick {
  kind: 'element' | 'page' | 'text' | 'virtual';
  element: Element;
  name?: string;
  rect: Rect;
  metadata?: Record<string, Json>;
  text?: string;
  surfaceId?: string;
  targetId?: string;
  role?: string;
}

interface Live {
  pick: Pick;
  controls: Control[];
  heading?: string;
  values: Map<string, Json>;
  previewed: Set<string>;
}

// biome-ignore lint/complexity/noExcessiveLinesPerFunction: injected into the page as one self-contained function
export function annotationEditor(channel: string, send: Send, guarded = true): void {
  const flag = `__mcpcat_annotations_${channel}`;
  const scope = globalThis as unknown as Record<string, unknown>;
  if (scope[flag]) return;
  scope[flag] = true;

  const name = (kind: string) => `${channel}:${kind}`;
  const emit = (target: EventTarget, kind: string, detail: unknown) =>
    target.dispatchEvent(new CustomEvent(name(kind), { detail: JSON.stringify(detail) }));
  const read = (event: Event): unknown => {
    try {
      return JSON.parse(String((event as CustomEvent).detail));
    } catch {
      return undefined;
    }
  };
  const ask = (target: Element | Document, kind: string): unknown => {
    let reply: unknown;
    const listener = (event: Event) => {
      reply = read(event);
    };
    target.addEventListener(name(`${kind}:reply`), listener);
    emit(target, kind, {});
    target.removeEventListener(name(`${kind}:reply`), listener);
    return reply;
  };

  const validEntry = (key: string, v: unknown) =>
    key.length <= 64 &&
    /^[A-Za-z][A-Za-z0-9_-]*( [A-Za-z0-9_-]+)*$/.test(key) &&
    (typeof v === 'string'
      ? v.length <= 256
      : v === null || typeof v === 'boolean' || (typeof v === 'number' && Number.isFinite(v)));
  const metadataOf = (raw: string | null): Record<string, Json> | undefined => {
    if (!raw) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      return undefined;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0 || entries.length > 6 || !entries.every(([k, v]) => validEntry(k, v)))
      return undefined;
    const out = Object.fromEntries(entries) as Record<string, Json>;
    return new TextEncoder().encode(JSON.stringify(out)).length <= 2048 ? out : undefined;
  };

  const rectOf = (r: DOMRect | Rect): Rect => ({
    x: r.x,
    y: r.y,
    width: r.width,
    height: r.height,
  });
  const selectorOf = (element: Element): string => {
    const parts: string[] = [];
    let node: Element | null = element;
    while (node && node !== document.documentElement && parts.length < 6) {
      if (node.id && document.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) {
        parts.unshift(`${node.localName}#${CSS.escape(node.id)}`);
        break;
      }
      const parent: Element | null = node.parentElement;
      const tag = node.localName;
      const same = parent ? Array.from(parent.children).filter((c) => c.localName === tag) : [];
      parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(node) + 1})` : tag);
      node = parent;
    }
    return parts.join(' > ');
  };
  const textOf = (element: Element) =>
    `${element.textContent}`.replace(/\s+/g, ' ').trim().slice(0, 500);
  const containerOf = (element: Element) =>
    element.closest('[oai-annotation-container],[oai-annotation-container-text]');
  const inTextContainer = (element: Element) =>
    containerOf(element)?.hasAttribute('oai-annotation-container-text') ?? false;

  const host = document.createElement('mcpcat-annotations');
  host.style.cssText =
    'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;';
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    * { box-sizing: border-box; font: 13px/1.4 -apple-system, system-ui, sans-serif; }
    .hl, .sel { position: fixed; pointer-events: none; border: 2px solid #2563eb; border-radius: 4px; background: rgba(37, 99, 235, 0.08); display: none; }
    .sel { border-color: #7c3aed; background: rgba(124, 58, 237, 0.08); }
    .tag { position: absolute; top: -22px; left: -2px; background: #2563eb; color: #fff; padding: 1px 6px; border-radius: 4px; white-space: nowrap; font-size: 11px; }
    .bar { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); display: flex; gap: 6px; align-items: center; background: #111827; color: #f9fafb; padding: 6px 8px; border-radius: 999px; box-shadow: 0 4px 16px rgba(0,0,0,.3); pointer-events: auto; white-space: nowrap; }
    .bar.idle { left: auto; right: 16px; transform: none; }
    button { cursor: pointer; border: 1px solid #374151; background: #1f2937; color: #f9fafb; border-radius: 999px; padding: 4px 10px; }
    button.primary { background: #7c3aed; border-color: #7c3aed; }
    button:disabled { opacity: .45; cursor: default; }
    .pop { position: fixed; width: 320px; max-height: 70vh; overflow: auto; background: #111827; color: #f9fafb; border-radius: 12px; padding: 12px; box-shadow: 0 8px 32px rgba(0,0,0,.4); pointer-events: auto; display: none; }
    .pop h3 { margin: 0 0 6px; font-weight: 600; font-size: 14px; }
    .kind { color: #9ca3af; font-size: 11px; margin-bottom: 8px; }
    .meta { display: grid; grid-template-columns: auto 1fr; gap: 2px 10px; margin-bottom: 8px; color: #d1d5db; }
    .meta .k { color: #9ca3af; }
    .quote { border-left: 3px solid #7c3aed; padding-left: 8px; color: #d1d5db; margin-bottom: 8px; max-height: 6em; overflow: hidden; }
    .controls { border-top: 1px solid #374151; padding-top: 8px; margin-bottom: 8px; }
    .controls .head { color: #9ca3af; font-size: 11px; margin-bottom: 6px; }
    .row { display: grid; grid-template-columns: 1fr 150px; gap: 8px; align-items: center; margin: 4px 0; }
    .row input[type=range] { width: 100%; }
    .row input, .row select { background: #1f2937; color: #f9fafb; border: 1px solid #374151; border-radius: 6px; padding: 2px 4px; }
    .ref { color: #6b7280; font-size: 11px; }
    textarea { width: 100%; min-height: 56px; resize: vertical; background: #1f2937; color: #f9fafb; border: 1px solid #374151; border-radius: 8px; padding: 6px; }
    .actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: 8px; }
  `;
  const highlight = document.createElement('div');
  highlight.className = 'hl';
  const tag = document.createElement('div');
  tag.className = 'tag';
  highlight.append(tag);
  const selected = document.createElement('div');
  selected.className = 'sel';
  const bar = document.createElement('div');
  bar.className = 'bar idle';
  const pop = document.createElement('div');
  pop.className = 'pop';
  root.append(style, highlight, selected, pop, bar);
  const PRIVATE_EVENTS = [
    'keydown',
    'keyup',
    'keypress',
    'beforeinput',
    'input',
    'change',
    'textInput',
    'compositionstart',
    'compositionupdate',
    'compositionend',
    'paste',
    'copy',
    'cut',
    'select',
    'selectionchange',
  ];
  const handlers = new WeakMap<EventTarget, Map<string, (event: Event) => void>>();
  const ui = (element: EventTarget, type: string, handler: (event: Event) => void) => {
    const map = handlers.get(element) ?? new Map<string, (event: Event) => void>();
    map.set(type, handler);
    handlers.set(element, map);
  };
  const shield = (event: Event) => {
    if (!event.composedPath().includes(host)) return;
    event.stopImmediatePropagation();
    const focused = root.activeElement;
    if (focused) handlers.get(focused)?.get(event.type)?.(event);
    if (event.type === 'keydown') onKey(event as KeyboardEvent);
  };
  for (const type of PRIVATE_EVENTS) addEventListener(type, shield, true);
  const mount = () => {
    const parent = document.body ?? document.documentElement;
    if (parent && !host.isConnected) parent.append(host);
  };
  mount();
  document.addEventListener('readystatechange', mount);
  setInterval(mount, 1000);

  let active = false;
  let stay = false;
  let space = false;
  let live: Live | undefined;
  let hitSeq = 0;
  const saved: { annotation: Record<string, unknown>; live: Live; shown: boolean }[] = [];

  const place = (box: HTMLElement, rect: Rect | undefined) => {
    if (!rect) {
      box.style.display = 'none';
      return;
    }
    box.style.display = 'block';
    box.style.left = `${rect.x - 2}px`;
    box.style.top = `${rect.y - 2}px`;
    box.style.width = `${rect.width + 4}px`;
    box.style.height = `${rect.height + 4}px`;
  };

  const button = (label: string, onClick: () => void, primary = false) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    if (primary) b.className = 'primary';
    b.addEventListener('click', onClick);
    return b;
  };

  const virtualTarget = (pick: Pick) =>
    pick.kind === 'virtual' ? { surfaceId: pick.surfaceId, targetId: pick.targetId } : undefined;

  const change = (l: Live, control: Control, value: Json, action: string) =>
    emit(l.pick.element, 'control', {
      callback: control.callback,
      value,
      action,
      virtualTarget: virtualTarget(l.pick),
    });

  const original = (control: Control): Json => {
    if (control.currentValue !== undefined) return control.currentValue;
    if (control.type === 'range') return control.min ?? 0;
    if (control.type === 'color') return '#ffffff';
    if (control.type === 'toggle') return false;
    return control.options?.[0]?.value ?? '';
  };
  const start = (control: Control): Json => control.defaultValue ?? original(control);
  const changed = (l: Live) =>
    l.controls.filter(
      (c) => c.currentValue === undefined || l.values.get(c.callback) !== c.currentValue
    );
  const elementIds = new WeakMap<Element, number>();
  let elementSeq = 0;
  const keyOf = (l: Live, control: Control) => {
    let id = elementIds.get(l.pick.element);
    if (id === undefined) {
      id = ++elementSeq;
      elementIds.set(l.pick.element, id);
    }
    return JSON.stringify([id, control.callback, l.pick.surfaceId, l.pick.targetId]);
  };
  const applied = new Map<string, { l: Live; control: Control; value: Json; base: Json }>();
  const sync = () => {
    const wanted = new Map<string, { l: Live; control: Control; value: Json }>();
    const layers = saved.filter((s) => s.shown).map((s) => s.live);
    if (live) layers.push(live);
    for (const l of layers)
      for (const control of l.controls)
        if (l.previewed.has(control.callback))
          wanted.set(keyOf(l, control), {
            l,
            control,
            value: l.values.get(control.callback) as Json,
          });
    for (const [key, entry] of applied) {
      if (wanted.has(key)) continue;
      applied.delete(key);
      change(entry.l, entry.control, entry.base, 'reset');
    }
    for (const [key, want] of wanted) {
      const entry = applied.get(key);
      if (entry?.value === want.value) continue;
      applied.set(key, { ...want, base: entry ? entry.base : original(want.control) });
      change(want.l, want.control, want.value, 'preview');
    }
  };

  const renderBar = () => {
    bar.replaceChildren();
    bar.className = active ? 'bar' : 'bar idle';
    if (!active) {
      bar.append(button('✎ Annotate', () => setActive(true)));
      if (saved.length) bar.append(button(`Send ${saved.length} to agent`, submit, true));
      return;
    }
    const label = document.createElement('span');
    label.textContent = ` Annotating · ${saved.length} `;
    const compare = button('Hold to compare', () => {});
    compare.disabled = applied.size === 0;
    compare.addEventListener('pointerdown', () => {
      for (const e of applied.values()) change(e.l, e.control, e.base, 'preview-original');
    });
    compare.addEventListener('pointerup', () => {
      for (const e of applied.values()) change(e.l, e.control, e.value, 'preview');
    });
    const sendAll = button(
      saved.length ? `Send ${saved.length} to agent` : 'Send to agent',
      submit,
      true
    );
    sendAll.disabled = saved.length === 0;
    const discard = button('Discard', () => clearSaved('discard'));
    discard.disabled = saved.length === 0;
    bar.append(
      label,
      compare,
      sendAll,
      discard,
      button('Exit', () => setActive(false))
    );
  };

  const setActive = (next: boolean) => {
    if (next === active) return;
    active = next;
    if (active) {
      for (const s of saved) s.shown = true;
    } else {
      stay = false;
      closeEditor(true);
      place(highlight, undefined);
      for (const s of saved) s.shown = false;
    }
    sync();
    renderBar();
    emit(document, 'mode', { active });
    send({ type: 'mode', active });
  };

  const clearSaved = (reason: 'discard' | 'submit') => {
    const ids = saved.map((s) => s.annotation.id);
    saved.length = 0;
    sync();
    send({ type: reason, ids });
    renderBar();
  };

  const submit = () => {
    if (!saved.length) return;
    clearSaved('submit');
    if (!stay) setActive(false);
  };

  const closeEditor = (cancel: boolean) => {
    if (!live) return;
    if (live.pick.kind === 'virtual')
      emit(live.pick.element, 'render', {
        surfaceId: live.pick.surfaceId,
        hoveredId: null,
        selectedId: null,
      });
    live = undefined;
    if (cancel) sync();
    pop.style.display = 'none';
    (root.activeElement as HTMLElement | null)?.blur();
    place(selected, undefined);
  };

  const controlRow = (l: Live, control: Control) => {
    const row = document.createElement('div');
    row.className = 'row';
    const label = document.createElement('div');
    label.textContent = control.label;
    if (control.reference) {
      const ref = document.createElement('div');
      ref.className = 'ref';
      ref.textContent = control.reference;
      label.append(ref);
    }
    const value = l.values.get(control.callback);
    const update = (next: Json) => {
      l.values.set(control.callback, next);
      l.previewed.add(control.callback);
      sync();
      refreshSave();
    };
    let input: HTMLElement;
    if (control.type === 'range') {
      const wrap = document.createElement('div');
      const range = document.createElement('input');
      range.type = 'range';
      range.min = String(control.min);
      range.max = String(control.max);
      range.step = String(control.step);
      range.value = String(value);
      const out = document.createElement('span');
      out.textContent = ` ${value}`;
      ui(range, 'input', () => {
        out.textContent = ` ${range.value}`;
        update(Number(range.value));
      });
      wrap.append(range, out);
      input = wrap;
    } else if (control.type === 'color') {
      const color = document.createElement('input');
      color.type = 'color';
      color.value =
        String(value).length === 4
          ? `#${String(value).slice(1).replace(/./g, '$&$&')}`
          : String(value).slice(0, 7);
      ui(color, 'input', () => update(color.value));
      input = color;
    } else if (control.type === 'toggle') {
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = value === true;
      ui(box, 'change', () => update(box.checked));
      input = box;
    } else {
      const select = document.createElement('select');
      for (const option of control.options ?? []) {
        const o = document.createElement('option');
        o.value = option.value;
        o.textContent = option.label;
        select.append(o);
      }
      select.value = String(value);
      ui(select, 'change', () => update(select.value));
      input = select;
    }
    row.append(label, input);
    return row;
  };

  let refreshSave = () => {};

  const headerNodes = (pick: Pick): HTMLElement[] => {
    const title = document.createElement('h3');
    title.textContent =
      pick.name || (pick.kind === 'text' ? 'Selected text' : pick.element.localName);
    const kind = document.createElement('div');
    kind.className = 'kind';
    const role = pick.role ? ` · ${pick.role}` : '';
    const kinds: Record<string, string> = {
      virtual: `canvas object ${pick.targetId}${role}`,
      page: 'webpage',
    };
    kind.textContent = kinds[pick.kind] ?? pick.kind;
    const nodes = [title, kind];
    if (pick.text) {
      const quote = document.createElement('div');
      quote.className = 'quote';
      quote.textContent = pick.text;
      nodes.push(quote);
    }
    if (pick.metadata) {
      const meta = document.createElement('div');
      meta.className = 'meta';
      for (const [k, v] of Object.entries(pick.metadata)) {
        const key = document.createElement('span');
        key.className = 'k';
        key.textContent = k;
        const val = document.createElement('span');
        val.textContent = String(v);
        meta.append(key, val);
      }
      nodes.push(meta);
    }
    return nodes;
  };

  const controlsNode = (l: Live) => {
    const box = document.createElement('div');
    box.className = 'controls';
    const head = document.createElement('div');
    head.className = 'head';
    head.textContent = `${l.heading ?? l.pick.element.localName} · controls provided by ${location.host}`;
    box.append(head, ...l.controls.map((c) => controlRow(l, c)));
    return box;
  };

  const openEditor = (pick: Pick, comment?: string) => {
    closeEditor(true);
    if (pick.kind === 'virtual')
      emit(pick.element, 'render', {
        surfaceId: pick.surfaceId,
        hoveredId: null,
        selectedId: pick.targetId,
      });
    const info =
      pick.kind === 'text' || pick.kind === 'page'
        ? null
        : (ask(pick.element, 'controls') as
            | { heading?: string; controls?: Control[] }
            | null
            | undefined);
    const controls = Array.isArray(info?.controls) ? info.controls : [];
    const l: Live = {
      pick,
      controls,
      heading: info?.heading,
      values: new Map(),
      previewed: new Set(),
    };
    for (const control of controls) {
      l.values.set(control.callback, start(control));
      if (start(control) !== original(control)) l.previewed.add(control.callback);
    }
    live = l;
    sync();

    pop.replaceChildren(...headerNodes(pick));
    if (controls.length) pop.append(controlsNode(l));
    const area = document.createElement('textarea');
    area.placeholder = 'Add a comment…';
    area.maxLength = 4000;
    area.value = comment ?? '';
    const save = button('Save', () => saveLive(area.value), true);
    refreshSave = () => {
      save.disabled = !area.value.trim() && changed(l).length === 0;
    };
    ui(area, 'input', refreshSave);
    ui(area, 'keydown', (event) => {
      const k = event as KeyboardEvent;
      if (k.key === 'Enter' && (k.metaKey || k.ctrlKey) && !save.disabled) saveLive(area.value);
    });
    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.append(
      button('Cancel', () => closeEditor(true)),
      save
    );
    if (!guarded) {
      const warn = document.createElement('div');
      warn.className = 'kind';
      warn.textContent =
        'This page started before the annotation editor, so it may see what you type here.';
      pop.append(warn);
    }
    pop.append(area, actions);
    refreshSave();

    place(selected, pick.rect);
    pop.style.display = 'block';
    const width = 320;
    const below = pick.rect.y + pick.rect.height + 8;
    const left = Math.min(Math.max(8, pick.rect.x), innerWidth - width - 8);
    pop.style.left = `${left}px`;
    const height = pop.offsetHeight;
    pop.style.top = `${below + height < innerHeight ? below : Math.max(8, pick.rect.y - height - 8)}px`;
    area.focus();
  };

  const saveLive = (comment: string) => {
    const l = live;
    if (!l) return;
    const { pick } = l;
    const labelOf = (control: Control, value: Json) =>
      control.type === 'select' ? control.options!.find((o) => o.value === value)!.label : value;
    const target: Record<string, unknown> =
      pick.kind === 'virtual'
        ? {
            surfaceId: pick.surfaceId,
            targetId: pick.targetId,
            name: pick.name,
            role: pick.role,
            host: selectorOf(pick.element),
          }
        : pick.kind === 'page'
          ? { name: document.title, selector: 'html' }
          : {
              name: pick.name,
              tag: pick.element.localName,
              selector: selectorOf(pick.element),
              text: pick.kind === 'text' ? undefined : textOf(pick.element),
            };
    target.rect = pick.rect;
    const annotation: Record<string, unknown> = {
      id: Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) =>
        b.toString(16).padStart(2, '0')
      ).join(''),
      kind: pick.kind,
      url: location.href,
      title: document.title,
      target,
      text: pick.text,
      metadata: pick.metadata,
      comment: comment.trim() || undefined,
      controlsHeading: l.controls.length ? l.heading : undefined,
      controls: changed(l).map((control) => ({
        label: control.label,
        reference: control.reference,
        type: control.type,
        previous:
          control.currentValue === undefined ? undefined : labelOf(control, control.currentValue),
        value: labelOf(control, l.values.get(control.callback) as Json),
      })),
      createdAt: new Date().toISOString(),
    };
    saved.push({ annotation, live: l, shown: true });
    send({ type: 'annotation', annotation });
    live = undefined;
    pop.style.display = 'none';
    (root.activeElement as HTMLElement | null)?.blur();
    place(selected, undefined);
    if (pick.kind === 'virtual')
      emit(pick.element, 'render', {
        surfaceId: pick.surfaceId,
        hoveredId: null,
        selectedId: null,
      });
    renderBar();
  };

  const hit = (element: Element, x: number, y: number): Promise<Pick | null | undefined> => {
    const surfaceId = ask(element, 'surface');
    if (typeof surfaceId !== 'string') return Promise.resolve(undefined);
    const seq = ++hitSeq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish(undefined), 250);
      const listener = (event: Event) => {
        const data = read(event) as
          | { seq?: number; result?: Record<string, unknown> | null }
          | undefined;
        if (data?.seq !== seq) return;
        const result = data.result;
        if (result === null) return finish(null);
        if (!result || result.fallback || typeof result.id !== 'string') return finish(undefined);
        const hostRect = element.getBoundingClientRect();
        finish({
          kind: 'virtual',
          element,
          surfaceId,
          targetId: result.id,
          name: typeof result.name === 'string' ? result.name : undefined,
          role: typeof result.role === 'string' ? result.role : undefined,
          metadata: (result.metadata as Record<string, Json>) ?? undefined,
          rect: (result.rect as Rect) ?? rectOf(hostRect),
        });
      };
      const finish = (value: Pick | null | undefined) => {
        clearTimeout(timer);
        element.removeEventListener(name('hit:reply'), listener);
        resolve(value);
      };
      element.addEventListener(name('hit:reply'), listener);
      emit(element, 'hit', { seq, surfaceId, clientX: x, clientY: y });
    });
  };

  const pickAt = async (element: Element, x: number, y: number): Promise<Pick | null> => {
    const virtual = await hit(element, x, y);
    if (virtual === null) return null;
    if (virtual) return virtual;
    const container = containerOf(element);
    if (container && !container.hasAttribute('oai-annotation-container-text')) {
      const marked = element.closest('[oai-annotatable]');
      if (!marked || !container.contains(marked)) {
        return {
          kind: 'page',
          element: document.documentElement,
          name: document.title,
          rect: rectOf(container.getBoundingClientRect()),
        };
      }
      return {
        kind: 'element',
        element: marked,
        name: marked.getAttribute('oai-annotatable') || undefined,
        rect: rectOf(marked.getBoundingClientRect()),
        metadata: metadataOf(marked.getAttribute('oai-annotation-metadata')),
      };
    }
    return {
      kind: 'element',
      element,
      name:
        element.getAttribute('oai-annotatable') || element.getAttribute('aria-label') || undefined,
      rect: rectOf(element.getBoundingClientRect()),
      metadata: metadataOf(element.getAttribute('oai-annotation-metadata')),
    };
  };

  const fromUi = (event: Event) => event.composedPath().includes(host);
  const capturing = () => active && !space;
  let hoverSeq = 0;

  const onPointer = (event: PointerEvent | MouseEvent) => {
    if (!capturing() || fromUi(event)) return;
    const element = event.target instanceof Element ? event.target : null;
    if (!element) return;
    const text = inTextContainer(element);
    event.stopImmediatePropagation();
    if (
      !text ||
      event.type === 'click' ||
      event.type === 'dblclick' ||
      event.type === 'contextmenu'
    )
      event.preventDefault();
    if (event.type === 'mouseup' && text) {
      setTimeout(() => {
        const selection = getSelection();
        if (!selection || selection.isCollapsed || selection.rangeCount === 0) return;
        const range = selection.getRangeAt(0);
        const value = range.toString();
        if (!value.trim()) return;
        const node = range.commonAncestorContainer;
        const owner = node instanceof Element ? node : node.parentElement;
        if (!owner) return;
        openEditor({
          kind: 'text',
          element: owner,
          text: value.slice(0, 20_000),
          rect: rectOf(range.getBoundingClientRect()),
        });
        selection.removeAllRanges();
      }, 0);
    }
    if (event.type === 'click' && !text) {
      void pickAt(element, event.clientX, event.clientY).then((pick) => {
        if (pick) openEditor(pick);
      });
    }
  };
  for (const type of [
    'pointerdown',
    'pointerup',
    'mousedown',
    'mouseup',
    'click',
    'dblclick',
    'contextmenu',
    'auxclick',
  ])
    addEventListener(type, onPointer as EventListener, true);

  let lastSurface: { element: Element; surfaceId?: string } | undefined;
  addEventListener(
    'pointermove',
    (event) => {
      if (!capturing() || live || fromUi(event)) {
        if (!live) place(highlight, undefined);
        return;
      }
      const element = event.target instanceof Element ? event.target : null;
      if (!element || inTextContainer(element)) {
        place(highlight, undefined);
        return;
      }
      const seq = ++hoverSeq;
      void pickAt(element, event.clientX, event.clientY).then((pick) => {
        if (seq !== hoverSeq) return;
        if (lastSurface && pick?.kind !== 'virtual')
          emit(lastSurface.element, 'render', {
            surfaceId: lastSurface.surfaceId,
            hoveredId: null,
            selectedId: null,
          });
        lastSurface =
          pick?.kind === 'virtual'
            ? { element: pick.element, surfaceId: pick.surfaceId }
            : undefined;
        if (pick?.kind === 'virtual')
          emit(pick.element, 'render', {
            surfaceId: pick.surfaceId,
            hoveredId: pick.targetId,
            selectedId: null,
          });
        place(highlight, pick?.rect);
        tag.textContent = pick
          ? pick.name || (pick.kind === 'page' ? 'webpage' : pick.element.localName)
          : '';
      });
    },
    true
  );

  const onKey = (event: KeyboardEvent) => {
    if (!active) return;
    if (event.key === 'Escape') {
      event.stopImmediatePropagation();
      if (live) closeEditor(true);
      else if (!stay) setActive(false);
    } else if (event.key === ' ' && !fromUi(event) && !space) {
      space = true;
      place(highlight, undefined);
    }
  };
  addEventListener('keydown', onKey, true);
  addEventListener(
    'keyup',
    (event) => {
      if (event.key === ' ') space = false;
    },
    true
  );
  addEventListener('scroll', () => place(highlight, undefined), true);

  const listen = (
    kind: string,
    handler: (target: Element | Document, data: Record<string, unknown>) => void
  ) =>
    document.addEventListener(
      name(kind),
      (event) => {
        const data = read(event);
        const target = event.target;
        if (
          data &&
          typeof data === 'object' &&
          (target instanceof Element || target instanceof Document)
        )
          handler(target, data as Record<string, unknown>);
      },
      true
    );
  listen('ping', () => emit(document, 'hello', {}));
  listen('toggle', (_target, data) => setActive(data.active === true));
  listen('request', (target, data) => {
    if (!(target instanceof Element) || live) return;
    if (data.enter === true) {
      stay = true;
      setActive(true);
    }
    const comment = typeof data.comment === 'string' ? data.comment : undefined;
    if (data.kind === 'text') {
      const rect = data.rect as Rect;
      openEditor(
        { kind: 'text', element: target, text: String(data.text ?? '').slice(0, 20_000), rect },
        comment
      );
      return;
    }
    const metadata =
      data.metadata && typeof data.metadata === 'object'
        ? (data.metadata as Record<string, Json>)
        : metadataOf(target.getAttribute('oai-annotation-metadata'));
    openEditor(
      {
        kind: 'element',
        element: target,
        name: target.getAttribute('oai-annotatable') || undefined,
        rect: rectOf(target.getBoundingClientRect()),
        metadata,
      },
      comment
    );
  });

  renderBar();
  emit(document, 'hello', {});
  send({ type: 'ready', url: location.href });
}
