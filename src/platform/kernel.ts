import { readExact, readUntil } from '../serve/http.ts';
import type {
  Connection,
  FsApi,
  Listener,
  ListenOptions,
  Platform,
  SpawnOptions,
  SpawnResult,
  WebSocketChannel,
} from './types.ts';

interface KernelFile {
  read(position: number, length: number): Promise<Uint8Array>;
  write(position: number, bytes: Uint8Array): Promise<void>;
  size(): Promise<number>;
  truncate(size?: number): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

interface KernelContext {
  argv: string[];
  env: Record<string, string | undefined>;
  cwd: string;
  stdin: ReadableStream<Uint8Array>;
  stdout: WritableStream<Uint8Array>;
  stderr: WritableStream<Uint8Array>;
  write(fd: number, data: Uint8Array | string): Promise<void>;
  read(fd: number, max?: number): Promise<Uint8Array>;
  open(
    path: string,
    options?: {
      read?: boolean;
      write?: boolean;
      append?: boolean;
      create?: boolean;
      exclusive?: boolean;
      truncate?: boolean;
    }
  ): Promise<KernelFile>;
  close(fd: number): Promise<void>;
  exit(status: number): never;
  fdStatus(fd: number): { type: string; tty: boolean; seekable: boolean };
  isatty(fd: number): boolean;
  fs: {
    stat(path: string): Promise<{ size: number; mtimeMs: number }>;
    lstat(path: string): Promise<{ size: number; mtimeMs: number }>;
    exists(path: string): Promise<boolean>;
    readdir(path: string): Promise<string[]>;
    mkdir(path: string): Promise<void>;
    rm(path: string): Promise<void>;
    unlink(path: string): Promise<void>;
    rename(from: string, to: string): Promise<void>;
    symlink(target: string, path: string): Promise<void>;
    readlink(path: string): Promise<string>;
    readFile(path: string): Promise<Uint8Array>;
    writeFile(path: string, data: Uint8Array | string): Promise<void>;
    chmod?(path: string, mode: number): Promise<void>;
  };
  fetch: typeof globalThis.fetch;
  websocket?(url: string): Promise<WebSocketChannel>;
  spawn(options: {
    argv: string[];
    env?: Record<string, string>;
    cwd?: string;
    stdin?: 'inherit' | 'pipe' | 'null';
    stdout?: 'inherit' | 'pipe' | 'null';
    stderr?: 'inherit' | 'pipe' | 'null';
    pgid?: number;
    parentDeathSignal?: string;
  }): Promise<{
    pid: number;
    stdin?: WritableStream<Uint8Array>;
    stdout?: ReadableStream<Uint8Array>;
    stderr?: ReadableStream<Uint8Array>;
    wait(): Promise<{ status: number; signal?: string }>;
    kill(signal?: string): void;
  }>;
  wait(pid: number): Promise<{ status: number; signal?: string }>;
  kill(pid: number, signal?: string): void | Promise<void>;
  net: {
    listen(options: { port: number; host?: string; backlog?: number }): Promise<{
      port: number;
      accept(options?: { signal?: AbortSignal }): Promise<{
        readable: ReadableStream<Uint8Array>;
        writable: WritableStream<Uint8Array>;
        local: { host: string; port: number };
        remote: { host: string; port: number };
        close(): void;
      }>;
      close(): void;
      [Symbol.asyncIterator](): AsyncIterableIterator<unknown>;
    }>;
    connect(options: { host: string; port: number; signal?: AbortSignal }): Promise<{
      readable: ReadableStream<Uint8Array>;
      writable: WritableStream<Uint8Array>;
      local: { host: string; port: number };
      remote: { host: string; port: number };
      close(): void;
    }>;
  };
  signals: {
    on(signal: string | number, handler: () => void): void | Promise<void>;
    ignore(signal: string | number): void;
    reset(signal: string | number): void;
  };
  resolve(path: string): string;
}

function kernelFs(ctx: KernelContext): FsApi {
  return {
    readFile: (path: string) => ctx.fs.readFile(path),
    writeFile: (path: string, data: Uint8Array | string) => ctx.fs.writeFile(path, data),
    mkdir: (path: string) => ctx.fs.mkdir(path),
    rename: (from: string, to: string) => ctx.fs.rename(from, to),
    stat: (path: string) => ctx.fs.stat(path),
    exists: (path: string) => ctx.fs.exists(path),
    async mkdirExclusive(path: string): Promise<void> {
      try {
        await ctx.fs.mkdir(path);
      } catch (err) {
        const msg = (err as Error).message ?? '';
        if (msg.includes('EEXIST') || msg.includes('already exists')) {
          const wrapped = new Error(`EEXIST: directory already exists, mkdir '${path}'`);
          (wrapped as NodeJS.ErrnoException).code = 'EEXIST';
          throw wrapped;
        }
        throw err;
      }
    },
    rmdir: (path: string) => ctx.fs.rm(path),
    unlink: (path: string) => ctx.fs.unlink(path),
    async createExclusive(path: string): Promise<void> {
      const f = await ctx.open(path, { create: true, exclusive: true, write: true });
      await f.close();
    },
    chmod: ctx.fs.chmod ? (path: string, mode: number) => ctx.fs.chmod!(path, mode) : undefined,
  };
}

let groupSpawnSupported: boolean | undefined;
let deathSignalSupported: boolean | undefined;

const PARENT_DEATH_SIGNAL = 'SIGKILL';

function isInvalid(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'EINVAL';
}

async function kernelSpawn(ctx: KernelContext, options: SpawnOptions): Promise<SpawnResult> {
  const tryGroup = groupSpawnSupported !== false;
  const base = {
    argv: options.argv,
    env: options.env as Record<string, string> | undefined,
    cwd: options.cwd,
    stdin: options.stdin === 'ignore' ? ('null' as const) : ('pipe' as const),
    stdout: 'pipe' as const,
    stderr: 'pipe' as const,
    ...(tryGroup ? { pgid: 0 } : {}),
  };
  const tryDeath = options.dieWithParent === true && deathSignalSupported !== false;
  let result: Awaited<ReturnType<KernelContext['spawn']>>;
  if (tryDeath) {
    try {
      result = await ctx.spawn({ ...base, parentDeathSignal: PARENT_DEATH_SIGNAL });
    } catch (err) {
      if (!isInvalid(err)) throw err;
      deathSignalSupported = false;
      result = await ctx.spawn(base);
    }
  } else {
    result = await ctx.spawn(base);
  }
  const childPid = result.pid;

  if (groupSpawnSupported === undefined) {
    try {
      await ctx.kill(-childPid, 'SIGCONT');
      groupSpawnSupported = true;
    } catch {
      groupSpawnSupported = false;
    }
  }

  const useGroupKill = groupSpawnSupported;
  let waited: ReturnType<typeof result.wait> | undefined;
  return {
    stdin: result.stdin ?? new WritableStream<Uint8Array>(),
    stdout: result.stdout!,
    stderr: result.stderr!,
    wait: () => (waited ??= result.wait()),
    kill: async (signal?: string) => {
      if (useGroupKill) {
        try {
          await ctx.kill(-childPid, signal);
        } catch {}
      }
      try {
        await ctx.kill(childPid, signal);
      } catch {}
    },
    async groupAlive() {
      if (!useGroupKill) return false;
      try {
        await ctx.kill(-childPid, 'SIGCONT');
        return true;
      } catch {
        return false;
      }
    },
  };
}

async function kernelListen(ctx: KernelContext, options: ListenOptions): Promise<Listener> {
  const raw = await ctx.net.listen({ port: options.port, host: options.host });
  let closed = false;

  async function accept(): Promise<Connection> {
    const conn = await raw.accept();
    return {
      readable: conn.readable,
      writable: conn.writable,
      remoteAddress: conn.remote.host,
      close() {
        conn.close();
      },
    };
  }

  return {
    get port() {
      return raw.port;
    },
    accept,
    close() {
      closed = true;
      raw.close();
    },
    async *[Symbol.asyncIterator](): AsyncIterableIterator<Connection> {
      while (!closed) {
        try {
          yield await accept();
        } catch {
          break;
        }
      }
    },
  };
}

const KERNEL_LOCALHOST_RE = /^(\d+)\.kernel\.localhost$/;

const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);

function extractLoopbackPort(url: URL): number | null {
  const m = KERNEL_LOCALHOST_RE.exec(url.hostname);
  if (m) return Number(m[1]);
  return null;
}

function extractPlainLoopbackPort(url: URL): number | null {
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTNAMES.has(url.hostname)) return null;
  return url.port ? Number(url.port) : 80;
}

function isConnectionRefused(err: unknown): boolean {
  const e = err as { code?: unknown; message?: unknown } | null;
  if (e?.code === 'ECONNREFUSED') return true;
  return typeof e?.message === 'string' && e.message.includes('ECONNREFUSED');
}

function isFetchRefused(err: unknown): err is TypeError {
  return err instanceof TypeError && isConnectionRefused((err as { cause?: unknown }).cause);
}

function loopbackRefused(url: URL, port: number, err: TypeError): TypeError {
  return new TypeError(
    `nothing listens on ${url.hostname}:${port} for a kernel program, whose loopback is the kernel's; reach a host server via http://host.slicc.internal:${port}`,
    { cause: err.cause }
  );
}

function collectHeaders(init?: RequestInit): [string, string][] {
  const entries: [string, string][] = [];
  if (!init?.headers) return entries;
  if (init.headers instanceof Headers) {
    for (const [k, v] of (init.headers as Headers).entries()) entries.push([k, v]);
  } else if (Array.isArray(init.headers)) {
    for (const pair of init.headers as [string, string][]) entries.push(pair);
  } else {
    for (const [k, v] of Object.entries(init.headers as Record<string, string>)) {
      if (v != null) entries.push([k, String(v)]);
    }
  }
  return entries;
}

async function encodeBody(
  body: RequestInit['body'],
  headerEntries: [string, string][]
): Promise<Uint8Array> {
  if (body == null) return new Uint8Array(0);
  const encoded = new Response(body);
  const type = encoded.headers.get('content-type');
  if (type && !headerEntries.some(([k]) => k.toLowerCase() === 'content-type')) {
    headerEntries.push(['Content-Type', type]);
  }
  return new Uint8Array(await encoded.arrayBuffer());
}

function buildHttpRequest(
  method: string,
  url: URL,
  headerEntries: [string, string][],
  bodyBytes: Uint8Array
): Uint8Array {
  const enc = new TextEncoder();
  const has = (n: string) => headerEntries.some(([k]) => k.toLowerCase() === n.toLowerCase());
  if (!has('host')) headerEntries.push(['Host', url.host]);
  if (!has('connection')) headerEntries.push(['Connection', 'close']);
  if (bodyBytes.length > 0 && !has('content-length')) {
    headerEntries.push(['Content-Length', String(bodyBytes.length)]);
  }
  const target = url.pathname + (url.search || '');
  let reqText = `${method} ${target} HTTP/1.1\r\n`;
  for (const [k, v] of headerEntries) reqText += `${k}: ${v}\r\n`;
  reqText += '\r\n';
  const headBytes = enc.encode(reqText);
  if (bodyBytes.length === 0) return headBytes;
  const full = new Uint8Array(headBytes.length + bodyBytes.length);
  full.set(headBytes);
  full.set(bodyBytes, headBytes.length);
  return full;
}

function parseHttpResponse(
  buf: Uint8Array,
  headerPos: number,
  bufLen: number
): { status: number; statusText: string; headers: Record<string, string>; body: string } {
  const dec = new TextDecoder();
  const headerText = dec.decode(new Uint8Array(buf.buffer, buf.byteOffset, headerPos));
  const lines = headerText.split('\r\n');
  const statusMatch = /^HTTP\/1\.1\s+(\d+)\s*(.*)/.exec(lines[0] || '');
  const status = statusMatch ? Number(statusMatch[1]) : 500;
  const statusText = statusMatch ? statusMatch[2] : 'Error';
  const respHeaders: Record<string, string> = {};
  for (let i = 1; i < lines.length; i++) {
    const colonIdx = lines[i].indexOf(':');
    if (colonIdx > 0) {
      respHeaders[lines[i].slice(0, colonIdx).trim().toLowerCase()] = lines[i]
        .slice(colonIdx + 1)
        .trim();
    }
  }
  const contentLength = Number(respHeaders['content-length'] ?? 0);
  const headerEndByte = headerPos + 4;
  const responseBody = dec.decode(buf.slice(headerEndByte, headerEndByte + contentLength));
  return { status, statusText, headers: respHeaders, body: responseBody };
}

function isUnsizedEventStream(head: string): boolean {
  const lines = head.toLowerCase().split('\r\n');
  return (
    !lines.some((l) => l.startsWith('content-length:')) &&
    lines.some((l) => l.startsWith('content-type:') && l.includes('text/event-stream'))
  );
}

function streamingResponse(
  head: string,
  rest: Uint8Array,
  reader: ReadableStreamDefaultReader<Uint8Array>,
  close: () => void,
  signal: AbortSignal | null | undefined
): Response {
  const parsed = parseHttpResponse(new TextEncoder().encode(`${head}\r\n\r\n`), head.length, 0);
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    signal?.removeEventListener('abort', abort);
    reader.releaseLock();
    close();
  };
  let fail: (err: unknown) => void = () => {};
  const abort = () => {
    fail(new DOMException('The operation was aborted.', 'AbortError'));
    finish();
  };
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      fail = (err) => controller.error(err);
      if (rest.length > 0) controller.enqueue(rest);
      if (signal?.aborted) abort();
      else signal?.addEventListener('abort', abort, { once: true });
    },
    async pull(controller) {
      const chunk: ReadableStreamReadResult<Uint8Array> = await reader
        .read()
        .catch(() => ({ done: true as const, value: undefined }));
      if (done) return;
      if (chunk.done) {
        finish();
        controller.close();
        return;
      }
      controller.enqueue(chunk.value);
    },
    cancel: finish,
  });
  return new Response(body, {
    status: parsed.status,
    statusText: parsed.statusText,
    headers: parsed.headers,
  });
}

async function kernelLoopbackFetch(
  ctx: KernelContext,
  url: URL,
  port: number,
  init?: RequestInit,
  onRefused?: () => Promise<Response>
): Promise<Response> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const dec = new TextDecoder();
  let conn: Awaited<ReturnType<KernelContext['net']['connect']>>;
  try {
    conn = await ctx.net.connect({ host: '127.0.0.1', port });
  } catch (err) {
    if (onRefused && isConnectionRefused(err)) return onRefused();
    throw err;
  }
  const headerEntries = collectHeaders(init);
  const bodyBytes = await encodeBody(init?.body, headerEntries);
  const writer = conn.writable.getWriter();
  await writer.write(buildHttpRequest(method, url, headerEntries, bodyBytes));

  const reader = conn.readable.getReader();
  let buf = new Uint8Array(4096);
  let bufLen = 0;

  const headerResult = await readUntil(reader, buf, bufLen, '\r\n\r\n', 16384);
  if (!headerResult) {
    reader.releaseLock();
    try {
      await writer.close();
    } catch {}
    conn.close();
    throw new Error('incomplete HTTP response headers');
  }
  buf = headerResult.buf;
  bufLen = headerResult.bufLen;

  const head = dec.decode(new Uint8Array(buf.buffer, buf.byteOffset, headerResult.pos));
  if (isUnsizedEventStream(head)) {
    const rest = buf.slice(headerResult.pos + 4, bufLen);
    return streamingResponse(
      head,
      rest,
      reader,
      () => {
        writer.close().catch(() => {});
        conn.close();
      },
      init?.signal
    );
  }
  const lengthLine = head.split('\r\n').find((l) => l.toLowerCase().startsWith('content-length:'));
  const contentLength = Number(lengthLine?.split(':')[1]?.trim() ?? 0);
  const totalNeeded = headerResult.pos + 4 + contentLength;
  if (bufLen < totalNeeded && contentLength > 0) {
    const bodyResult = await readExact(reader, buf, bufLen, totalNeeded);
    if (bodyResult) {
      buf = bodyResult.buf;
      bufLen = bodyResult.bufLen;
    }
  }

  const parsed = parseHttpResponse(buf, headerResult.pos, bufLen);
  reader.releaseLock();
  try {
    await writer.close();
  } catch {}
  conn.close();
  return new Response(parsed.body, {
    status: parsed.status,
    statusText: parsed.statusText,
    headers: parsed.headers,
  });
}

function createKernelFetch(
  ctx: KernelContext
): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const urlStr =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as { url: string }).url;
    let url: URL;
    try {
      url = new URL(urlStr);
    } catch {
      return ctx.fetch(input, init);
    }
    const port = extractLoopbackPort(url);
    if (port !== null) return kernelLoopbackFetch(ctx, url, port, init);
    const plainPort = extractPlainLoopbackPort(url);
    if (plainPort !== null) {
      return kernelLoopbackFetch(ctx, url, plainPort, init, () =>
        ctx.fetch(input, init).catch((err: unknown) => {
          throw isFetchRefused(err) ? loopbackRefused(url, plainPort, err) : err;
        })
      );
    }
    return ctx.fetch(input, init);
  };
}

async function kernelSeal(ctx: KernelContext, request: string): Promise<string> {
  const f = await ctx.open('/dev/sealed', { read: true, write: true });
  try {
    const enc = new TextEncoder();
    await f.write(0, enc.encode(request));
    const responseBytes = await f.read(0, 65536);
    return new TextDecoder().decode(responseBytes);
  } finally {
    await f.close();
  }
}

export function createKernelPlatform(
  ctx: KernelContext,
  options?: { packageDir?: string }
): Platform {
  const encoder = new TextEncoder();
  return {
    kind: 'kernel' as const,
    fetch: createKernelFetch(ctx) as typeof globalThis.fetch,
    spawn: (options: SpawnOptions) => kernelSpawn(ctx, options),
    listen: (options: ListenOptions) => kernelListen(ctx, options),
    ...(ctx.websocket ? { websocket: (url: string) => ctx.websocket!(url) } : {}),
    fs: kernelFs(ctx),
    env: ctx.env,
    cwd: ctx.cwd,
    isatty: (fd: number) => ctx.isatty(fd),
    stdin: ctx.stdin,
    stdout: ctx.stdout,
    stderr: ctx.stderr,
    async write(fd: number, data: Uint8Array | string): Promise<void> {
      await ctx.write(fd, typeof data === 'string' ? encoder.encode(data) : data);
    },
    exit(code: number): never {
      ctx.exit(code);
    },
    async onSignal(signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP', handler: () => void) {
      await ctx.signals.on(signal, handler);
    },
    async seal(request: string): Promise<string> {
      return kernelSeal(ctx, request);
    },
    packageDir: options?.packageDir,
  };
}
