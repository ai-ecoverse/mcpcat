import { spawn as cpSpawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, readFile, rename, rmdir, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { Readable, Writable } from 'node:stream';
import * as tty from 'node:tty';
import type {
  Connection,
  FsApi,
  Listener,
  ListenOptions,
  Platform,
  SpawnOptions,
  SpawnResult,
} from './types.ts';

const USE_PROCESS_GROUPS = process.platform !== 'win32';

function nodeSpawn(options: SpawnOptions): Promise<SpawnResult> {
  const child = cpSpawn(options.argv[0], options.argv.slice(1), {
    env: options.env ?? (process.env as Record<string, string>),
    cwd: options.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: USE_PROCESS_GROUPS,
  });

  const stdout = Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>;
  const stderr = Readable.toWeb(child.stderr!) as ReadableStream<Uint8Array>;
  const stdin = Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>;

  return Promise.resolve({
    stdin,
    stdout,
    stderr,
    wait(): Promise<{ status: number; signal?: string }> {
      return new Promise((resolve) => {
        child.on('close', (code, signal) => {
          resolve({
            status: signal ? 128 + (signalNumber(signal) ?? 0) : (code ?? 1),
            signal: signal ?? undefined,
          });
        });
      });
    },
    kill(signal?: string) {
      const sig = (signal as NodeJS.Signals) ?? 'SIGTERM';
      const pid = child.pid;
      if (USE_PROCESS_GROUPS && pid !== undefined) {
        try {
          process.kill(-pid, sig);
          return;
        } catch {}
      }
      try {
        child.kill(sig);
      } catch {}
    },
  });
}

function signalNumber(sig: string): number | undefined {
  const map: Record<string, number> = {
    SIGHUP: 1,
    SIGINT: 2,
    SIGQUIT: 3,
    SIGTERM: 15,
    SIGKILL: 9,
  };
  return map[sig];
}

const hostFs: FsApi = {
  async readFile(path: string): Promise<Uint8Array> {
    return new Uint8Array(await readFile(path));
  },
  async writeFile(path: string, data: Uint8Array | string): Promise<void> {
    await writeFile(path, data);
  },
  async mkdir(path: string): Promise<void> {
    await mkdir(path, { recursive: true });
  },
  async rename(from: string, to: string): Promise<void> {
    await rename(from, to);
  },
  async stat(path: string): Promise<{ size: number; mtimeMs: number }> {
    const s = await stat(path);
    return { size: s.size, mtimeMs: s.mtimeMs };
  },
  async exists(path: string): Promise<boolean> {
    try {
      await access(path, constants.F_OK);
      return true;
    } catch {
      return false;
    }
  },
  async mkdirExclusive(path: string): Promise<void> {
    await mkdir(path, { recursive: false });
  },
  async rmdir(path: string): Promise<void> {
    await rmdir(path);
  },
};

function createStdinStream(): ReadableStream<Uint8Array> {
  return Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;
}

function createStdoutStream(): WritableStream<Uint8Array> {
  return Writable.toWeb(process.stdout) as WritableStream<Uint8Array>;
}

function createStderrStream(): WritableStream<Uint8Array> {
  return Writable.toWeb(process.stderr) as WritableStream<Uint8Array>;
}

function nodeListen(options: ListenOptions): Promise<Listener> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    const pending: Array<{
      resolve: (conn: Connection) => void;
      reject: (err: Error) => void;
    }> = [];
    const ready: Connection[] = [];
    let closed = false;

    server.on('connection', (socket) => {
      const conn: Connection = {
        readable: Readable.toWeb(socket) as ReadableStream<Uint8Array>,
        writable: Writable.toWeb(socket) as WritableStream<Uint8Array>,
        remoteAddress: socket.remoteAddress ?? '',
        close() {
          socket.destroy();
        },
      };
      const waiter = pending.shift();
      if (waiter) {
        waiter.resolve(conn);
      } else {
        ready.push(conn);
      }
    });

    server.on('error', (err) => {
      if (!closed) reject(err);
      for (const waiter of pending) waiter.reject(err);
      pending.length = 0;
    });

    server.listen(options.port, options.host ?? '127.0.0.1', () => {
      const addr = server.address();
      const actualPort = typeof addr === 'object' && addr ? addr.port : options.port;

      const listener: Listener = {
        get port() {
          return actualPort;
        },
        accept(): Promise<Connection> {
          const queued = ready.shift();
          if (queued) return Promise.resolve(queued);
          return new Promise<Connection>((res, rej) => {
            if (closed) {
              rej(new Error('listener closed'));
              return;
            }
            pending.push({ resolve: res, reject: rej });
          });
        },
        close() {
          closed = true;
          server.close();
          for (const waiter of pending) waiter.reject(new Error('listener closed'));
          pending.length = 0;
        },
        async *[Symbol.asyncIterator](): AsyncIterableIterator<Connection> {
          while (!closed) {
            try {
              yield await this.accept();
            } catch {
              break;
            }
          }
        },
      };

      resolve(listener);
    });
  });
}

export function createHostPlatform(): Platform {
  const encoder = new TextEncoder();
  return {
    fetch: globalThis.fetch,
    spawn: nodeSpawn,
    listen: nodeListen,
    fs: hostFs,
    env: process.env as Record<string, string | undefined>,
    cwd: process.cwd(),
    isatty(fd: number): boolean {
      return tty.isatty(fd);
    },
    stdin: createStdinStream(),
    stdout: createStdoutStream(),
    stderr: createStderrStream(),
    async write(fd: number, data: Uint8Array | string): Promise<void> {
      const bytes = typeof data === 'string' ? encoder.encode(data) : data;
      const stream = fd === 1 ? process.stdout : process.stderr;
      return new Promise<void>((resolve, reject) => {
        stream.write(bytes, (err) => (err ? reject(err) : resolve()));
      });
    },
    exit(code: number): never {
      process.exit(code);
    },
    onSignal(signal: 'SIGINT' | 'SIGTERM', handler: () => void) {
      process.on(signal, handler);
    },
  };
}
