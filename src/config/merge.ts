import type { FsApi } from '../platform/types.ts';
import type { ParsedMcpFile } from './parse.ts';
import { canonical, parseMcpJson } from './parse.ts';
import type { LoadedConfig, McpConfigProblem, McpServerConfig, McpServerEntry } from './types.ts';

const OVERRIDE_KEYS = new Set(['enabled', 'exposure', 'toolExposure']);

interface MergeInput {
  userPath: string;
  projectPath?: string;
  trustProject: boolean;
  fs: FsApi;
}

async function readFile(fs: FsApi, path: string): Promise<string | undefined> {
  try {
    const data = await fs.readFile(path);
    return new TextDecoder().decode(data);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EACCES') {
      const e = new Error(`permission denied: ${path}`);
      (e as NodeJS.ErrnoException).code = 'EACCES';
      throw e;
    }
    return undefined;
  }
}

function applyOverride(
  servers: Map<string, McpServerEntry>,
  problems: McpConfigProblem[],
  name: string,
  override: unknown,
  projectPath: string
): void {
  const raw = override as Record<string, unknown>;
  const base = servers.get(name);
  const extra = Object.keys(raw).filter((k) => !OVERRIDE_KEYS.has(k));
  if (!base) {
    problems.push({
      server: name,
      message: 'needs "command" or "url", or a user server to override',
    });
    return;
  }
  if (extra.length > 0) {
    problems.push({
      server: name,
      message: 'an override can only set enabled, exposure, toolExposure',
    });
    return;
  }
  const merged: McpServerConfig = { ...base.config, ...raw } as McpServerConfig;
  servers.set(name, { ...base, config: merged, override: projectPath });
}

function applyProjectEntry(
  servers: Map<string, McpServerEntry>,
  problems: McpConfigProblem[],
  name: string,
  config: McpServerConfig,
  projectPath: string
): void {
  const clash = [...servers.keys()].find(
    (other) => other !== name && canonical(other) === canonical(name)
  );
  if (clash) {
    problems.push({
      server: name,
      message: `conflicts with "${clash}" (names differ only in "-"/"_")`,
    });
    return;
  }
  servers.set(name, { name, config, source: projectPath, scope: 'project' });
}

function loadUserServers(
  parsed: ParsedMcpFile,
  userPath: string,
  servers: Map<string, McpServerEntry>,
  problems: McpConfigProblem[]
): void {
  for (const p of parsed.problems) problems.push(p);
  for (const { name, config } of parsed.servers) {
    servers.set(name, { name, config, source: userPath, scope: 'user' });
  }
}

function loadProjectServers(
  parsed: ParsedMcpFile,
  projectPath: string,
  servers: Map<string, McpServerEntry>,
  problems: McpConfigProblem[]
): void {
  for (const p of parsed.problems) problems.push(p);
  for (const { name, raw } of parsed.overrides) {
    applyOverride(servers, problems, name, raw as unknown as McpServerConfig, projectPath);
  }
  for (const { name, config } of parsed.servers) {
    applyProjectEntry(servers, problems, name, config, projectPath);
  }
}

export async function loadConfig(input: MergeInput): Promise<LoadedConfig> {
  const servers = new Map<string, McpServerEntry>();
  const problems: McpConfigProblem[] = [];
  let autoEnableCodemode: boolean | undefined;

  const userText = await readFile(input.fs, input.userPath);
  if (userText !== undefined) {
    const parsed = parseMcpJson(userText);
    if (parsed.autoEnableCodemode !== undefined) autoEnableCodemode = parsed.autoEnableCodemode;
    loadUserServers(parsed, input.userPath, servers, problems);
  }

  if (input.projectPath && input.trustProject) {
    const projectText = await readFile(input.fs, input.projectPath);
    if (projectText !== undefined) {
      const parsed = parseMcpJson(projectText);
      if (parsed.autoEnableCodemode !== undefined) autoEnableCodemode = parsed.autoEnableCodemode;
      loadProjectServers(parsed, input.projectPath, servers, problems);
    }
  }

  return {
    servers: [...servers.values()],
    problems,
    ...(autoEnableCodemode !== undefined ? { autoEnableCodemode } : {}),
  };
}
