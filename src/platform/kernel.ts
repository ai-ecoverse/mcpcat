import type {
  Connection,
  FsApi,
  Listener,
  ListenOptions,
  Platform,
  SpawnOptions,
  SpawnResult,
} from './types.ts';

interface KernelContext {
  argv: string[];
  env: Record<string, string | undefined>;
  cwd: string;
  stdin: ReadableStream<Uint8Array>;
  stdout: WritableStream<Uint8Array>;
  stderr: WritableStream<Uint8Array>;
  write(fd: number, data: Uint8Array | string): Promise<void>;
  read(fd: number, max?: number): Promise<Uint8Array>;
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
  };
  fetch: typeof globalThis.fetch;
  spawn(options: {
    argv: string[];
    env?: Record<string, string>;
    cwd?: string;
    stdin?: 'inherit' | 'pipe' | 'null';
    stdout?: 'inherit' | 'pipe' | 'null';
    stderr?: 'inherit' | 'pipe' | 'null';
  }): Promise<{
    pid: number;
    stdin?: WritableStream<Uint8Array>;
    stdout?: ReadableStream<Uint8Array>;
    stderr?: ReadableStream<Uint8Array>;
    wait(): Promise<{ status: number; signal?: string }>;
    kill(signal?: string): void;
  }>;
  wait(pid: number): Promise<{ status: number; signal?: string }>;
  kill(pid: number, signal?: string): void;
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
    on(signal: string | number, handler: () => void): void;
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
      const exists = await ctx.fs.exists(path);
      if (exists) {
        const err = new Error(`EEXIST: directory already exists, mkdir '${path}'`);
        (err as NodeJS.ErrnoException).code = 'EEXIST';
        throw err;
      }
      await ctx.fs.mkdir(path);
    },
    rmdir: (path: string) => ctx.fs.rm(path),
  };
}

async function kernelSpawn(ctx: KernelContext, options: SpawnOptions): Promise<SpawnResult> {
  const result = await ctx.spawn({
    argv: options.argv,
    env: options.env as Record<string, string> | undefined,
    cwd: options.cwd,
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
  });
  return {
    stdin: result.stdin!,
    stdout: result.stdout!,
    stderr: result.stderr!,
    wait: () => result.wait(),
    kill: (signal?: string) => result.kill(signal),
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

export function createKernelPlatform(ctx: KernelContext): Platform {
  const encoder = new TextEncoder();
  return {
    fetch: ctx.fetch,
    spawn: (options: SpawnOptions) => kernelSpawn(ctx, options),
    listen: (options: ListenOptions) => kernelListen(ctx, options),
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
    onSignal(signal: 'SIGINT' | 'SIGTERM', handler: () => void) {
      ctx.signals.on(signal, handler);
    },
  };
}
