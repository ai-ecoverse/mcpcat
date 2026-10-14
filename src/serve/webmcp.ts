import type { Platform, SpawnResult } from '../platform/types.ts';
import type { JsonObjectSchema } from './catalog.ts';
import type { RpcTool, ToolRunResult } from './jsonrpc.ts';

export interface WebMcpAnnotations {
  readOnlyHint?: boolean;
  consequentialHint?: boolean;
  untrustedContentHint?: boolean;
}

export interface WebMcpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  origin: string;
  annotations?: WebMcpAnnotations;
}

export interface WebMcpOptions {
  playwrightCli: string;
  tab?: string;
  cdp?: string;
  allowConsequential: boolean;
  ttlMs: number;
  callTimeoutMs: number;
  maxOutput: number;
}

interface CacheEntry {
  tools: WebMcpTool[];
  expiresAt: number;
}

function buildBaseArgs(options: WebMcpOptions): string[] {
  const args: string[] = [];
  if (options.cdp) {
    args.push('--cdp', options.cdp);
  }
  if (options.tab) {
    args.push('--tab', options.tab);
  }
  return args;
}

function generateNonce(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function wrapUntrusted(content: string): string {
  const nonce = generateNonce();
  const openTag = `<<untrusted-page-content id=${nonce}>>`;
  const closeTag = `<<end id=${nonce}>>`;
  const neutralised = content.replaceAll('<<untrusted-page-content', '< <untrusted-page-content');
  return `${openTag}\n${neutralised}\n${closeTag}`;
}

async function runProcess(
  platform: Platform,
  argv: string[],
  stdin?: string,
  timeoutMs?: number
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  let proc: SpawnResult;
  try {
    proc = await platform.spawn({ argv });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EACCES') {
      return { stdout: '', stderr: `command not found: ${argv[0]}`, exitCode: -1 };
    }
    throw err;
  }

  if (stdin !== undefined) {
    const writer = proc.stdin.getWriter();
    await writer.write(new TextEncoder().encode(stdin));
    await writer.close();
  } else {
    try {
      await proc.stdin.getWriter().close();
    } catch {}
  }

  const stdoutChunks: Uint8Array[] = [];
  const stderrChunks: Uint8Array[] = [];

  const readStream = async (stream: ReadableStream<Uint8Array>, into: Uint8Array[]) => {
    const r = stream.getReader();
    try {
      for (;;) {
        const { done, value } = await r.read();
        if (done) break;
        into.push(value);
      }
    } finally {
      r.releaseLock();
    }
  };

  const timer = new Promise<'timeout'>((resolve) =>
    setTimeout(() => resolve('timeout'), timeoutMs ?? 30_000)
  );

  const work = Promise.all([
    readStream(proc.stdout, stdoutChunks),
    readStream(proc.stderr, stderrChunks),
    proc.wait(),
  ]);

  const result = await Promise.race([work, timer]);

  if (result === 'timeout') {
    await proc.kill('SIGTERM');
    return { stdout: '', stderr: 'timed out', exitCode: 124 };
  }

  const [, , exitResult] = result;
  const dec = new TextDecoder();
  const concat = (chunks: Uint8Array[]) => {
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  };
  return {
    stdout: dec.decode(concat(stdoutChunks)),
    stderr: dec.decode(concat(stderrChunks)),
    exitCode: exitResult.status,
  };
}

export function createWebMcpHandler(platform: Platform, options: WebMcpOptions) {
  let cache: CacheEntry | undefined;
  const baseArgs = buildBaseArgs(options);

  async function listRaw(): Promise<{ tools: WebMcpTool[]; error?: string; notFound?: boolean }> {
    const now = Date.now();
    if (cache && now < cache.expiresAt) {
      return { tools: cache.tools };
    }

    const argv = [options.playwrightCli, 'webmcp-list', '--json', ...baseArgs];
    const result = await runProcess(platform, argv, undefined, options.callTimeoutMs);

    if (result.exitCode === -1) {
      return { tools: [], error: result.stderr, notFound: true };
    }

    if (result.exitCode !== 0) {
      return { tools: [], error: result.stderr || `webmcp-list exited ${result.exitCode}` };
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      return { tools: [], error: 'webmcp-list returned invalid JSON' };
    }

    if (!Array.isArray(parsed)) {
      return { tools: [], error: 'webmcp-list did not return an array' };
    }

    const tools = parsed as WebMcpTool[];
    cache = { tools, expiresAt: now + options.ttlMs };
    return { tools };
  }

  function mapDescriptionAnnotations(ann?: WebMcpAnnotations): Record<string, boolean> {
    const mapped: Record<string, boolean> = { openWorldHint: true };
    if (!ann) return mapped;
    if (ann.readOnlyHint !== undefined) mapped.readOnlyHint = ann.readOnlyHint;
    if (ann.consequentialHint) mapped.destructiveHint = true;
    return mapped;
  }

  function originPrefix(tools: WebMcpTool[]): boolean {
    const origins = new Set(tools.map((t) => t.origin));
    return origins.size > 1;
  }

  function hostFromOrigin(origin: string): string {
    try {
      return new URL(origin).host;
    } catch {
      return origin;
    }
  }

  function buildDescription(tool: WebMcpTool): string {
    const parts: string[] = [];
    if (tool.description) parts.push(tool.description);
    parts.push(`[origin: ${tool.origin}]`);
    return parts.join('\n');
  }

  function buildToolName(tool: WebMcpTool, prefix: boolean): string {
    const base = tool.name;
    if (!prefix) return base;
    const host = hostFromOrigin(tool.origin).replace(/[^a-zA-Z0-9_]/g, '_');
    return `${host}__${base}`;
  }

  async function getRpcTools(): Promise<RpcTool[] | null> {
    const { tools, error, notFound } = await listRaw();
    if (notFound) return null;
    if (error) return [];

    const needPrefix = originPrefix(tools);
    const rpcTools: RpcTool[] = [];

    for (const tool of tools) {
      if (tool.annotations?.consequentialHint && !options.allowConsequential) {
        continue;
      }
      const mapped = mapDescriptionAnnotations(tool.annotations);
      rpcTools.push({
        name: buildToolName(tool, needPrefix),
        description: buildDescription(tool),
        inputSchema: tool.inputSchema as unknown as JsonObjectSchema,
        annotations: mapped,
      });
    }

    return rpcTools;
  }

  async function callTool(name: string, args: unknown): Promise<ToolRunResult> {
    const { tools, error } = await listRaw();
    if (error) {
      return { stdout: '', stderr: error, exitCode: 2 };
    }

    const needPrefix = originPrefix(tools);
    const tool = tools.find((t) => buildToolName(t, needPrefix) === name);
    if (!tool) {
      return { stdout: '', stderr: `unknown tool: ${name}`, exitCode: 2 };
    }

    const argv = [options.playwrightCli, 'webmcp-call', tool.name, '-', ...baseArgs];
    if (options.allowConsequential) {
      argv.push('--allow-consequential');
    }

    const stdinData = JSON.stringify(args ?? {});
    const result = await runProcess(platform, argv, stdinData, options.callTimeoutMs);

    if (result.exitCode === -1) {
      throw new Error(result.stderr || 'playwright-cli not found');
    }

    if (result.exitCode === 2) {
      throw new Error(result.stderr || 'webmcp-call error');
    }

    const meta: Record<string, unknown> = {
      'io.mcpcat/untrusted': true,
      origin: tool.origin,
    };

    if (result.exitCode === 1) {
      return {
        stdout: '',
        stderr: wrapUntrusted(result.stderr || result.stdout),
        exitCode: 1,
        meta,
      };
    }

    const text = wrapUntrusted(result.stdout);
    return { stdout: text, stderr: result.stderr, exitCode: 0, meta };
  }

  function invalidateCache(): void {
    cache = undefined;
  }

  return { getRpcTools, callTool, invalidateCache };
}
