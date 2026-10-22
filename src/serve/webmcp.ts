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

export const WEBMCP_LIST_FLOOR = 1_048_576;

interface Capped {
  text: string;
  cut: boolean;
}

function capCollector(limit: number) {
  const dec = new TextDecoder();
  const half = Math.floor(limit / 2);
  let head = '';
  let tail = '';
  let total = 0;
  const take = (piece: string) => {
    if (!piece) return;
    total += piece.length;
    if (head.length < limit) head += piece.slice(0, limit - head.length);
    tail = half > 0 ? (tail + piece).slice(-half) : '';
  };
  return {
    push(chunk: Uint8Array) {
      take(dec.decode(chunk, { stream: true }));
    },
    finish(): Capped {
      take(dec.decode());
      if (total <= limit) return { text: head, cut: false };
      return {
        text: `${head.slice(0, half)}\n… ${total - limit} characters cut …\n${tail}`,
        cut: true,
      };
    },
  };
}

async function runProcess(
  platform: Platform,
  argv: string[],
  stdin: string | undefined,
  timeoutMs: number,
  limit: number
): Promise<{ stdout: string; stderr: string; exitCode: number; cut: boolean }> {
  let proc: SpawnResult;
  try {
    proc = await platform.spawn({ argv });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EACCES') {
      return { stdout: '', stderr: `command not found: ${argv[0]}`, exitCode: -1, cut: false };
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

  const out = capCollector(limit);
  const err = capCollector(limit);

  const readStream = async (
    stream: ReadableStream<Uint8Array>,
    into: ReturnType<typeof capCollector>
  ) => {
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

  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const timer = new Promise<'timeout'>((resolve) => {
    timeoutId = setTimeout(() => resolve('timeout'), timeoutMs);
  });

  const work = Promise.all([
    readStream(proc.stdout, out),
    readStream(proc.stderr, err),
    proc.wait(),
  ]);

  const result = await Promise.race([work, timer]);
  clearTimeout(timeoutId);

  if (result === 'timeout') {
    await proc.kill('SIGTERM');
    return { stdout: '', stderr: 'timed out', exitCode: 124, cut: false };
  }

  const [, , exitResult] = result;
  const stdout = out.finish();
  const stderr = err.finish();
  return {
    stdout: stdout.text,
    stderr: stderr.text,
    exitCode: exitResult.status,
    cut: stdout.cut,
  };
}

export async function resolveWebMcpTab(
  platform: Platform,
  options: Pick<WebMcpOptions, 'playwrightCli' | 'cdp' | 'callTimeoutMs'>
): Promise<{ tab?: string; error?: string; notFound?: boolean }> {
  const argv = [options.playwrightCli, 'tab-list'];
  if (options.cdp) argv.push('--cdp', options.cdp);
  const result = await runProcess(
    platform,
    argv,
    undefined,
    options.callTimeoutMs,
    WEBMCP_LIST_FLOOR
  );
  if (result.exitCode === -1) return { error: result.stderr, notFound: true };
  if (result.exitCode !== 0) {
    return { error: result.stderr.trim() || `tab-list exited ${result.exitCode}` };
  }
  const rows: { id: string; active: boolean }[] = [];
  for (const line of result.stdout.split('\n')) {
    const match = /^(\d+): \[([^\]\s]+)\] /.exec(line);
    if (!match) continue;
    if (Number(match[1]) !== rows.length + 1) {
      return { error: 'could not read playwright-cli tab-list' };
    }
    rows.push({ id: match[2]!, active: line.endsWith('" (active)') });
  }
  const active = rows.filter((r) => r.active);
  if (new Set(rows.map((r) => r.id)).size !== rows.length || active.length > 1) {
    return { error: 'could not read playwright-cli tab-list' };
  }
  if (active.length === 1) return { tab: active[0]!.id };
  if (rows.length === 1) return { tab: rows[0]!.id };
  return {
    error:
      rows.length === 0
        ? 'no browser tab is open; open one or pass --tab <targetId>'
        : 'no current playwright-cli tab; pass --tab <targetId> (see playwright-cli tab-list)',
  };
}

function mapDescriptionAnnotations(ann?: WebMcpAnnotations): Record<string, boolean> {
  const mapped: Record<string, boolean> = { openWorldHint: true };
  if (!ann) return mapped;
  if (ann.readOnlyHint !== undefined) mapped.readOnlyHint = ann.readOnlyHint;
  if (ann.untrustedContentHint) mapped.untrustedContentHint = true;
  if (ann.consequentialHint) {
    mapped.destructiveHint = true;
    mapped.consequentialHint = true;
  }
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

function exposedTools(
  tools: WebMcpTool[]
): { name: string; tool: WebMcpTool; peers: WebMcpTool[] }[] {
  const needPrefix = originPrefix(tools);
  const byBase = new Map<string, WebMcpTool[]>();
  const byName = new Map<string, WebMcpTool[]>();
  for (const tool of tools) {
    const name = buildToolName(tool, needPrefix);
    byBase.set(tool.name, [...(byBase.get(tool.name) ?? []), tool]);
    byName.set(name, [...(byName.get(name) ?? []), tool]);
  }
  return tools.map((tool) => {
    const name = buildToolName(tool, needPrefix);
    const sameBase = byBase.get(tool.name)!;
    const sameName = byName.get(name)!;
    return { name, tool, peers: sameBase.length > 1 ? sameBase : sameName };
  });
}

function ambiguityError(name: string, peers: WebMcpTool[]): Error {
  const origins = [...new Set(peers.map((t) => String(t.origin)))].join(', ');
  return new Error(
    `tool "${name}" is ambiguous: ${peers.length} tools on the page match it (${origins}), and playwright-cli runs the first tool by name and cannot select one by origin, so mcpcat refuses the call`
  );
}

export function createWebMcpHandler(platform: Platform, options: WebMcpOptions) {
  let cache: CacheEntry | undefined;
  const baseArgs = buildBaseArgs(options);

  const listLimit = Math.max(options.maxOutput, WEBMCP_LIST_FLOOR);

  async function listRaw(
    fresh = false
  ): Promise<{ tools: WebMcpTool[]; error?: string; notFound?: boolean }> {
    const now = Date.now();
    if (!fresh && cache && now < cache.expiresAt) {
      return { tools: cache.tools };
    }

    const argv = [options.playwrightCli, 'webmcp-list', '--json', ...baseArgs];
    const result = await runProcess(platform, argv, undefined, options.callTimeoutMs, listLimit);

    if (result.exitCode === -1) {
      return { tools: [], error: result.stderr, notFound: true };
    }

    if (result.exitCode !== 0) {
      return { tools: [], error: result.stderr || `webmcp-list exited ${result.exitCode}` };
    }

    if (result.cut) {
      return { tools: [], error: `webmcp-list output exceeds ${listLimit} characters` };
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

  async function getRpcTools(): Promise<RpcTool[] | null> {
    const { tools, error, notFound } = await listRaw();
    if (notFound) return null;
    if (error) return [];

    const rpcTools: RpcTool[] = [];

    for (const { name, tool, peers } of exposedTools(tools)) {
      if (peers.length > 1) continue;
      if (tool.annotations?.consequentialHint && !options.allowConsequential) {
        continue;
      }
      const mapped = mapDescriptionAnnotations(tool.annotations);
      rpcTools.push({
        name,
        description: buildDescription(tool),
        inputSchema: tool.inputSchema as unknown as JsonObjectSchema,
        annotations: mapped,
      });
    }

    return rpcTools;
  }

  async function callTool(name: string, args: unknown): Promise<ToolRunResult> {
    const { tools, error } = await listRaw(true);
    if (error) {
      return { stdout: '', stderr: error, exitCode: 2 };
    }

    const match = exposedTools(tools).find((t) => t.name === name);
    if (!match) {
      return { stdout: '', stderr: `unknown tool: ${name}`, exitCode: 2 };
    }
    if (match.peers.length > 1) {
      throw ambiguityError(name, match.peers);
    }
    const { tool } = match;

    const argv = [options.playwrightCli, 'webmcp-call', tool.name, '-', ...baseArgs];
    if (options.allowConsequential) {
      argv.push('--allow-consequential');
    }

    const stdinData = JSON.stringify(args ?? {});
    const result = await runProcess(
      platform,
      argv,
      stdinData,
      options.callTimeoutMs,
      options.maxOutput
    );

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
