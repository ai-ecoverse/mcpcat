export const HOLDER_RESTART_MIN_MS = 500;
export const HOLDER_RESTART_MAX_MS = 30_000;
export const HOLDER_STABLE_MS = 30_000;
export const HOLDER_STOP_GRACE_MS = 2000;
export const HOLDER_READY_MS = 20_000;

export interface HolderOptions {
  playwrightCli: string;
  cdp?: string;
  tab: string;
  reload: boolean;
  readyTimeoutMs: number;
  fromOrigins?: string[];
  report(line: string): Promise<void> | void;
}

export interface HolderStatus {
  mode?: string;
  late: boolean;
  native: boolean;
  loaderId?: string;
  error?: string;
  refused?: boolean;
  crossOriginOff?: boolean;
}

export interface ToolsChanged {
  frameId?: unknown;
  loaderId?: unknown;
  origin?: unknown;
  tools?: unknown;
}

export interface Holder {
  ready(): Promise<void>;
  status(): HolderStatus;
  onDocument(listener: () => void): void;
  onToolsChanged(listener: (event: ToolsChanged) => void): void;
  stop(): Promise<void>;
}

export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export function parseCliVersion(text: string): string | undefined {
  return /playwright-cli\s+v?(\d+\.\d+\.\d+)/.exec(text)?.[1];
}

export async function drain(stream: ReadableStream<Uint8Array>, onLine: (line: string) => void) {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        onLine(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    }
  } catch {}
  buffer += dec.decode();
  if (buffer) onLine(buffer);
}
