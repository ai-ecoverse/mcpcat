import type { Platform, SpawnResult } from '../platform/types.ts';
import {
  argvForCommand,
  attachGlobalFlags,
  buildTools,
  type CliCommand,
  cliPrefix,
  isGroupCandidate,
  nestGroup,
  parseHelp,
  parseMcpOverride,
  parseToolTemplate,
  readToolArguments,
  type ServeTool,
  templateToArgv,
} from './catalog.ts';
import { type HttpRequest, type HttpResponse, handleConnection } from './http.ts';
import { handleJsonRpc, type RpcTool, type ToolRunResult } from './jsonrpc.ts';
import { checkHost, checkOrigin } from './origin.ts';

const CALL_TIMEOUT_MS = 120_000;
const ALLOWED_ENV_KEYS = new Set(['PATH', 'HOME', 'LANG']);

export interface ServeOptions {
  transport: 'stdio' | 'http';
  host: string;
  port: number;
  commands: { path: string; name?: string }[];
  toolTemplates: string[];
  bearer?: string;
  allowOrigins: string[];
  envAllow: string[];
  callTimeout: number;
  concurrency: number;
}

function parseHttpFlag(args: string[], i: number): { host: string; port: number; next: number } {
  const next = args[i + 1];
  if (!next || next.startsWith('-')) return { host: '127.0.0.1', port: 0, next: i };
  const colonIdx = next.lastIndexOf(':');
  if (colonIdx > 0 && colonIdx < next.length - 1) {
    return { host: next.slice(0, colonIdx), port: Number(next.slice(colonIdx + 1)), next: i + 1 };
  }
  return { host: '127.0.0.1', port: Number(next), next: i + 1 };
}

function parseCommandTarget(arg: string): { path: string; name?: string } {
  const eqIdx = arg.indexOf('=');
  if (eqIdx > 0 && !arg.slice(0, eqIdx).includes('/')) {
    return { name: arg.slice(0, eqIdx), path: arg.slice(eqIdx + 1) };
  }
  return { path: arg };
}

export function parseServeFlags(args: string[]): ServeOptions {
  let transport: 'stdio' | 'http' = 'stdio';
  let host = '127.0.0.1';
  let port = 0;
  let bearer: string | undefined;
  const allowOrigins: string[] = [];
  const envAllow: string[] = [];
  const toolTemplates: string[] = [];
  let callTimeout = CALL_TIMEOUT_MS;
  let concurrency = 1;
  const commands: { path: string; name?: string }[] = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--stdio') {
      transport = 'stdio';
    } else if (arg === '--http') {
      transport = 'http';
      const parsed = parseHttpFlag(args, i);
      host = parsed.host;
      port = parsed.port;
      i = parsed.next;
    } else if (arg === '--bearer' && args[i + 1]) {
      bearer = args[++i];
    } else if (arg === '--allow-origin' && args[i + 1]) {
      allowOrigins.push(args[++i]);
    } else if (arg === '--env' && args[i + 1]) {
      envAllow.push(args[++i]);
    } else if (arg === '--tool' && args[i + 1]) {
      toolTemplates.push(args[++i]);
    } else if (arg === '--call-timeout' && args[i + 1]) {
      callTimeout = Number(args[++i]) * 1000;
    } else if (arg === '--concurrency' && args[i + 1]) {
      concurrency = Number(args[++i]);
    } else if (!arg.startsWith('-')) {
      commands.push(parseCommandTarget(arg));
    }
  }

  return {
    transport,
    host,
    port,
    commands,
    toolTemplates,
    bearer,
    allowOrigins,
    envAllow,
    callTimeout,
    concurrency,
  };
}

function buildChildEnv(platform: Platform, envAllow: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of ALLOWED_ENV_KEYS) {
    if (platform.env[key]) env[key] = platform.env[key]!;
  }
  for (const entry of envAllow) {
    const eqIdx = entry.indexOf('=');
    if (eqIdx > 0) {
      env[entry.slice(0, eqIdx)] = entry.slice(eqIdx + 1);
    } else if (platform.env[entry]) {
      env[entry] = platform.env[entry]!;
    }
  }
  return env;
}

async function runCommand(
  platform: Platform,
  cmdPath: string,
  argv: string[],
  childEnv: Record<string, string>,
  stdin: string | undefined,
  timeoutMs: number
): Promise<ToolRunResult> {
  let proc: SpawnResult;
  try {
    proc = await platform.spawn({
      argv: [cmdPath, ...argv],
      env: childEnv,
      cwd: platform.cwd,
    });
  } catch (err) {
    return { stdout: '', stderr: `spawn failed: ${(err as Error).message}`, exitCode: 127 };
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
    setTimeout(() => resolve('timeout'), timeoutMs)
  );

  const work = Promise.all([
    readStream(proc.stdout, stdoutChunks),
    readStream(proc.stderr, stderrChunks),
    proc.wait(),
  ]);

  const result = await Promise.race([work, timer]);

  if (result === 'timeout') {
    proc.kill('SIGTERM');
    await new Promise<void>((resolve) => setTimeout(resolve, 5000));
    try {
      proc.kill('SIGKILL');
    } catch {}
    return { stdout: '', stderr: 'timed out', exitCode: 124 };
  }

  const [, , exitResult] = result;
  const dec = new TextDecoder();
  return {
    stdout: dec.decode(concat(stdoutChunks)),
    stderr: dec.decode(concat(stderrChunks)),
    exitCode: exitResult.status,
  };
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

async function runHelpForCli(
  platform: Platform,
  filePath: string,
  childEnv: Record<string, string>
): Promise<string> {
  const dashed = await runCommand(platform, filePath, ['--help'], childEnv, undefined, 10_000);
  if (dashed.exitCode === 0 && dashed.stdout.trim()) return dashed.stdout;
  const plain = await runCommand(platform, filePath, ['help'], childEnv, undefined, 10_000);
  if (plain.exitCode === 0 && plain.stdout.trim()) return plain.stdout;
  return dashed.stdout.trim() ? dashed.stdout : '';
}

async function expandGroupCommands(
  platform: Platform,
  filePath: string,
  commands: CliCommand[],
  childEnv: Record<string, string>
): Promise<CliCommand[]> {
  const topNames = new Set(commands.map((c) => c.path[0] ?? ''));
  let current = commands;
  for (const command of commands) {
    if (!isGroupCandidate(command)) continue;
    const group = command.path[0] ?? '';
    const nested = await runCommand(
      platform,
      filePath,
      [group, '--help'],
      childEnv,
      undefined,
      10_000
    );
    if (nested.exitCode !== 0 || !nested.stdout.trim()) continue;
    const replaced = nestGroup(current, group, parseHelp(nested.stdout), topNames);
    if (replaced) current = replaced;
  }
  return current;
}

interface PublishedCli {
  name: string;
  path: string;
  commands: CliCommand[];
}

async function discoverCli(
  platform: Platform,
  filePath: string,
  explicitName: string | undefined,
  childEnv: Record<string, string>
): Promise<PublishedCli> {
  const mcp = await runCommand(platform, filePath, ['--mcp'], childEnv, undefined, 10_000);
  const override = mcp.exitCode === 0 ? parseMcpOverride(mcp.stdout) : null;
  const helpText = override ? '' : await runHelpForCli(platform, filePath, childEnv);

  if (!override && !helpText.trim()) {
    throw new Error(`${filePath} did not print help or --mcp descriptor`);
  }

  const parsed = override ?? parseHelp(helpText);
  let commands = parsed.commands;

  if (!override) {
    commands = attachGlobalFlags(commands, parsed.globalFlags);
    commands = await expandGroupCommands(platform, filePath, commands, childEnv);
  }

  return { name: cliPrefix(helpText, filePath, explicitName), path: filePath, commands };
}

export async function runServe(
  platform: Platform,
  options: ServeOptions,
  version: string
): Promise<number> {
  const childEnv = buildChildEnv(platform, options.envAllow);
  const clis: PublishedCli[] = [];

  for (const cmd of options.commands) {
    try {
      const cli = await discoverCli(platform, cmd.path, cmd.name, childEnv);
      clis.push(cli);
    } catch (err) {
      await platform.write(2, `mcpcat serve: ${(err as Error).message}\n`);
      return 2;
    }
  }

  const allTools: ServeTool[] = clis.flatMap((cli) => buildTools(cli.name, cli.commands));

  for (const spec of options.toolTemplates) {
    const tool = parseToolTemplate(spec);
    if (!tool) {
      await platform.write(2, `mcpcat serve: invalid --tool spec: ${spec}\n`);
      return 2;
    }
    allTools.push(tool);
  }

  const rpcTools: RpcTool[] = allTools.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
  }));

  const serverName = 'mcpcat-serve';

  const queues = new Map<string, Promise<unknown>>();

  function enqueue<T>(key: string, job: () => Promise<T>): Promise<T> {
    const previous = queues.get(key) ?? Promise.resolve();
    const run = previous.then(job, job);
    queues.set(
      key,
      run.then(
        () => undefined,
        () => undefined
      )
    );
    return run;
  }

  async function invokeTool(name: string, args: unknown): Promise<ToolRunResult> {
    const tool = allTools.find((t) => t.name === name);
    if (!tool) return { stdout: '', stderr: `unknown tool ${name}`, exitCode: 1 };

    if (tool.cli === '' && tool.commandPath.length === 0) {
      return invokeTemplateTool(tool, args);
    }

    const cli = clis.find((c) => c.name === tool.cli);
    if (!cli) return { stdout: '', stderr: `unknown cli ${tool.cli}`, exitCode: 1 };

    return enqueue(cli.name, () => executeTool(tool, cli, args));
  }

  function invokeTemplateTool(tool: ServeTool, args: unknown): Promise<ToolRunResult> {
    const templateArgs: Record<string, string> = {};
    if (args && typeof args === 'object') {
      for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
        templateArgs[k] = String(v);
      }
    }
    const argv = templateToArgv(tool.description, templateArgs);
    return enqueue('__template__', () =>
      runCommand(platform, argv[0], argv.slice(1), childEnv, undefined, options.callTimeout)
    );
  }

  async function executeTool(
    tool: ServeTool,
    cli: PublishedCli,
    args: unknown
  ): Promise<ToolRunResult> {
    if (tool.kind === 'help') {
      const result = await runCommand(
        platform,
        cli.path,
        ['--help'],
        childEnv,
        undefined,
        options.callTimeout
      );
      if (result.exitCode === 0) return result;
      return runCommand(platform, cli.path, ['help'], childEnv, undefined, options.callTimeout);
    }

    if (tool.kind === 'invoke') {
      const parsed = readToolArguments(args ?? {});
      if (parsed.error) return { stdout: '', stderr: parsed.error, exitCode: 2 };
      if (!parsed.argv) return { stdout: '', stderr: 'argv is required', exitCode: 2 };
      return runCommand(
        platform,
        cli.path,
        parsed.argv,
        childEnv,
        parsed.stdin,
        options.callTimeout
      );
    }

    const parsed = readToolArguments(args ?? {});
    const command = cli.commands.find((c) => c.path.join('_') === tool.commandPath.join('_'));
    if (!command) return { stdout: '', stderr: `unknown command ${tool.name}`, exitCode: 2 };
    const planned = argvForCommand(command, parsed);
    if ('error' in planned) return { stdout: '', stderr: planned.error, exitCode: 2 };
    return runCommand(
      platform,
      cli.path,
      planned.argv,
      childEnv,
      planned.stdin,
      options.callTimeout
    );
  }

  if (options.transport === 'stdio') {
    return runStdioServer(platform, rpcTools, invokeTool, serverName, version);
  }

  return runHttpServer(platform, options, rpcTools, invokeTool, serverName, version);
}

async function runStdioServer(
  platform: Platform,
  tools: RpcTool[],
  call: (name: string, args: unknown) => Promise<ToolRunResult>,
  serverName: string,
  version: string
): Promise<number> {
  const reader = platform.stdin.getReader();
  let buffer = '';
  const dec = new TextDecoder();
  const enc = new TextEncoder();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += dec.decode(value, { stream: true });

      let nlIdx: number;
      while ((nlIdx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nlIdx).trim();
        buffer = buffer.slice(nlIdx + 1);
        if (!line) continue;

        const outcome = await handleJsonRpc(line, tools, call, serverName, version);
        if (outcome.status === 202) continue;
        const writer = platform.stdout.getWriter();
        await writer.write(enc.encode(`${outcome.body}\n`));
        writer.releaseLock();
      }
    }
  } finally {
    reader.releaseLock();
  }

  return 0;
}

async function runHttpServer(
  platform: Platform,
  options: ServeOptions,
  tools: RpcTool[],
  call: (name: string, args: unknown) => Promise<ToolRunResult>,
  serverName: string,
  version: string
): Promise<number> {
  if (!platform.listen) {
    await platform.write(2, 'mcpcat serve: HTTP transport requires platform.listen\n');
    return 3;
  }

  const boundLoopback =
    options.host === '127.0.0.1' || options.host === 'localhost' || options.host === '::1';
  if (!boundLoopback && !options.bearer) {
    await platform.write(2, 'mcpcat serve: --bearer is required when binding off loopback\n');
    return 2;
  }

  const allowedOrigins = new Set(options.allowOrigins);
  const listener = await platform.listen({ host: options.host, port: options.port });
  const actualPort = listener.port;

  await platform.write(2, `mcpcat serve: listening on http://${options.host}:${actualPort}/mcp\n`);

  let shutdownRequested = false;

  const shutdown = () => {
    if (shutdownRequested) return;
    shutdownRequested = true;
    listener.close();
  };

  if (typeof process !== 'undefined') {
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  }

  const handler = (request: HttpRequest): Promise<HttpResponse> =>
    handleMcpRequest(
      request,
      options,
      tools,
      call,
      serverName,
      version,
      allowedOrigins,
      boundLoopback
    );

  try {
    for await (const connection of listener) {
      if (shutdownRequested) break;
      const conn = connection as {
        readonly readable: ReadableStream<Uint8Array>;
        readonly writable: WritableStream<Uint8Array>;
        close(): void;
      };
      handleConnection(conn.readable, conn.writable, handler)
        .catch(() => {})
        .finally(() => {
          try {
            conn.close();
          } catch {}
        });
    }
  } catch {
    if (!shutdownRequested) throw new Error('listener closed unexpectedly');
  }

  return 0;
}

async function handleMcpRequest(
  request: HttpRequest,
  options: ServeOptions,
  tools: RpcTool[],
  call: (name: string, args: unknown) => Promise<ToolRunResult>,
  serverName: string,
  version: string,
  allowedOrigins: Set<string>,
  boundLoopback: boolean
): Promise<HttpResponse> {
  if (options.bearer) {
    const authHeader = request.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${options.bearer}`) {
      return {
        status: 401,
        reason: 'Unauthorized',
        headers: { 'content-type': 'text/plain' },
        body: 'Unauthorized',
      };
    }
  }

  const originCheck = checkOrigin(request.headers.origin, allowedOrigins, boundLoopback);
  if (!originCheck.ok) {
    return {
      status: 403,
      reason: 'Forbidden',
      headers: { 'content-type': 'text/plain' },
      body: originCheck.reason ?? 'Forbidden',
    };
  }

  const hostCheck = checkHost(request.headers.host, boundLoopback);
  if (!hostCheck.ok) {
    return {
      status: 403,
      reason: 'Forbidden',
      headers: { 'content-type': 'text/plain' },
      body: hostCheck.reason ?? 'Forbidden',
    };
  }

  if (request.target !== '/mcp') {
    return {
      status: 404,
      reason: 'Not Found',
      headers: { 'content-type': 'text/plain' },
      body: 'Not Found',
    };
  }

  if (request.method !== 'POST') {
    return {
      status: 405,
      reason: 'Method Not Allowed',
      headers: { 'content-type': 'text/plain', allow: 'POST' },
      body: 'Method Not Allowed',
    };
  }

  const outcome = await handleJsonRpc(request.body, tools, call, serverName, version);
  return {
    status: outcome.status,
    reason: outcome.status === 200 ? 'OK' : 'Accepted',
    headers: { 'content-type': outcome.contentType },
    body: outcome.body,
  };
}
