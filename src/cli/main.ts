import type { Tool } from '@earendil-works/pi-mcp';
import { coerceArgsBySchema, mergeArgs } from '../args/coerce.ts';
import { AuthStepUpError, createMcpAuthProvider } from '../auth/auth-provider.ts';
import { JerkSignInRequiredError } from '../auth/jerk-token-source.ts';
import { connect } from '../client/connect.ts';
import type { McpConnection } from '../client/connection.ts';
import { handleElicitation, parseInputRequest } from '../client/elicit.ts';
import {
  InputRequiredError,
  McpAuthError,
  McpTimeoutError,
} from '../client/stateless-connection.ts';
import { resolveTarget } from '../client/targets.ts';
import { runDescribeTs, runGrep } from '../codemode/describe.ts';
import { runCode } from '../codemode/run.ts';
import { expandPlaceholders } from '../config/expand.ts';
import { MergedConfigSource } from '../config/index.ts';
import type { McpOAuthConfig, McpServerConfig } from '../config/types.ts';
import { runAddCandidate, runDiscover, runFromDiscovery, runInbox } from '../discovery/verbs.ts';
import type { Platform } from '../platform/types.ts';
import {
  renderCallResult,
  renderErrorJson,
  renderInfoJson,
  renderPromptResultJson,
  renderPromptsJson,
  renderReadResourceJson,
  renderResourcesJson,
  renderToolsJson,
} from '../render/result.ts';
import { parseServeFlags, runServe } from '../serve/runtime.ts';
import { createTokenSource, runLogin, runLogout } from './auth-verbs.ts';
import {
  runAdd,
  runBridge,
  runEnable,
  runExposure,
  runImport,
  runList,
  runRm,
} from './config-verbs.ts';
import {
  EXIT_AUTH,
  EXIT_CONNECTION,
  EXIT_INPUT_REQUIRED,
  EXIT_INTERRUPTED,
  EXIT_OK,
  EXIT_RPC_ERROR,
  EXIT_TIMEOUT,
  EXIT_TOOL_ERROR,
  EXIT_USAGE,
  McpcatError,
} from './exit-codes.ts';
import { createVerboseLogger } from './verbose.ts';

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

const UNIMPLEMENTED_VERBS = new Set(['complete', 'task']);

const CLIENT_VERBS = new Set([
  'info',
  'tools',
  'call',
  'describe',
  'serve',
  'resources',
  'read',
  'prompts',
  'prompt',
]);

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
  login <target>             OAuth sign-in
  logout <target>            Remove stored tokens

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
  --memory <MiB>             Code mode memory limit (default 256, max 1024)
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
  memoryLimitMiB: number | undefined;
  verbose: boolean;
  silent: boolean;
  trailingCommand: string[] | undefined;
  respondArg: string | undefined;
  roots: string[];
  outputPath: string | undefined;
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
  memoryLimitMiB: number | undefined;
  verbose: boolean;
  silent: boolean;
  positional: string[];
  trailingCommand: string[] | undefined;
  respondArg: string | undefined;
  roots: string[];
  outputPath: string | undefined;
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
  let memoryLimitMiB: number | undefined;
  let verbose = false;
  let silent = false;
  const positional: string[] = [];
  let trailingCommand: string[] | undefined;
  let respondArg: string | undefined;
  const roots: string[] = [];
  let outputPath: string | undefined;

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
    } else if (arg === '-v' || arg === '--verbose') {
      verbose = true;
    } else if (arg === '--silent') {
      silent = true;
    } else if ((arg === '-m' || arg === '--timeout') && args[i + 1]) {
      timeoutMs = Number(args[++i]) * 1000;
    } else if (arg === '--respond' && args[i + 1]) {
      respondArg = args[++i];
    } else if (arg === '--root' && args[i + 1]) {
      roots.push(args[++i]);
    } else if ((arg === '-o' || arg === '--output') && args[i + 1]) {
      outputPath = args[++i];
    } else if (arg === '--memory' && args[i + 1]) {
      memoryLimitMiB = Number(args[++i]);
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
    memoryLimitMiB,
    verbose,
    silent,
    positional,
    trailingCommand,
    respondArg,
    roots,
    outputPath,
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
    memoryLimitMiB: flags.memoryLimitMiB,
    verbose: flags.verbose,
    silent: flags.silent,
    respondArg: flags.respondArg,
    roots: flags.roots,
    outputPath: flags.outputPath,
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

async function runInfo(platform: Platform, conn: McpConnection, json: boolean): Promise<number> {
  const info = await conn.info();
  if (json) {
    await renderInfoJson(platform, info as unknown as Record<string, unknown>);
    return EXIT_OK;
  }
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
  return EXIT_OK;
}

async function runTools(platform: Platform, conn: McpConnection, json: boolean): Promise<number> {
  const tools = await conn.listTools();
  if (json) {
    await renderToolsJson(platform, tools);
    return EXIT_OK;
  }
  await platform.write(
    1,
    tools.length === 0 ? '(no tools)\n' : `${tools.map(formatToolLine).join('\n')}\n`
  );
  return EXIT_OK;
}

interface RunCallOptions {
  json?: boolean;
  noValidate?: boolean;
  onProgress?: (progress: number, total?: number, message?: string) => void;
  inputResponses?: Record<string, unknown>;
}

async function runCall(
  platform: Platform,
  conn: McpConnection,
  toolName: string,
  dataArg: string | undefined,
  toolArgs: string[],
  opts: RunCallOptions
): Promise<number> {
  let base: Record<string, unknown> = {};
  if (dataArg) {
    try {
      base = await readDataArg(platform, dataArg);
    } catch (err) {
      await writeErr(
        platform,
        opts.json ?? false,
        'usage',
        `invalid -d argument: ${(err as Error).message}`
      );
      return EXIT_USAGE;
    }
  }
  let fin: Record<string, unknown> = base;
  if (toolArgs.length > 0) {
    const tools = await conn.listTools();
    const tool = tools.find((t) => t.name === toolName);
    const schema = tool?.inputSchema ?? { type: 'object', properties: {} };
    const c = coerceArgsBySchema(toolArgs, schema, { noValidate: opts.noValidate });
    if (!c.ok) {
      await writeErr(platform, opts.json ?? false, 'usage', c.error);
      return EXIT_USAGE;
    }
    fin = mergeArgs(base, c.value);
  }
  return renderCallResult(
    platform,
    await conn.callTool(toolName, fin, {
      onProgress: opts.onProgress,
      inputResponses: opts.inputResponses,
    }),
    { json: opts.json }
  );
}

async function runDescribe(
  platform: Platform,
  conn: McpConnection,
  toolName: string | undefined,
  showSchema: boolean,
  json: boolean
): Promise<number> {
  const tools = await conn.listTools();
  if (toolName) {
    const tool = tools.find((t) => t.name === toolName);
    if (!tool) {
      await writeErr(platform, json, 'usage', `tool '${toolName}' not found`);
      return EXIT_USAGE;
    }
    if (json) {
      await platform.write(1, `${JSON.stringify(tool, null, 2)}\n`);
      return EXIT_OK;
    }
    if (showSchema && tool.inputSchema) {
      await platform.write(1, `${JSON.stringify(tool.inputSchema, null, 2)}\n`);
    } else {
      await platform.write(1, `${formatToolSchema(tool)}\n`);
    }
  } else {
    if (json) {
      await platform.write(1, `${JSON.stringify({ tools }, null, 2)}\n`);
      return EXIT_OK;
    }
    for (const tool of tools) {
      await platform.write(1, `${formatToolSchema(tool)}\n\n`);
    }
  }
  return EXIT_OK;
}

async function runResources(
  platform: Platform,
  conn: McpConnection,
  json: boolean
): Promise<number> {
  const resources = await conn.listResources();
  const templates = await conn.listResourceTemplates();
  if (json) {
    await renderResourcesJson(platform, resources, templates);
    return EXIT_OK;
  }
  if (resources.length === 0 && templates.length === 0) {
    await platform.write(1, '(no resources)\n');
    return EXIT_OK;
  }
  for (const r of resources) {
    const desc = r.description ? `  ${r.description}` : '';
    const mime = r.mimeType ? ` [${r.mimeType}]` : '';
    await platform.write(1, `${r.uri}  ${r.name}${mime}${desc}\n`);
  }
  if (templates.length > 0) {
    if (resources.length > 0) await platform.write(1, '\n');
    await platform.write(1, 'Templates:\n');
    for (const t of templates) {
      const desc = t.description ? `  ${t.description}` : '';
      await platform.write(1, `  ${t.uriTemplate}  ${t.name}${desc}\n`);
    }
  }
  return EXIT_OK;
}

async function runRead(
  platform: Platform,
  conn: McpConnection,
  uri: string,
  json: boolean,
  outputPath: string | undefined
): Promise<number> {
  const result = await conn.readResource(uri);
  if (json) {
    await renderReadResourceJson(platform, result);
    return EXIT_OK;
  }
  for (const content of result.contents) {
    if ('text' in content) {
      if (outputPath) {
        await platform.fs.writeFile(outputPath, content.text);
        await platform.write(1, `${outputPath}\n`);
      } else {
        await platform.write(1, `${content.text}\n`);
      }
    } else if ('blob' in content) {
      if (outputPath) {
        const bytes = Uint8Array.from(atob(content.blob), (c) => c.charCodeAt(0));
        await platform.fs.writeFile(outputPath, bytes);
        await platform.write(1, `${outputPath}\n`);
      } else {
        await platform.write(1, `${content.blob}\n`);
      }
    }
  }
  return EXIT_OK;
}

async function runPrompts(platform: Platform, conn: McpConnection, json: boolean): Promise<number> {
  const prompts = await conn.listPrompts();
  if (json) {
    await renderPromptsJson(platform, prompts);
    return EXIT_OK;
  }
  if (prompts.length === 0) {
    await platform.write(1, '(no prompts)\n');
    return EXIT_OK;
  }
  for (const p of prompts) {
    const desc = p.description ? `  ${p.description}` : '';
    await platform.write(1, `${p.name}${desc}\n`);
  }
  return EXIT_OK;
}

async function runPrompt(
  platform: Platform,
  conn: McpConnection,
  name: string,
  dataArg: string | undefined,
  toolArgs: string[],
  json: boolean
): Promise<number> {
  let args: Record<string, unknown> = {};
  if (dataArg) {
    args = await readDataArg(platform, dataArg);
  }
  if (toolArgs.length > 0) {
    const prompts = await conn.listPrompts();
    const prompt = prompts.find((p) => p.name === name);
    const schema: Record<string, unknown> = {
      type: 'object',
      properties: {} as Record<string, unknown>,
      required: [] as string[],
    };
    if (prompt?.arguments) {
      const props: Record<string, unknown> = {};
      const req: string[] = [];
      for (const a of prompt.arguments) {
        props[a.name] = { type: 'string', description: a.description };
        if (a.required) req.push(a.name);
      }
      schema.properties = props;
      schema.required = req;
    }
    const c = coerceArgsBySchema(toolArgs, schema);
    if (!c.ok) {
      await writeErr(platform, json, 'usage', c.error);
      return EXIT_USAGE;
    }
    args = mergeArgs(args, c.value);
  }
  const result = await conn.getPrompt(name, args);
  if (json) {
    await renderPromptResultJson(platform, result);
    return EXIT_OK;
  }
  if (result.description) {
    await platform.write(1, `${result.description}\n\n`);
  }
  for (const msg of result.messages) {
    const text =
      msg.content?.text ?? (msg.content?.data ? `[${msg.content.mimeType ?? 'binary'}]` : '');
    await platform.write(1, `[${msg.role}] ${text}\n`);
  }
  return EXIT_OK;
}

async function runVerb(
  platform: Platform,
  parsed: ParsedArgs,
  conn: McpConnection,
  onProgress?: (progress: number, total?: number, message?: string) => void,
  respondData?: Record<string, unknown>
): Promise<number> {
  switch (parsed.verb) {
    case 'info':
      return runInfo(platform, conn, parsed.jsonOutput);
    case 'tools':
      return runTools(platform, conn, parsed.jsonOutput);
    case 'call':
      return runCall(platform, conn, parsed.toolName!, parsed.dataArg, [], {
        json: parsed.jsonOutput,
        onProgress,
        inputResponses: respondData,
      });
    case 'describe':
      return runDescribe(platform, conn, parsed.toolName, parsed.showSchema, parsed.jsonOutput);
    case 'resources':
      return runResources(platform, conn, parsed.jsonOutput);
    case 'read':
      return runRead(platform, conn, parsed.toolName!, parsed.jsonOutput, parsed.outputPath);
    case 'prompts':
      return runPrompts(platform, conn, parsed.jsonOutput);
    case 'prompt':
      return runPrompt(platform, conn, parsed.toolName!, parsed.dataArg, [], parsed.jsonOutput);
    default:
      await platform.write(2, `mcpcat: unknown command '${parsed.verb}'\n`);
      return EXIT_USAGE;
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
  let activeCleanup: (() => Promise<void>) | undefined;

  async function killTreeAndExit(exitCode: number): Promise<never> {
    if (activeCleanup) {
      try {
        await Promise.race([activeCleanup(), new Promise((r) => setTimeout(r, 3000))]);
      } catch {}
    }
    platform.exit(exitCode);
  }

  platform.onSignal?.('SIGTERM', () => void killTreeAndExit(143));
  platform.onSignal?.('SIGHUP', () => void killTreeAndExit(129));
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
    activeCleanup = cleanup;
    try {
      return await runCode(targets, source, {
        json: parsed.jsonOutput,
        timeoutMs: parsed.timeoutMs,
        memoryLimitMiB: parsed.memoryLimitMiB,
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
    activeCleanup = cleanup;
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
    activeCleanup = cleanup;
    try {
      return await runDescribeTs(platform, targets, parsed.tsBudget);
    } finally {
      await cleanup();
    }
  }

  return 2;
}

export async function run(platform: Platform, version: string, args: string[]): Promise<number> {
  try {
    return await runInner(platform, version, args);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EACCES') {
      await platform.write(2, `mcpcat: ${(err as Error).message}\n`);
      return EXIT_USAGE;
    }
    throw err;
  }
}

async function runInner(platform: Platform, version: string, args: string[]): Promise<number> {
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

  if (parsed.verb === 'login') {
    const source = await createTokenSource(platform);
    return runLogin(platform, args.slice(1), source);
  }

  if (parsed.verb === 'logout') {
    const source = await createTokenSource(platform);
    return runLogout(platform, args.slice(1), source);
  }

  if (UNIMPLEMENTED_VERBS.has(parsed.verb)) {
    await platform.write(2, `mcpcat: '${parsed.verb}' is not implemented yet\n`);
    return EXIT_TOOL_ERROR;
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

  if (parsed.verb === 'read' && !parsed.toolName) {
    await platform.write(2, 'mcpcat: read requires a URI\n');
    return 2;
  }

  if (parsed.verb === 'prompt' && !parsed.toolName) {
    await platform.write(2, 'mcpcat: prompt requires a name\n');
    return 2;
  }

  if (!parsed.target) {
    await platform.write(2, `mcpcat: ${parsed.verb} requires a target\n`);
    return 2;
  }

  return runClientVerb(platform, version, parsed);
}

function expandAndCollect(
  headers: Record<string, string>,
  env: Record<string, string | undefined>
): { expanded: Record<string, string>; secrets: string[] } {
  const secrets: string[] = [];
  const result: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const e = expandPlaceholders(v, env);
    result[k] = e;
    if (e !== v) secrets.push(e);
    if (v.length > 0) secrets.push(v);
  }
  return { expanded: result, secrets };
}

function classifyError(err: unknown): { code: number; kind: string; msg: string } {
  if (err instanceof InputRequiredError) {
    return { code: EXIT_INPUT_REQUIRED, kind: 'input_required', msg: err.requestJson };
  }
  if (err instanceof McpTimeoutError) {
    return { code: EXIT_TIMEOUT, kind: 'timeout', msg: err.message };
  }
  if (err instanceof McpAuthError) {
    return { code: EXIT_AUTH, kind: 'auth', msg: err.message };
  }
  if (err instanceof JerkSignInRequiredError) {
    return { code: EXIT_AUTH, kind: 'auth', msg: err.message };
  }
  if (err instanceof AuthStepUpError) {
    const scopeHint = err.scope ? ` --scope ${err.scope}` : '';
    return {
      code: EXIT_AUTH,
      kind: 'auth',
      msg: `insufficient scope. Run: mcpcat login ${err.target ?? '<target>'}${scopeHint}`,
    };
  }
  if (
    (err as Error).name === 'McpOAuthAuthorizationRequiredError' ||
    (err as Error).name === 'McpAuthRequiredError'
  ) {
    return { code: EXIT_AUTH, kind: 'auth', msg: (err as Error).message };
  }
  if (err instanceof McpcatError) {
    return { code: err.exitCode, kind: 'error', msg: err.message };
  }
  const msg = (err as Error).message ?? String(err);
  const name = (err as Error).name ?? '';
  if (
    name === 'McpTimeoutError' ||
    msg.includes('timed out') ||
    msg.includes('timeout') ||
    msg.includes('Timeout')
  ) {
    return { code: EXIT_TIMEOUT, kind: 'timeout', msg };
  }
  return { code: EXIT_RPC_ERROR, kind: 'rpc_error', msg };
}

async function resolveAuthProvider(
  platform: Platform,
  hasAuthHeader: boolean,
  url: string | undefined,
  target: string,
  config: MergedConfigSource
): Promise<ReturnType<typeof createMcpAuthProvider> | undefined> {
  if (hasAuthHeader || !url) return undefined;
  const source = await createTokenSource(platform);
  const entry = config.entry(target);
  const oauth =
    entry && 'url' in entry.config ? (entry.config as { oauth?: McpOAuthConfig }).oauth : undefined;
  const name = entry ? target : `url:${new URL(url).origin}${new URL(url).pathname}`;
  return createMcpAuthProvider({ name, serverUrl: url, source, oauth, platform });
}

function classifyConnectionError(
  err: unknown,
  target: string,
  interrupted: boolean
): { code: number; kind: string; msg: string } {
  if (
    err instanceof McpAuthError ||
    err instanceof AuthStepUpError ||
    err instanceof JerkSignInRequiredError
  ) {
    return classifyError(err);
  }
  if (
    (err as Error).name === 'McpOAuthAuthorizationRequiredError' ||
    (err as Error).name === 'McpAuthRequiredError'
  ) {
    return { code: EXIT_AUTH, kind: 'auth', msg: `unauthorized. Run: mcpcat login ${target}` };
  }
  if (interrupted) {
    return { code: EXIT_INTERRUPTED, kind: 'interrupted', msg: 'interrupted' };
  }
  const msg = transportHint(err) ?? `connection failed: ${(err as Error).message}`;
  return { code: EXIT_CONNECTION, kind: 'connection', msg };
}

function buildRoots(
  rootArgs: string[],
  isStdio: boolean,
  cwd: string
): { uri: string; name?: string }[] | undefined {
  const roots = rootArgs.map((r) => ({
    uri: r.startsWith('file://') ? r : `file://${r}`,
  }));
  if (roots.length === 0 && isStdio) {
    roots.push({ uri: `file://${cwd}` });
  }
  return roots.length > 0 ? roots : undefined;
}

async function loadRespondData(
  platform: Platform,
  respondArg: string | undefined,
  json: boolean
): Promise<{ data: Record<string, unknown> | undefined } | { exitCode: number }> {
  if (!respondArg) return { data: undefined };
  try {
    return { data: await readDataArg(platform, respondArg) };
  } catch (err) {
    await writeErr(
      platform,
      json,
      'usage',
      `invalid --respond argument: ${(err as Error).message}`
    );
    return { exitCode: EXIT_USAGE };
  }
}

async function handleInputRequired(
  platform: Platform,
  conn: McpConnection,
  err: InputRequiredError,
  respondData: Record<string, unknown> | undefined,
  json: boolean
): Promise<number> {
  const parsed2 = JSON.parse(err.requestJson) as Record<string, unknown>;
  const inputReq = parseInputRequest((parsed2.result as Record<string, unknown>) ?? parsed2);
  if (!inputReq) {
    await platform.write(2, `${err.requestJson}\n`);
    return EXIT_INPUT_REQUIRED;
  }
  const isTty = platform.isatty(0);
  const elicitResult = await handleElicitation(platform, inputReq, isTty, respondData);
  if ('exitCode' in elicitResult) {
    await platform.write(2, `${err.requestJson}\n`);
    return EXIT_INPUT_REQUIRED;
  }
  try {
    const retryResult = await conn.callTool(parsed2.name as string, {
      ...(parsed2.arguments as Record<string, unknown>),
      _meta: { inputResponses: elicitResult.answers },
    });
    return renderCallResult(platform, retryResult, { json });
  } catch (retryErr) {
    const e2 = classifyError(retryErr);
    await writeErr(platform, json, e2.kind, e2.msg);
    return e2.code;
  }
}

async function runClientVerb(
  platform: Platform,
  version: string,
  parsed: ParsedArgs
): Promise<number> {
  const { expanded, secrets } = expandAndCollect(parsed.headers, platform.env);
  const verbose = createVerboseLogger(platform, parsed.verbose);
  for (const s of secrets) verbose.secrets.add(s);

  const timeoutMs = parsed.timeoutMs;
  const sigintController = new AbortController();
  let interrupted = false;
  let termExitCode = EXIT_INTERRUPTED;
  let activeConn: McpConnection | undefined;

  async function killTreeAndExit(exitCode: number): Promise<never> {
    interrupted = true;
    termExitCode = exitCode;
    sigintController.abort();
    if (activeConn) {
      try {
        await Promise.race([activeConn.close(), new Promise((r) => setTimeout(r, 3000))]);
      } catch {}
    }
    platform.exit(exitCode);
  }

  platform.onSignal?.('SIGINT', () => {
    interrupted = true;
    sigintController.abort();
  });
  platform.onSignal?.('SIGTERM', () => void killTreeAndExit(143));
  platform.onSignal?.('SIGHUP', () => void killTreeAndExit(129));

  const showProgress = !parsed.silent && (parsed.verbose || platform.isatty(2));
  const onProgress = (progress: number, total?: number, message?: string) => {
    if (!showProgress) return;
    const pct = total ? ` ${Math.round((progress / total) * 100)}%` : '';
    const msg = message ? ` ${message}` : '';
    platform.write(2, `* progress:${pct}${msg}\n`).catch(() => {});
  };

  const config = await MergedConfigSource.load(platform);
  const target = parsed.target === '__trailing__' ? '' : parsed.target!;
  let resolved;
  try {
    resolved = await resolveTarget(target, parsed.trailingCommand, config);
  } catch (err) {
    await writeErr(platform, parsed.jsonOutput, 'usage', (err as Error).message);
    return EXIT_USAGE;
  }

  const hasAuthHeader = 'Authorization' in expanded;
  const authProvider = await resolveAuthProvider(
    platform,
    hasAuthHeader,
    resolved.url,
    target,
    config
  );

  const roots = buildRoots(parsed.roots, !!resolved.command, platform.cwd);

  let respondData: Record<string, unknown> | undefined;
  if (parsed.respondArg) {
    const loaded = await loadRespondData(platform, parsed.respondArg, parsed.jsonOutput);
    if ('exitCode' in loaded) return loaded.exitCode;
    respondData = loaded.data;
  }

  let conn: McpConnection;
  try {
    conn = await connect(platform, {
      ...resolved,
      headers: { ...resolved.headers, ...expanded },
      protocolVersion: parsed.protocolVersion,
      version,
      timeoutMs,
      signal: sigintController.signal,
      verbose,
      authProvider,
      roots,
    });
    activeConn = conn;
  } catch (err) {
    const e = classifyConnectionError(err, target, interrupted);
    if (e.code === EXIT_INTERRUPTED) {
      await platform.write(2, 'mcpcat: interrupted\n');
      return termExitCode;
    }
    await writeErr(platform, parsed.jsonOutput, e.kind, e.msg);
    return e.code;
  }

  try {
    const code = await runVerb(platform, parsed, conn, onProgress, respondData);
    if (interrupted) {
      await platform.write(2, 'mcpcat: interrupted\n');
      return termExitCode;
    }
    return code;
  } catch (err) {
    if (interrupted) {
      await platform.write(2, 'mcpcat: interrupted\n');
      return termExitCode;
    }
    if (err instanceof InputRequiredError) {
      return handleInputRequired(platform, conn, err, respondData, parsed.jsonOutput);
    }
    const e = classifyError(err);
    await writeErr(platform, parsed.jsonOutput, e.kind, e.msg);
    return e.code;
  } finally {
    try {
      await conn.close();
    } catch {}
  }
}

async function writeErr(p: Platform, json: boolean, kind: string, msg: string): Promise<void> {
  if (json) await renderErrorJson(p, kind, msg);
  else await p.write(2, `mcpcat: ${msg}\n`);
}
