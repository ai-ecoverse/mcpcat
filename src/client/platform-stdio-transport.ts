import { type JsonRpcMessage, parseJsonRpcMessage } from '@earendil-works/pi-mcp';
import type { Platform, SpawnResult } from '../platform/types.ts';
import { trackStdio } from './stdio-registry.ts';

type MessageListener = (message: JsonRpcMessage) => void;
type ErrorListener = (error: Error) => void;
type CloseListener = () => void;

const DEFAULT_MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 64 * 1024;
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;
const STDIN_CLOSE_GRACE_MS = 500;

export interface PlatformStdioTransportOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  inheritEnv?: boolean;
  platform: Platform;
  onStderr?: (chunk: string) => void;
  maxMessageBytes?: number;
  maxStderrBytes?: number;
  closeTimeoutMs?: number;
  existingProcess?: SpawnResult;
  pendingStdout?: string;
}

export class PlatformStdioTransport {
  private readonly options: PlatformStdioTransportOptions;
  private process: SpawnResult | undefined;
  private started = false;
  private closed = false;
  private closeEmitted = false;
  private stderrText = '';
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();
  private messageListeners: MessageListener[] = [];
  private errorListeners: ErrorListener[] = [];
  private closeListeners: CloseListener[] = [];

  constructor(options: PlatformStdioTransportOptions) {
    this.options = options;
  }

  get stderr(): string {
    return this.stderrText;
  }

  onMessage(listener: MessageListener): () => void {
    this.messageListeners.push(listener);
    return () => {
      this.messageListeners = this.messageListeners.filter((l) => l !== listener);
    };
  }

  onError(listener: ErrorListener): () => void {
    this.errorListeners.push(listener);
    return () => {
      this.errorListeners = this.errorListeners.filter((l) => l !== listener);
    };
  }

  onClose(listener: CloseListener): () => void {
    this.closeListeners.push(listener);
    return () => {
      this.closeListeners = this.closeListeners.filter((l) => l !== listener);
    };
  }

  private emitMessage(message: JsonRpcMessage): void {
    for (const l of [...this.messageListeners]) l(message);
  }

  private emitError(error: Error): void {
    for (const l of [...this.errorListeners]) l(error);
  }

  private emitClose(): void {
    if (this.closeEmitted) return;
    this.closeEmitted = true;
    for (const l of [...this.closeListeners]) l();
  }

  async start(): Promise<void> {
    if (this.started) throw new Error('MCP stdio transport already started');
    if (this.closed) throw new Error('MCP connection closed');
    this.started = true;

    if (this.options.existingProcess) {
      this.process = this.options.existingProcess;
    } else {
      const env =
        this.options.inheritEnv === false
          ? { ...(this.options.env ?? {}) }
          : {
              ...(this.options.platform.env as Record<string, string>),
              ...this.options.env,
            };

      this.process = await this.options.platform.spawn({
        argv: [this.options.command, ...(this.options.args ?? [])],
        env,
        cwd: this.options.cwd,
        dieWithParent: true,
      });
      trackStdio(this.process);
    }

    void this.readStdout(this.options.pendingStdout);
    void this.readStderr();
    void this.waitForExit();
  }

  async send(message: JsonRpcMessage): Promise<void> {
    if (!this.started || this.closed || !this.process) throw new Error('MCP connection closed');
    const payload = `${JSON.stringify(message)}\n`;
    const writer = this.process.stdin.getWriter();
    try {
      await writer.write(this.encoder.encode(payload));
    } finally {
      writer.releaseLock();
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const proc = this.process;
    if (!proc) {
      this.emitClose();
      return;
    }

    const closeTimeoutMs = this.options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
    const grace = Math.min(STDIN_CLOSE_GRACE_MS, closeTimeoutMs);

    const done = proc.wait().then(() => true);
    const delay = (ms: number) => new Promise<false>((r) => setTimeout(() => r(false), ms));

    try {
      await proc.stdin.close();
    } catch {}

    const exited = await Promise.race([done, delay(grace)]);
    if (!exited) {
      await proc.kill('SIGTERM');
      const exitedAfterTerm = await Promise.race([done, delay(closeTimeoutMs)]);
      if (!exitedAfterTerm) {
        await proc.kill('SIGKILL');
        await done;
      }
    }

    await proc.kill('SIGTERM');

    this.emitClose();
  }

  private async readStdout(pending?: string): Promise<void> {
    const proc = this.process;
    if (!proc) return;
    const reader = proc.stdout.getReader();
    const maxBytes = this.options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
    let buffer = pending ?? '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += this.decoder.decode(value, { stream: true });
        let nlIdx = buffer.indexOf('\n');
        while (nlIdx >= 0) {
          const line = buffer.slice(0, nlIdx).replace(/\r$/, '');
          buffer = buffer.slice(nlIdx + 1);
          if (line.trim()) {
            try {
              this.emitMessage(parseJsonRpcMessage(JSON.parse(line)));
            } catch (err) {
              this.emitError(err as Error);
            }
          }
          nlIdx = buffer.indexOf('\n');
        }
        if (this.encoder.encode(buffer).length > maxBytes) {
          buffer = '';
          this.emitError(new Error(`MCP stdio message exceeds ${maxBytes} bytes`));
        }
      }
      buffer += this.decoder.decode();
      if (buffer.trim()) {
        this.emitError(new Error('MCP stdio server closed with an incomplete JSON-RPC message'));
      }
    } catch (err) {
      if (!this.closed) this.emitError(err as Error);
    } finally {
      reader.releaseLock();
    }
  }

  private async readStderr(): Promise<void> {
    const proc = this.process;
    if (!proc) return;
    const reader = proc.stderr.getReader();
    const maxBytes = this.options.maxStderrBytes ?? DEFAULT_MAX_STDERR_BYTES;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = this.decoder.decode(value, { stream: true });
        this.stderrText += chunk;
        if (this.encoder.encode(this.stderrText).length > maxBytes) {
          this.stderrText = this.stderrText.slice(-maxBytes);
        }
        this.options.onStderr?.(chunk);
      }
    } catch {}
  }

  private async waitForExit(): Promise<void> {
    const proc = this.process;
    if (!proc) return;
    try {
      await proc.wait();
    } catch {}
    try {
      await proc.kill('SIGTERM');
    } catch {}
    if (!this.closed) {
      this.emitClose();
    }
  }
}
