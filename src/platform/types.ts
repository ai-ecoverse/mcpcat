export interface SpawnResult {
  stdin: WritableStream<Uint8Array>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  wait(): Promise<{ status: number; signal?: string }>;
  kill(signal?: string): void;
}

export interface SpawnOptions {
  argv: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface ListenOptions {
  host?: string;
  port: number;
}

export interface Connection {
  readonly readable: ReadableStream<Uint8Array>;
  readonly writable: WritableStream<Uint8Array>;
  readonly remoteAddress: string;
  close(): void;
}

export interface Listener {
  readonly port: number;
  accept(): Promise<Connection>;
  close(): void;
  [Symbol.asyncIterator](): AsyncIterableIterator<Connection>;
}

export interface FsApi {
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array | string, options?: { mode?: number }): Promise<void>;
  mkdir(path: string, options?: { mode?: number }): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  stat(path: string): Promise<{ size: number; mtimeMs: number }>;
  exists(path: string): Promise<boolean>;
  mkdirExclusive(path: string): Promise<void>;
  rmdir(path: string): Promise<void>;
  unlink?(path: string): Promise<void>;
  createExclusive?(path: string): Promise<void>;
  chmod?(path: string, mode: number): Promise<void>;
}

export interface Platform {
  readonly kind: 'host' | 'kernel';
  fetch: typeof globalThis.fetch;
  spawn(options: SpawnOptions): Promise<SpawnResult>;
  listen?(options: ListenOptions): Promise<Listener>;
  fs: FsApi;
  env: Record<string, string | undefined>;
  cwd: string;
  isatty(fd: number): boolean;
  stdin: ReadableStream<Uint8Array>;
  stdout: WritableStream<Uint8Array>;
  stderr: WritableStream<Uint8Array>;
  write(fd: number, data: Uint8Array | string): Promise<void>;
  exit(code: number): never;
  openUrl?(url: string): Promise<void>;
  onSignal?(signal: 'SIGINT' | 'SIGTERM' | 'SIGHUP', handler: () => void): void;
  seal?(request: string): Promise<string>;
  packageDir?: string;
}
