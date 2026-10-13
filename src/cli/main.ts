import type { CallToolResult, Tool } from '@earendil-works/pi-mcp';
import { connect } from '../client/connect.ts';
import type { McpConnection } from '../client/connection.ts';
import { InputRequiredError } from '../client/stateless-connection.ts';
import { resolveTarget } from '../client/targets.ts';
import { runDescribeTs, runGrep } from '../codemode/describe.ts';
import { runCode } from '../codemode/run.ts';
import { MergedConfigSource } from '../config/index.ts';
import type { McpServerConfig } from '../config/types.ts';
import { runAddCandidate, runDiscover, runFromDiscovery, runInbox } from '../discovery/verbs.ts';
import type { Platform } from '../platform/types.ts';
import { parseServeFlags, runServe } from '../serve/runtime.ts';
import {
  runAdd,
  runBridge,
  runEnable,
  runExposure,
  runImport,
  runList,
  runRm,
} from './config-verbs.ts';

const VERBS = [
  'info',
  'tools',
  'ls',
  'call',
  'describe',
  'resources',
  'read',
  'prompts',
  'prompt',
  'grep',
  'complete',
  'task',
  'add',
  'rm',
  'list',
  'enable',
  'disable',
  'exposure',
  'import',
  'login',
  'logout',
  'serve',
  'code',
  'discover',
  'inbox',
  'help',
];

const CONFIG_VERBS: Record<string, boolean> = {
  add: true,
  rm: true,
  list: true,
  enable: true,
  disable: true,
  exposure: true,
  import: true,
};

const UNIMPLEMENTED_VERBS = new Set([
  'resources',
  'read',
  'prompts',
  'prompt',
  'complete',
  'task',
  'login',
  'logout',
]);

const CLIENT_VERBS = new Set(['info', 'tools', 'call', 'describe', 'serve']);

function helpText(version: string): string {
  return `mcpcat ${version} – a curl for the Model Context Protocol

Usage: mcpcat [options] <target> [<tool> [args…]]
       mcpcat [options] <verb> …

Client verbs:
  info <target>              Server identity and capabilities
  tools <target>             List tools
  call <target> <tool>       Call a tool
  describe <target> [tool]   Tool schema and help

Configuration verbs:
  add <name> <url>           Add a server to mcp.json
  add <name> --bridge -- 
    Bridge a stdio server to HTTP (kernel only,
                             runs in foreground, does not survive reload)
  rm <name>                  Remove a server
  list                       List configured servers
  enable|disable <name>      Toggle a server
  exposure <name> <mode>     Set exposure mode
  import <file>              Import from other configs
  login <target>             OAuth sign-in (not implemented yet)
  logout <target>            Remove tokens (not implemented yet)

Server and code verbs:
  serve [--stdio|--http] …   Expose commands or proxy upstream as MCP server
  code [-e src|file.js]      Run a codemode script
  grep <pattern> [target…]   Search tools by name or description
  discover <url>             Find MCP servers at a URL
  inbox [--json]             List discovery candidates
  help [verb]                Show help

Options:
  --json                     JSON output
  -H, --header 'N: V'       Extra header
  -d <json>                  Tool arguments as JSON (or @file, @- for stdin)
  -m, --timeout <s>          Request timeout (default 60)
  --protocol-version <v>     Pin protocol version
  --schema                   Print raw JSON Schema (describe)
  --ts                       TypeScript declarations (describe)
  --budget <n>               Token budget for --ts (default 3000)
  --rank                     BM25 ranking (grep)
  -E                         Extended regex (grep)
  -e <src>                   Inline script source (code)
  -s, --server <name>        Server target (code, repeatable)
  --allow-shell              Enable shell() global (code)
  -v, --verbose              Trace on stderr
  -s, --silent               Suppress progress
  -o, --output <path>        Write result to file
  -V, --version              Print version
  -h, --help                 Show this help
`;
}

interface ParsedArgs {
  verb: string | undefined;
  target: string | undefined;
  toolName: string | undefined;
  dataArg: string | undefined;
  headers: Record<string, string>;
  protocolVersion: string | undefined;
  showSchema: boolean;
  showTs: boolean;
  tsBudget: number | undefined;
  jsonOutput: boolean;
  rank: boolean;
  extendedRegex: boolean;
  inlineSource: string | undefined;
  serverTargets: string[];
  allowShell: boolean;
  timeoutMs: number | undefined;
  trailingCommand: string[] | undefined;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: flag-dispatching loop is inherently branchy
function parseFlags(args: string[]): {
  headers: Record<string, string>;
  dataArg: string | undefined;
  protocolVersion: string | undefined;
  showSchema: boolean;
  showTs: boolean;
  tsBudget: number | undefined;
  jsonOutput: boolean;
  rank: boolean;
  extendedRegex: boolean;
  inlineSource: string | undefined;
  serverTargets: string[];
  allowShell: boolean;
  timeoutMs: number | undefined;
  positional: string[];
  trailingCommand: string[] | undefined;
} {
  const headers: Record<string, string> = {};
  let dataArg: string | undefined;
  let protocolVersion: string | undefined;
  let showSchema = false;
  let showTs = false;
  let tsBudget: number | undefined;
  let jsonOutput = false;
  let rank = false;
  let extendedRegex = false;
  let inlineSource: string | undefined;
  const serverTargets: string[] = [];
  let allowShell = false;
  let timeoutMs: number | undefined;
  const positional: string[] = [];
  let trailingCommand: string[] | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      trailingCommand = args.slice(i + 1);
      break;
    }
    if ((arg === '-H' || arg === '--header') && args[i + 1]) {
      const val = args[++i];
      const colonIdx = val.indexOf(':');
      if (colonIdx > 0) {
        headers[val.slice(0, colonIdx).trim()] = val.slice(colonIdx + 1).trim();
      }
    } else if (arg === '-d' && args[i + 1]) {
      dataArg = args[++i];
    } else if (arg === '--protocol-version' && args[i + 1]) {
      protocolVersion = args[++i];
    } else if (arg === '--schema') {
      showSchema = true;
    } else if (arg === '--ts') {
      showTs = true;
    } else if (arg === '--budget' && args[i + 1]) {
      tsBudget = Number(args[++i]);
    } else if (arg === '--json') {
      jsonOutput = true;
    } else if (arg === '--rank') {
      rank = true;
    } else if (arg === '-E') {
      extendedRegex = true;
    } else if (arg === '-e' && args[i + 1]) {
      inlineSource = args[++i];
    } else if ((arg === '-s' || arg === '--server') && args[i + 1]) {
      serverTargets.push(args[++i]);
    } else if (arg === '--allow-shell') {
      allowShell = true;
    } else if ((arg === '-m' || arg === '--timeout') && args[i + 1]) {
      timeoutMs = Number(args[++i]) * 1000;
    } else if (!arg.startsWith('-')) {
      positional.push(arg);
    }
  }

  return {
    headers,
    dataArg,
    protocolVersion,
    showSchema,
    showTs,
    tsBudget,
    jsonOutput,
    rank,
    extendedRegex,
    inlineSource,
    serverTargets,
    allowShell,
    timeoutMs,
    positional,
    trailingCommand,
  };
}

function resolveVerb(
  positional: string[],
  trailingCommand: string[] | undefined
): {
  verb: string | undefined;
  target: string | undefined;
  toolName: string | undefined;
  trailingCommand: string[] | undefined;
} {
  let verb: string | undefined;
  let target: string | undefined;
  let toolName: string | undefined;

  if (positional.length >= 1 && VERBS.includes(positional[0])) {
    verb = positional[0];
    if (verb === 'ls') verb = 'tools';
    target = positional[1];
    toolName = positional[2];
  } else if (positional.length >= 2) {
    target = positional[0];
    toolName = positional[1];
    verb = 'call';
  } else if (positional.length === 1) {
    target = positional[0];
    verb = 'info';
  }

  if (!target && trailingCommand && trailingCommand.length > 0) {
    target = '__trailing__';
  }

  return {
    verb,
    target,
    toolName,
    trailingCommand,
  };
}

function parseArgs(args: string[]): ParsedArgs {
  const flags = parseFlags(args);
  const resolved = resolveVerb(flags.positional, flags.trailingCommand);
  return {
    ...resolved,
    headers: flags.headers,
    dataArg: flags.dataArg,
    protocolVersion: flags.protocolVersion,
    showSchema: flags.showSchema,
    showTs: flags.showTs,
    tsBudget: flags.tsBudget,
    jsonOutput: flags.jsonOutput,
    rank: flags.rank,
    extendedRegex: flags.extendedRegex,
    inlineSource: flags.inlineSource,
    serverTargets: flags.serverTargets,
    allowShell: flags.allowShell,
    timeoutMs: flags.timeoutMs,
  };
}

function formatToolLine(tool: Tool): string {
  const desc = tool.description ? `  ${tool.description}` : '';
  return `${tool.name}${desc}`;
}

function formatToolSchema(tool: Tool): string {
  const lines: string[] = [];
  lines.push(`${tool.name}`);
  if (tool.description) lines.push(`  ${tool.description}`);
  if (tool.inputSchema) {
    lines.push('  Input schema:');
    lines.push(`    ${JSON.stringify(tool.inputSchema, null, 2).split('\n').join('\n    ')}`);
  }
  const annotations = (tool as unknown as Record<string, unknown>).annotations as
    | Record<string, unknown>
    | undefined;
  if (annotations) {
    lines.push('  Annotations:');
    for (const [k, v] of Object.entries(annotations)) {
      lines.push(`    ${k}: ${JSON.stringify(v)}`);
    }
  }
  return lines.join('\n');
}

function renderCallResult(result: CallToolResult): string {
  const parts: string[] = [];
  if (result.content) {
    for (const block of result.content) {
      if (block.type === 'text') parts.push(block.text);
      else if (block.type === 'image')
        parts.push(`[image: ${block.mimeType}, ${Math.ceil((block.data.length * 3) / 4)} bytes]`);
      else if (block.type === 'resource_link') parts.push(`[resource: ${block.uri}]`);
      else if (block.type === 'resource') {
        parts.push(
          'text' in block.resource ? block.resource.text : `[blob: ${block.resource.uri}]`
        );
      }
    }
  }
  if (parts.length === 0 && result.structuredContent !== undefined) {
    parts.push(JSON.stringify(result.structuredContent, null, 2));
  }
  return parts.join('\n');
}

const NETWORK_HINT =
  'connection failed (use slicc-node, slicc-swift, or the browser extension for servers without CORS)';

function transportHint(err: unknown): string | undefined {
  if (err instanceof TypeError) {
    const cause = (err as { cause?: { code?: string } }).cause;
    if (cause?.code === 'ECONNREFUSED' || cause?.code === 'ENETUNREACH') {
      return `connection failed: ${err.message}`;
    }
  }
  if (err instanceof Error && 'status' in err && (err as { status?: number }).status === 502) {
    const msg = err.message;
    if (msg) return `${NETWORK_HINT}: ${msg}`;
    return NETWORK_HINT;
  }
  return undefined;
}

async function readDataArg(platform: Platform, dataArg: string): Promise<Record<string, unknown>> {
  let raw: string;
  if (dataArg.startsWith('@-')) {
    const reader = platform.stdin.getReader();
    const chunks: Uint8Array[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
    reader.releaseLock();
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const c of chunks) {
      merged.set(c, offset);
      offset += c.length;
    }
    raw = new TextDecoder().decode(merged);
  } else if (dataArg.startsWith('@')) {
    const data = await platform.fs.readFile(dataArg.slice(1));
    raw = new TextDecoder().decode(data);
  } else {
    raw = dataArg;
  }
  return JSON.parse(raw) as Record<string, unknown>;
}

async function runInfo(platform: Platform, conn: McpConnection): Promise<number> {
  const info = await conn.info();
  const lines: string[] = [];
  if (info.name) lines.push(`Server: ${info.name}${info.version ? ` ${info.version}` : ''}`);
  if (info.title) lines.push(`Title: ${info.title}`);
  lines.push(`Protocol: ${info.protocolVersion}`);
  if (info.instructions) lines.push(`Instructions: ${info.instructions}`);
  const caps = Object.keys(info.capabilities).filter(
    (k) => info.capabilities[k] != null && info.capabilities[k] !== false
  );
  if (caps.length > 0) lines.push(`Capabilities: ${caps.join(', ')}`);
  try {
    const tools = await conn.listTools();
    lines.push(`Tools: ${tools.length}`);
  } catch {}
  await platform.write(1, `${lines.join('\n')}\n`);
  return 0;
}

async function runTools(platform: Platform, conn: McpConnection): Promise<number> {
  const tools = await conn.listTools();
  if (tools.length === 0) {
    await platform.write(1, '(no tools)\n');
  } else {
    await platform.write(1, `${tools.map(formatToolLine).join('\n')}\n`);
  }
  return 0;
}

async function runCall(
  platform: Platform,
  conn: McpConnection,
  toolName: string,
  dataArg: string | undefined
): Promise<number> {
  let toolArgs: Record<string, unknown> = {};
  if (dataArg) {
    try {
      toolArgs = await readDataArg(platform, dataArg);
    } catch (err) {
      await platform.write(2, `mcpcat: invalid -d argument: ${(err as Error).message}\n`);
      return 2;
    }
  }
  const result = await conn.callTool(toolName, toolArgs);
  const output = renderCallResult(result);
  if (result.isError) {
    await platform.write(2, `${output}\n`);
    return 1;
  }
  await platform.write(1, `${output}\n`);
  return 0;
}

async function runDescribe(
  platform: Platform,
  conn: McpConnection,
  toolName: string | undefined,
  showSchema: boolean
): Promise<number> {
  const tools = await conn.listTools();
  if (toolName) {
    const tool = tools.find((t) => t.name === toolName);
    if (!tool) {
      await platform.write(2, `mcpcat: tool '${toolName}' not found\n`);
      return 2;
    }
    if (showSchema && tool.inputSchema) {
      await platform.write(1, `${JSON.stringify(tool.inputSchema, null, 2)}\n`);
    } else {
      await platform.write(1, `${formatToolSchema(tool)}\n`);
    }
  } else {
    for (const tool of tools) {
      await platform.write(1, `${formatToolSchema(tool)}\n\n`);
    }
  }
  return 0;
}

async function runVerb(
  platform: Platform,
  parsed: ParsedArgs,
  conn: McpConnection
): Promise<number> {
  switch (parsed.verb) {
    case 'info':
      return runInfo(platform, conn);
    case 'tools':
      return runTools(platform, conn);
    case 'call':
      return runCall(platform, conn, parsed.toolName!, parsed.dataArg);
    case 'describe':
      return runDescribe(platform, conn, parsed.toolName, parsed.showSchema);
    default:
      await platform.write(2, `mcpcat: unknown command '${parsed.verb}'\n`);
      return 2;
  }
}

async function probeServer(
  _name: string,
  config: McpServerConfig,
  platform: Platform
): Promise<string | undefined> {
  try {
    const opts: Record<string, unknown> = { version: 'probe' };
    if ('url' in config && config.url) {
      opts.url = config.url;
      if ('headers' in config) opts.headers = config.headers;
    } else if ('command' in config && config.command) {
      opts.command = config.command;
      if ('args' in config) opts.args = config.args;
      if ('env' in config) opts.env = config.env;
      if ('cwd' in config) opts.cwd = config.cwd;
    } else {
      return undefined;
    }
    const conn = await connect(platform, opts as Parameters<typeof connect>[1]);
    try {
      await conn.info();
    } finally {
      try {
        await conn.close();
      } catch {}
    }
    return undefined;
  } catch (err) {
    return (err as Error).message;
  }
}

async function dispatchConfigVerb(
  platform: Platform,
  verb: string,
  args: string[],
  version: string
): Promise<number> {
  const rest = args.slice(1);
  switch (verb) {
    case 'add':
      if (rest.includes('--bridge')) return runBridge(platform, rest, version);
      return runAdd(platform, rest, probeServer);
    case 'rm':
      return runRm(platform, rest);
    case 'list':
      return runList(platform, rest);
    case 'enable':
      return runEnable(platform, rest, true);
    case 'disable':
      return runEnable(platform, rest, false);
    case 'exposure':
      return runExposure(platform, rest);
    case 'import':
      return runImport(platform, rest);
    default:
      return 1;
  }
}

async function dispatchDiscoveryVerb(
  platform: Platform,
  parsed: ParsedArgs,
  args: string[]
): Promise<number | undefined> {
  if (parsed.verb === 'add' && args.includes('--from-discovery')) {
    return runFromDiscovery(platform, args.slice(1));
  }
  if (parsed.verb === 'add' && args.includes('--candidate')) {
    const rest = args.slice(1);
    const nameIdx = rest.findIndex((a) => !a.startsWith('-') && a !== '--candidate');
    const candidateIdx = rest.indexOf('--candidate');
    if (nameIdx < 0 || candidateIdx < 0 || candidateIdx + 1 >= rest.length) {
      await platform.write(2, 'mcpcat add --candidate: requires <name> --candidate <id>\n');
      return 2;
    }
    const name = rest[nameIdx];
    const candidateId = rest[candidateIdx + 1];
    const configIdx = rest.indexOf('--config');
    const configFile =
      configIdx >= 0 && configIdx + 1 < rest.length ? rest[configIdx + 1] : undefined;
    return runAddCandidate(platform, name, candidateId, configFile);
  }
  if (parsed.verb === 'discover') return runDiscover(platform, args.slice(1));
  if (parsed.verb === 'inbox') return runInbox(platform, args.slice(1));
  return undefined;
}

async function dispatchServeVerb(
  platform: Platform,
  args: string[],
  version: string
): Promise<number> {
  const serveArgs = args.slice(args.indexOf('serve') + 1);
  const serveOptions = parseServeFlags(serveArgs);
  if (
    !serveOptions.proxy &&
    serveOptions.commands.length === 0 &&
    serveOptions.toolTemplates.length === 0
  ) {
    await platform.write(2, 'mcpcat serve: no commands or --tool templates given\n');
    return 2;
  }
  return runServe(platform, serveOptions, version);
}

async function connectTargets(
  platform: Platform,
  names: string[],
  config: Awaited<ReturnType<typeof MergedConfigSource.load>>,
  parsed: ParsedArgs,
  version: string
): Promise<{
  targets: { name: string; conn: McpConnection; instructions?: string }[];
  cleanup: () => Promise<void>;
}> {
  const conns: McpConnection[] = [];
  const targets: { name: string; conn: McpConnection; instructions?: string }[] = [];
  for (const name of names) {
    let resolved;
    try {
      resolved = await resolveTarget(name, undefined, config);
    } catch (err) {
      await platform.write(2, `mcpcat: ${(err as Error).message}\n`);
      continue;
    }
    try {
      const conn = await connect(platform, {
        ...resolved,
        headers: { ...resolved.headers, ...parsed.headers },
        protocolVersion: parsed.protocolVersion,
        version,
      });
      conns.push(conn);
      const info = await conn.info();
      targets.push({ name, conn, instructions: info.instructions });
    } catch (err) {
      await platform.write(2, `mcpcat: connection to ${name} failed: ${(err as Error).message}\n`);
    }
  }
  return {
    targets,
    cleanup: async () => {
      for (const conn of conns) {
        try {
          await conn.close();
        } catch {}
      }
    },
  };
}

async function resolveTargetNames(platform: Platform, parsed: ParsedArgs): Promise<string[]> {
  if (parsed.serverTargets.length > 0) return parsed.serverTargets;

  const targets: string[] = [];
  if (parsed.target) targets.push(parsed.target);
  const positionalExtra = parsed.toolName;
  if (positionalExtra && parsed.verb !== 'call') targets.push(positionalExtra);
  if (targets.length > 0) return targets;

  const config = await MergedConfigSource.load(platform);
  return config
    .list()
    .filter((e) => e.config.enabled !== false)
    .map((e) => e.name);
}

async function dispatchMultiTarget(
  platform: Platform,
  parsed: ParsedArgs,
  version: string
): Promise<number> {
  const config = await MergedConfigSource.load(platform);

  if (parsed.verb === 'code') {
    let source: string;
    if (parsed.inlineSource) {
      source = parsed.inlineSource;
    } else if (parsed.target) {
      try {
        const data = await platform.fs.readFile(parsed.target);
        source = new TextDecoder().decode(data);
      } catch {
        await platform.write(2, `mcpcat: cannot read file: ${parsed.target}\n`);
        return 2;
      }
    } else {
      await platform.write(2, 'mcpcat: code requires -e <source> or a file\n');
      return 2;
    }

    let serverNames: string[];
    if (parsed.serverTargets.length > 0) {
      serverNames = parsed.serverTargets;
    } else {
      serverNames = config
        .list()
        .filter((e) => e.config.enabled !== false)
        .map((e) => e.name);
    }

    const { targets, cleanup } = await connectTargets(
      platform,
      serverNames,
      config,
      parsed,
      version
    );
    try {
      return await runCode(targets, source, {
        json: parsed.jsonOutput,
        timeoutMs: parsed.timeoutMs,
        allowShell: parsed.allowShell,
        platform,
      });
    } catch (err) {
      await platform.write(2, `mcpcat: ${(err as Error).message}\n`);
      return 5;
    } finally {
      await cleanup();
    }
  }

  if (parsed.verb === 'grep') {
    const pattern = parsed.target;
    if (!pattern) {
      await platform.write(2, 'mcpcat: grep requires a pattern\n');
      return 2;
    }

    const serverNames = parsed.toolName
      ? [parsed.toolName]
      : config
          .list()
          .filter((e) => e.config.enabled !== false)
          .map((e) => e.name);
    const { targets, cleanup } = await connectTargets(
      platform,
      serverNames,
      config,
      parsed,
      version
    );
    try {
      return await runGrep(platform, pattern, targets, {
        rank: parsed.rank,
        extended: parsed.extendedRegex,
      });
    } finally {
      await cleanup();
    }
  }

  if (parsed.verb === 'describe' && parsed.showTs) {
    const serverNames = await resolveTargetNames(platform, parsed);
    const { targets, cleanup } = await connectTargets(
      platform,
      serverNames,
      config,
      parsed,
      version
    );
    try {
      return await runDescribeTs(platform, targets, parsed.tsBudget);
    } finally {
      await cleanup();
    }
  }

  return 2;
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: top-level dispatch over many verb kinds
export async function run(platform: Platform, version: string, args: string[]): Promise<number> {
  if (args.includes('--version') || args.includes('-V')) {
    await platform.write(1, `${version}\n`);
    return 0;
  }

  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    await platform.write(1, helpText(version));
    return 0;
  }

  if (args.length === 0) {
    await platform.write(1, helpText(version));
    return 0;
  }

  const parsed = parseArgs(args);

  if (!parsed.verb) {
    await platform.write(2, 'mcpcat: no verb or target given\n');
    return 2;
  }

  if (parsed.verb in CONFIG_VERBS) {
    const disc = await dispatchDiscoveryVerb(platform, parsed, args);
    if (disc !== undefined) return disc;
    return dispatchConfigVerb(platform, parsed.verb, args, version);
  }

  const discResult = await dispatchDiscoveryVerb(platform, parsed, args);
  if (discResult !== undefined) return discResult;

  if (UNIMPLEMENTED_VERBS.has(parsed.verb)) {
    await platform.write(2, `mcpcat: '${parsed.verb}' is not implemented yet\n`);
    return 1;
  }

  if (parsed.verb === 'serve') {
    return dispatchServeVerb(platform, args, version);
  }

  if (
    parsed.verb === 'code' ||
    parsed.verb === 'grep' ||
    (parsed.verb === 'describe' && parsed.showTs)
  ) {
    return dispatchMultiTarget(platform, parsed, version);
  }
  if (!CLIENT_VERBS.has(parsed.verb)) {
    await platform.write(2, `mcpcat: unknown command '${parsed.verb}'\n`);
    return 2;
  }

  if (parsed.verb === 'call' && !parsed.toolName) {
    await platform.write(2, 'mcpcat: call requires a tool name\n');
    return 2;
  }

  if (!parsed.target) {
    await platform.write(2, `mcpcat: ${parsed.verb} requires a target\n`);
    return 2;
  }

  const config = await MergedConfigSource.load(platform);
  let resolved;
  try {
    resolved = await resolveTarget(
      parsed.target === '__trailing__' ? '' : parsed.target,
      parsed.trailingCommand,
      config
    );
  } catch (err) {
    await platform.write(2, `mcpcat: ${(err as Error).message}\n`);
    return 2;
  }

  let conn: McpConnection;
  try {
    conn = await connect(platform, {
      ...resolved,
      headers: { ...resolved.headers, ...parsed.headers },
      protocolVersion: parsed.protocolVersion,
      version,
    });
  } catch (err) {
    const msg = transportHint(err) ?? `connection failed: ${(err as Error).message}`;
    await platform.write(2, `mcpcat: ${msg}\n`);
    return 3;
  }

  try {
    return await runVerb(platform, parsed, conn);
  } catch (err) {
    if (err instanceof InputRequiredError) {
      await platform.write(2, `${err.requestJson}\n`);
      return 6;
    }
    await platform.write(2, `mcpcat: ${(err as Error).message}\n`);
    return 5;
  } finally {
    try {
      await conn.close();
    } catch {}
  }
}
