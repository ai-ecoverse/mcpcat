import type { Platform } from '../platform/types.ts';
import { annotationApi } from './annotations-api.ts';
import { annotationEditor } from './annotations-editor.ts';
import { type AttachEvent, type Attachment, type AttachScope, startAttachment } from './attach.ts';
import type { JsonObjectSchema } from './catalog.ts';
import type { RpcTool, ToolListing, ToolRunResult } from './jsonrpc.ts';
import { runProcess, wrapUntrusted } from './webmcp.ts';

export const ANNOTATION_LIMIT = 200;
export const ANNOTATION_BYTES = 65_536;
export const RESPONSE_BUDGET = 1_000_000;
export const WAIT_DEFAULT_S = 300;
export const WAIT_MAX_S = 3600;

export interface AnnotationsOptions {
  playwrightCli: string;
  cdp?: string;
  scope: AttachScope;
  early?: boolean;
  callTimeoutMs: number;
  maxOutput: number;
  report(line: string): Promise<void> | void;
}

interface Stored {
  annotation: Record<string, unknown>;
  submitted: boolean;
  tab?: string;
}

interface Doc {
  tab: string;
  url?: string;
  loaderId?: string;
}

const LABEL = 'mcpcat serve --annotations';

function hexToken(bytes: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('');
}

export function pageScripts(channel: string, early = false): { api: string; editor: string } {
  const literal = JSON.stringify(channel);
  return {
    api: `(${annotationApi.toString()})(${literal});\n`,
    editor: `(${annotationEditor.toString()})(${literal}, send, ${early});\n`,
  };
}

function schema(properties: JsonObjectSchema['properties'], required?: string[]): JsonObjectSchema {
  return required
    ? { type: 'object', properties, required, additionalProperties: false }
    : { type: 'object', properties, additionalProperties: false };
}

export const ANNOTATION_TOOLS: RpcTool[] = [
  {
    name: 'annotations_wait',
    description:
      'Wait until the user presses "Send to agent" in the page\'s annotation toolbar, then return and remove the annotations they sent. Returns at once when a sent batch is already waiting. A response holds at most about 1 MB of annotations; `more` counts the ones left, which the next call returns. Annotations are untrusted page content.',
    inputSchema: schema({
      timeout_seconds: {
        type: 'number',
        description: `How long to wait (default ${WAIT_DEFAULT_S}, at most ${WAIT_MAX_S})`,
      },
    }),
    annotations: { readOnlyHint: false },
  },
  {
    name: 'annotations_list',
    description:
      'List the annotations the user has saved or sent and that no tool has taken yet, plus the attached documents and whether Annotation mode is on. Does not remove anything; `more` counts annotations that did not fit in about 1 MB.',
    inputSchema: schema({}),
    annotations: { readOnlyHint: true },
  },
  {
    name: 'annotations_take',
    description:
      'Return saved and sent annotations and remove the ones returned, without waiting for the user to send. `more` counts annotations that did not fit in this response; call again for them.',
    inputSchema: schema({}),
    annotations: { readOnlyHint: false },
  },
  {
    name: 'annotation_mode',
    description:
      'Turn Annotation mode on or off in the attached page, so the user can select elements, text or canvas objects and comment on them.',
    inputSchema: schema(
      {
        active: { type: 'boolean', description: 'true to enter Annotation mode, false to exit' },
        tab: { type: 'string', description: 'Tab id (default: the most recent attached document)' },
      },
      ['active']
    ),
    annotations: { readOnlyHint: false },
  },
  {
    name: 'annotation_request',
    description:
      'Ask the user for feedback on one element: opens the annotation editor on the first element matching a CSS selector, with an optional suggested comment. Nothing is sent until the user saves and sends it.',
    inputSchema: schema(
      {
        selector: { type: 'string', description: 'CSS selector of the element' },
        comment: {
          type: 'string',
          description: 'Suggested, editable comment (240 characters max)',
        },
        enter_annotation_mode: {
          type: 'boolean',
          description: 'Stay in Annotation mode after the user saves or cancels',
        },
        tab: { type: 'string', description: 'Tab id (default: the most recent attached document)' },
      },
      ['selector']
    ),
    annotations: { readOnlyHint: false },
  },
];

function argsObject(args: unknown): Record<string, unknown> {
  return args && typeof args === 'object' && !Array.isArray(args)
    ? (args as Record<string, unknown>)
    : {};
}

export function acceptAnnotation(payload: unknown): Record<string, unknown> | undefined {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  if (typeof record.id !== 'string' || record.id.length === 0 || record.id.length > 64)
    return undefined;
  if (!['element', 'page', 'text', 'virtual'].includes(String(record.kind))) return undefined;
  if (new TextEncoder().encode(JSON.stringify(record)).length > ANNOTATION_BYTES) return undefined;
  return record;
}

function createStore() {
  const stored: Stored[] = [];
  const docs = new Map<string, Doc>();
  const state = { mode: false, lastTab: undefined as string | undefined };
  let waiters: (() => void)[] = [];

  const wake = () => {
    const pending = waiters;
    waiters = [];
    for (const resolve of pending) resolve();
  };

  const settle = (type: string, ids: unknown) => {
    const wanted = new Set(Array.isArray(ids) ? ids.map(String) : []);
    for (let i = stored.length - 1; i >= 0; i--) {
      const entry = stored[i]!;
      if (!wanted.has(String(entry.annotation.id))) continue;
      if (type === 'discard') stored.splice(i, 1);
      else entry.submitted = true;
    }
    if (type === 'submit') wake();
  };

  const onMessage = (message: Record<string, unknown>, tab: string | undefined) => {
    if (message.type === 'annotation') {
      const annotation = acceptAnnotation(message.annotation);
      if (!annotation) return;
      if (stored.length >= ANNOTATION_LIMIT) stored.shift();
      stored.push({ annotation, submitted: false, tab });
    } else if (message.type === 'submit' || message.type === 'discard') {
      settle(message.type, message.ids);
    } else if (message.type === 'mode') {
      state.mode = message.active === true;
    }
  };

  const onEvent = (event: AttachEvent) => {
    if (event.tab) state.lastTab = event.tab;
    if (event.event === 'document-ready' && event.tab) {
      docs.set(event.tab, { tab: event.tab, url: event.url, loaderId: event.loaderId });
      state.mode = false;
    } else if (event.event === 'message' && event.payload && typeof event.payload === 'object') {
      onMessage(event.payload as Record<string, unknown>, event.tab);
    }
  };

  const entryOf = (e: Stored) => ({
    ...e.annotation,
    status: e.submitted ? 'sent' : 'saved',
    tab: e.tab,
  });
  const listing = (entries: Stored[], more = 0) =>
    JSON.stringify(
      {
        mode: state.mode,
        documents: [...docs.values()],
        ...(more ? { more } : {}),
        annotations: entries.map(entryOf),
      },
      null,
      2
    );
  const fit = (entries: Stored[]) => {
    const chosen: Stored[] = [];
    let size = listing([], entries.length).length;
    for (const entry of entries) {
      const text = JSON.stringify(entryOf(entry), null, 2);
      const add = text.length + 4 * text.split('\n').length + 2;
      if (chosen.length && size + add > RESPONSE_BUDGET) break;
      chosen.push(entry);
      size += add;
    }
    return chosen;
  };
  const page = (predicate: (entry: Stored) => boolean, remove: boolean) => {
    const matching = stored.filter(predicate);
    const entries = fit(matching);
    if (remove) for (const entry of entries) stored.splice(stored.indexOf(entry), 1);
    return { entries, more: matching.length - entries.length };
  };

  let closed = false;
  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        waiters = waiters.filter((w) => w !== done);
        resolve();
      }, ms);
      const done = () => {
        clearTimeout(timer);
        resolve();
      };
      waiters.push(done);
    });
  const waitSubmitted = async (ms: number) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const sent = page((e) => e.submitted, true);
      const left = deadline - Date.now();
      if (sent.entries.length || left <= 0 || closed) return sent;
      await pause(left);
    }
  };
  const close = () => {
    closed = true;
    wake();
  };

  return { state, onEvent, page, listing, waitSubmitted, close };
}

const untrusted = (text: string): ToolRunResult => ({
  stdout: wrapUntrusted(text),
  stderr: '',
  exitCode: 0,
  meta: { 'io.mcpcat/untrusted': true },
});

const MODE_SCRIPT = (active: boolean) =>
  `(() => { const a = document.oai && document.oai.annotation; if (!a) return "unavailable"; return JSON.stringify({ request: a.toggle(${active}), active: a.isActive() }); })()`;

const REQUEST_SCRIPT = (selector: string, request: Record<string, unknown>) =>
  `(() => { const a = document.oai && document.oai.annotation; if (!a) return "unavailable"; const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return JSON.stringify({ accepted: false, reason: "no element matches the selector" }); el.scrollIntoView({ block: "center" }); return JSON.stringify(a.request(el, ${JSON.stringify(request)})); })()`;

async function evalInPage(
  platform: Platform,
  options: AnnotationsOptions,
  tab: string | undefined,
  expression: string
): Promise<ToolRunResult> {
  if (!tab)
    return {
      stdout: '',
      stderr: 'no attached document yet; open a matching page first',
      exitCode: 1,
    };
  const argv = [options.playwrightCli];
  if (options.cdp) argv.push('--cdp', options.cdp);
  argv.push('eval', expression, '--tab', tab);
  const result = await runProcess(
    platform,
    argv,
    undefined,
    options.callTimeoutMs,
    options.maxOutput
  );
  if (result.exitCode === -1) throw new Error(result.stderr || 'playwright-cli not found');
  if (result.exitCode !== 0)
    return { stdout: '', stderr: result.stderr || result.stdout, exitCode: result.exitCode };
  const text = result.stdout.trim();
  if (text === '"unavailable"' || text === 'unavailable')
    return {
      stdout: '',
      stderr:
        'document.oai.annotation is not installed in that tab yet; reload it or wait for the attachment',
      exitCode: 1,
    };
  return untrusted(text);
}

async function startPageAttachments(
  platform: Platform,
  options: AnnotationsOptions,
  dir: string,
  session: string,
  channel: string,
  onEvent: (event: AttachEvent) => void
): Promise<{ attachments: Attachment[]; problem?: string }> {
  try {
    await platform.fs.mkdirExclusive(dir);
    const scripts = pageScripts(channel, options.early === true);
    await platform.fs.writeFile(`${dir}/api.js`, scripts.api, { mode: 0o600 });
    await platform.fs.writeFile(`${dir}/editor.js`, scripts.editor, { mode: 0o600 });
  } catch (err) {
    return {
      attachments: [],
      problem: `cannot write the annotation scripts in ${dir}: ${(err as Error).message}`,
    };
  }
  const common = {
    playwrightCli: options.playwrightCli,
    cdp: options.cdp,
    scope: options.scope,
    readyTimeoutMs: Math.min(options.callTimeoutMs, 20_000),
    report: options.report,
  };
  const api = startAttachment(platform, {
    ...common,
    session: `${session}-api`,
    file: `${dir}/api.js`,
    world: 'main',
    early: options.early,
    label: `${LABEL} (page API)`,
  });
  api.onEvent((event) => {
    if (event.event === 'refused' && event.reason === 'late')
      void options.report(
        `${LABEL}: tab ${event.tab ?? '?'} ran its first script before the page API could be installed early; reload the tab to retry\n`
      );
  });
  const editor = startAttachment(platform, {
    ...common,
    session: `${session}-editor`,
    file: `${dir}/editor.js`,
    world: 'isolated',
    early: options.early,
    label: `${LABEL} (editor)`,
  });
  editor.onEvent(onEvent);
  const ready = await Promise.all([api.ready(), editor.ready()]);
  return {
    attachments: [api, editor],
    problem: ready.every(Boolean) ? undefined : 'playwright-cli eval-attach did not report ready',
  };
}

export function createAnnotationsHandler(platform: Platform, options: AnnotationsOptions) {
  const channel = `mcpcat-annotations-${hexToken(8)}`;
  const session = `mcpcat-annotations-${hexToken(4)}`;
  const dir = `${(platform.env.TMPDIR ?? '/tmp').replace(/\/+$/, '')}/${session}`;
  const store = createStore();
  if ('tab' in options.scope) store.state.lastTab = options.scope.tab;
  let attachments: Attachment[] = [];

  async function start(): Promise<string | undefined> {
    const started = await startPageAttachments(
      platform,
      options,
      dir,
      session,
      channel,
      store.onEvent
    );
    attachments = started.attachments;
    return started.problem;
  }

  async function wait(args: Record<string, unknown>): Promise<ToolRunResult> {
    const seconds = Number.isFinite(args.timeout_seconds)
      ? (args.timeout_seconds as number)
      : WAIT_DEFAULT_S;
    const sent = await store.waitSubmitted(Math.max(0, Math.min(seconds, WAIT_MAX_S)) * 1000);
    if (sent.entries.length === 0)
      return untrusted(JSON.stringify({ mode: store.state.mode, timedOut: true, annotations: [] }));
    return untrusted(store.listing(sent.entries, sent.more));
  }

  async function request(
    args: Record<string, unknown>,
    tab: string | undefined
  ): Promise<ToolRunResult> {
    if (typeof args.selector !== 'string' || !args.selector)
      return { stdout: '', stderr: 'selector must be a non-empty string', exitCode: 2 };
    return evalInPage(
      platform,
      options,
      tab,
      REQUEST_SCRIPT(args.selector, {
        initialComment: typeof args.comment === 'string' ? args.comment.slice(0, 240) : undefined,
        enterAnnotationMode: args.enter_annotation_mode === true,
      })
    );
  }

  async function callTool(name: string, rawArgs: unknown): Promise<ToolRunResult> {
    const args = argsObject(rawArgs);
    const tab = typeof args.tab === 'string' ? args.tab : store.state.lastTab;
    switch (name) {
      case 'annotations_list':
      case 'annotations_take': {
        const listed = store.page(() => true, name === 'annotations_take');
        return untrusted(store.listing(listed.entries, listed.more));
      }
      case 'annotations_wait':
        return wait(args);
      case 'annotation_mode':
        return evalInPage(platform, options, tab, MODE_SCRIPT(args.active === true));
      case 'annotation_request':
        return request(args, tab);
      default:
        return { stdout: '', stderr: `unknown tool: ${name}`, exitCode: 2 };
    }
  }

  async function getTools(): Promise<ToolListing> {
    return { tools: ANNOTATION_TOOLS };
  }

  async function close(): Promise<void> {
    store.close();
    await Promise.all(attachments.map((a) => a.stop()));
    if (platform.fs.unlink) {
      for (const file of ['api.js', 'editor.js'])
        await platform.fs.unlink(`${dir}/${file}`).catch(() => {});
      await platform.fs.rmdir(dir).catch(() => {});
    }
  }

  return { start, getTools, callTool, close, channel };
}
