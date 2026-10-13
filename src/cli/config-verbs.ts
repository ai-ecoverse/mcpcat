import { addServer, removeServer, setExposure, updateServer } from '../config/edit.ts';
import { importFile } from '../config/import.ts';
import { MergedConfigSource } from '../config/index.ts';
import { validateServer } from '../config/parse.ts';
import { projectConfigPath, userConfigPath } from '../config/paths.ts';
import type {
  LoadedConfig,
  McpHttpServerConfig,
  McpServerConfig,
  McpStdioServerConfig,
} from '../config/types.ts';
import { checkAgentWarnings, literalSecret, urlHasSecret } from '../config/warnings.ts';
import type { Platform } from '../platform/types.ts';

type ProbeFn =
  | ((name: string, config: McpServerConfig, platform: Platform) => Promise<string | undefined>)
  | undefined;

interface AddFlags {
  local: boolean;
  noProbe: boolean;
  description?: string;
  exposure?: string;
  headers: Array<[string, string]>;
  envPairs: Array<[string, string]>;
  cwd?: string;
  configFile?: string;
  positional: string[];
  cmdArgs: string[];
}

function parseHeader(hdr: string): [string, string] | string {
  const colonIdx = hdr.indexOf(':');
  if (colonIdx < 1) return `invalid header '${hdr}'`;
  return [hdr.slice(0, colonIdx).trim(), hdr.slice(colonIdx + 1).trim()];
}

function parseEnvPair(pair: string): [string, string] | string {
  const eqIdx = pair.indexOf('=');
  if (eqIdx < 1) return `invalid --env '${pair}'`;
  return [pair.slice(0, eqIdx), pair.slice(eqIdx + 1)];
}

function parseAddFlagAt(
  flagArgs: string[],
  i: number,
  flags: AddFlags
): { next: number; error?: string } {
  const arg = flagArgs[i];
  if (arg === '-l' || arg === '--local') {
    flags.local = true;
    return { next: i + 1 };
  }
  if (arg === '--no-probe') {
    flags.noProbe = true;
    return { next: i + 1 };
  }
  if (arg === '--config' && i + 1 < flagArgs.length) {
    flags.configFile = flagArgs[i + 1];
    return { next: i + 2 };
  }
  if (arg === '--description' && i + 1 < flagArgs.length) {
    flags.description = flagArgs[i + 1];
    return { next: i + 2 };
  }
  if (arg === '--exposure' && i + 1 < flagArgs.length) {
    flags.exposure = flagArgs[i + 1];
    return { next: i + 2 };
  }
  if ((arg === '-H' || arg === '--header') && i + 1 < flagArgs.length) {
    const result = parseHeader(flagArgs[i + 1]);
    if (typeof result === 'string') return { next: i + 2, error: result };
    flags.headers.push(result);
    return { next: i + 2 };
  }
  if (arg === '--env' && i + 1 < flagArgs.length) {
    const result = parseEnvPair(flagArgs[i + 1]);
    if (typeof result === 'string') return { next: i + 2, error: result };
    flags.envPairs.push(result);
    return { next: i + 2 };
  }
  if (arg === '--cwd' && i + 1 < flagArgs.length) {
    flags.cwd = flagArgs[i + 1];
    return { next: i + 2 };
  }
  if (arg.startsWith('-')) return { next: i + 1, error: `unknown option '${arg}'` };
  flags.positional.push(arg);
  return { next: i + 1 };
}

function parseAddFlags(args: string[]): AddFlags | string {
  const flags: AddFlags = {
    local: false,
    noProbe: false,
    headers: [],
    envPairs: [],
    positional: [],
    cmdArgs: [],
  };
  const dashDashIdx = args.indexOf('--');
  const flagArgs = dashDashIdx >= 0 ? args.slice(0, dashDashIdx) : args;
  flags.cmdArgs = dashDashIdx >= 0 ? args.slice(dashDashIdx + 1) : [];

  let i = 0;
  while (i < flagArgs.length) {
    const step = parseAddFlagAt(flagArgs, i, flags);
    if (step.error) return step.error;
    i = step.next;
  }
  return flags;
}

function buildStdioConfig(flags: AddFlags): McpStdioServerConfig {
  const config: McpStdioServerConfig = {
    command: flags.cmdArgs[0],
    ...(flags.cmdArgs.length > 1 ? { args: flags.cmdArgs.slice(1) } : {}),
  };
  if (flags.envPairs.length > 0) {
    const env: Record<string, string> = {};
    for (const [k, v] of flags.envPairs) env[k] = v;
    config.env = env;
  }
  if (flags.cwd) config.cwd = flags.cwd;
  if (flags.description) config.description = flags.description;
  if (flags.exposure) config.exposure = flags.exposure as McpStdioServerConfig['exposure'];
  return config;
}

function buildHttpConfig(urlStr: string, flags: AddFlags): McpHttpServerConfig | string {
  const config: McpHttpServerConfig = { url: urlStr };
  if (flags.headers.length > 0) {
    const hdrs: Record<string, string> = {};
    for (const [k, v] of flags.headers) {
      if (literalSecret(k, v)) return `header '${k}' holds a literal secret; use \${NAME} instead`;
      hdrs[k] = v;
    }
    config.headers = hdrs;
  }
  if (flags.description) config.description = flags.description;
  if (flags.exposure) config.exposure = flags.exposure as McpHttpServerConfig['exposure'];
  return config;
}

export async function runAdd(platform: Platform, args: string[], probe?: ProbeFn): Promise<number> {
  const flags = parseAddFlags(args);
  if (typeof flags === 'string') {
    await platform.write(2, `mcpcat add: ${flags}\n`);
    return 2;
  }
  if (flags.positional.length < 1) {
    await platform.write(2, 'mcpcat add: requires a server name\n');
    return 2;
  }

  let name: string;
  let config: McpServerConfig;

  if (flags.cmdArgs.length > 0) {
    name = flags.positional[0];
    config = buildStdioConfig(flags);
  } else if (flags.positional.length >= 2) {
    let urlStr: string;
    if (URL.canParse(flags.positional[0]) && !URL.canParse(flags.positional[1])) {
      urlStr = flags.positional[0];
      name = flags.positional[1];
    } else {
      name = flags.positional[0];
      urlStr = flags.positional[1];
    }
    if (!URL.canParse(urlStr)) {
      await platform.write(2, `mcpcat add: '${urlStr}' is not a valid URL\n`);
      return 2;
    }
    const secret = urlHasSecret(urlStr);
    if (secret) {
      await platform.write(
        2,
        `mcpcat add: ${secret} holds a literal secret; use \${NAME} in a header instead\n`
      );
      return 2;
    }
    const httpResult = buildHttpConfig(urlStr, flags);
    if (typeof httpResult === 'string') {
      await platform.write(2, `mcpcat add: ${httpResult}\n`);
      return 2;
    }
    config = httpResult;
  } else {
    await platform.write(2, 'mcpcat add: requires a URL or -- <command>\n');
    return 2;
  }

  const validation = validateServer(name, config);
  if ('message' in validation) {
    await platform.write(2, `mcpcat add: ${validation.message}\n`);
    return 2;
  }

  const path =
    flags.configFile ?? (flags.local ? projectConfigPath(platform) : userConfigPath(platform));
  const { replaced } = await addServer(platform.fs, path, name, config);

  const warnings = checkAgentWarnings(name, config);
  for (const w of warnings) {
    await platform.write(2, `mcpcat add: warning: ${w.message}; ${w.advice}\n`);
  }

  await platform.write(1, `${replaced ? 'replaced' : 'added'} ${name} in ${path}\n`);

  if (!flags.noProbe && probe) {
    const reason = await probe(name, config, platform);
    if (reason) {
      await platform.write(2, `mcpcat add: probe failed: ${reason}\n`);
      return 3;
    }
  }

  return 0;
}

export async function runRm(platform: Platform, args: string[]): Promise<number> {
  let configFile: string | undefined;
  let local = false;
  const names: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--config' && i + 1 < args.length) {
      configFile = args[++i];
      continue;
    }
    if (arg === '-l' || arg === '--local') {
      local = true;
      continue;
    }
    if (arg === '--logout') continue;
    if (arg.startsWith('-')) {
      await platform.write(2, `mcpcat rm: unknown option '${arg}'\n`);
      return 2;
    }
    names.push(arg);
  }
  if (names.length === 0) {
    await platform.write(2, 'mcpcat rm: requires a server name\n');
    return 2;
  }

  const path = configFile ?? (local ? projectConfigPath(platform) : userConfigPath(platform));
  for (const name of names) {
    const removed = await removeServer(platform.fs, path, name);
    if (!removed) {
      await platform.write(2, `mcpcat rm: '${name}' not found in ${path}\n`);
      return 1;
    }
    await platform.write(1, `removed ${name} from ${path}\n`);
  }
  return 0;
}

function formatListEntry(entry: { name: string; config: McpServerConfig; source: string }): string {
  const c = entry.config;
  const transport = 'url' in c ? 'http' : 'stdio';
  const target = 'url' in c ? c.url : (c as McpStdioServerConfig).command;
  const enabled = 'enabled' in c && c.enabled === false ? ' (disabled)' : '';
  const exp = c.exposure ? ` [${c.exposure}]` : '';
  return `${entry.name}  ${transport}  ${target}${enabled}${exp}  (${entry.source})`;
}

async function printListJson(platform: Platform, config: LoadedConfig): Promise<void> {
  const entries: Record<string, unknown> = {};
  for (const entry of config.servers) {
    entries[entry.name] = {
      ...entry.config,
      source: entry.source,
      ...(entry.scope ? { scope: entry.scope } : {}),
      ...(entry.override ? { override: entry.override } : {}),
    };
  }
  await platform.write(1, `${JSON.stringify(entries, null, 2)}\n`);
}

async function printListText(platform: Platform, config: LoadedConfig): Promise<void> {
  if (config.servers.length === 0 && config.problems.length === 0) {
    await platform.write(1, 'no servers configured\n');
    return;
  }
  for (const entry of config.servers) {
    await platform.write(1, `${formatListEntry(entry)}\n`);
  }
}

export async function runList(platform: Platform, args: string[]): Promise<number> {
  let json = false;
  let configFile: string | undefined;
  let trustProject = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--config' && i + 1 < args.length) {
      configFile = args[++i];
      continue;
    }
    if (arg === '--trust-project') {
      trustProject = true;
    }
  }

  const source = await MergedConfigSource.load(platform, { trustProject, configFile });
  const { config } = source;

  if (json) {
    await printListJson(platform, config);
  } else {
    await printListText(platform, config);
  }

  let hasProblems = false;
  for (const p of config.problems) {
    hasProblems = true;
    const prefix = p.server ? `${p.server}: ` : '';
    await platform.write(2, `mcpcat list: ${prefix}${p.message}\n`);
  }

  return hasProblems ? 1 : 0;
}

export async function runEnable(
  platform: Platform,
  args: string[],
  enable: boolean
): Promise<number> {
  let configFile: string | undefined;
  let local = false;
  const names: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--config' && i + 1 < args.length) {
      configFile = args[++i];
      continue;
    }
    if (arg === '-l' || arg === '--local') {
      local = true;
      continue;
    }
    if (arg.startsWith('-')) continue;
    names.push(arg);
  }
  if (names.length === 0) {
    await platform.write(2, `mcpcat ${enable ? 'enable' : 'disable'}: requires a server name\n`);
    return 2;
  }
  const path = configFile ?? (local ? projectConfigPath(platform) : userConfigPath(platform));
  for (const name of names) {
    const ok = await updateServer(platform.fs, path, name, { enabled: enable });
    if (!ok) {
      await platform.write(
        2,
        `mcpcat ${enable ? 'enable' : 'disable'}: '${name}' not found in ${path}\n`
      );
      return 1;
    }
    await platform.write(1, `${enable ? 'enabled' : 'disabled'} ${name} in ${path}\n`);
  }
  return 0;
}

export async function runExposure(platform: Platform, args: string[]): Promise<number> {
  let configFile: string | undefined;
  let local = false;
  let toolGlob: string | undefined;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--config' && i + 1 < args.length) {
      configFile = args[++i];
      continue;
    }
    if (arg === '-l' || arg === '--local') {
      local = true;
      continue;
    }
    if (arg === '--tool' && i + 1 < args.length) {
      toolGlob = args[++i];
      continue;
    }
    if (arg.startsWith('-')) continue;
    positional.push(arg);
  }
  if (positional.length < 2) {
    await platform.write(2, 'mcpcat exposure: requires <name> <mode>\n');
    return 2;
  }
  const [name, mode] = positional;
  const validModes = ['codemode', 'deferred', 'direct', 'hidden'];
  if (!validModes.includes(mode)) {
    await platform.write(2, `mcpcat exposure: mode must be one of ${validModes.join(', ')}\n`);
    return 2;
  }
  const path = configFile ?? (local ? projectConfigPath(platform) : userConfigPath(platform));
  const ok = await setExposure(platform.fs, path, name, mode, toolGlob);
  if (!ok) {
    await platform.write(2, `mcpcat exposure: '${name}' not found in ${path}\n`);
    return 1;
  }
  const what = toolGlob ? `${name} tool ${toolGlob}` : name;
  await platform.write(1, `set ${what} to ${mode} in ${path}\n`);
  return 0;
}

export async function runImport(platform: Platform, args: string[]): Promise<number> {
  let configFile: string | undefined;
  let local = false;
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--config' && i + 1 < args.length) {
      configFile = args[++i];
      continue;
    }
    if (arg === '-l' || arg === '--local') {
      local = true;
      continue;
    }
    if (arg.startsWith('-')) continue;
    positional.push(arg);
  }
  if (positional.length < 1) {
    await platform.write(2, 'mcpcat import: requires a file path\n');
    return 2;
  }
  const filePath = positional[0];
  const names = positional.slice(1);

  let text: string;
  try {
    const data = await platform.fs.readFile(filePath);
    text = new TextDecoder().decode(data);
  } catch {
    await platform.write(2, `mcpcat import: cannot read '${filePath}'\n`);
    return 2;
  }

  const result = importFile(text, filePath, names.length > 0 ? names : undefined);
  for (const err of result.errors) {
    await platform.write(2, `mcpcat import: ${err}\n`);
  }
  if (result.servers.length === 0) {
    await platform.write(2, 'mcpcat import: no servers found\n');
    return 1;
  }

  const destPath = configFile ?? (local ? projectConfigPath(platform) : userConfigPath(platform));
  for (const { name, config } of result.servers) {
    const validation = validateServer(name, config);
    if ('message' in validation) {
      await platform.write(2, `mcpcat import: ${name}: ${validation.message}\n`);
      continue;
    }
    const { replaced } = await addServer(platform.fs, destPath, name, config);
    await platform.write(1, `${replaced ? 'replaced' : 'imported'} ${name}\n`);
  }
  return 0;
}
