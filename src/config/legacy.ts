import type { Platform } from '../platform/types.ts';
import { lookupKey, type ParsedMcpFile, parseMcpJson } from './parse.ts';
import { legacyConfigDir, userConfigPath } from './paths.ts';

export interface LegacyHint {
  platform: Platform;
  quiet?: boolean;
}

interface Stranded {
  dir: string;
  names: string[];
  partial: boolean;
}

const hinted = new WeakSet<Platform>();

async function parseFile(platform: Platform, path: string): Promise<ParsedMcpFile | undefined> {
  try {
    return parseMcpJson(new TextDecoder().decode(await platform.fs.readFile(path)));
  } catch {
    return undefined;
  }
}

async function strandedServers(platform: Platform): Promise<Stranded | undefined> {
  const dir = legacyConfigDir(platform);
  if (!dir) return undefined;
  const legacy = await parseFile(platform, `${dir}/mcp.json`);
  if (!legacy?.servers.length) return undefined;
  const agent = await parseFile(platform, userConfigPath(platform));
  const present = new Set(
    [...(agent?.servers ?? []), ...(agent?.overrides ?? [])].map((s) => lookupKey(s.name))
  );
  const names = legacy.servers.map((s) => s.name).filter((n) => !present.has(lookupKey(n)));
  if (names.length === 0) return undefined;
  return { dir, names, partial: names.length < legacy.servers.length };
}

async function writeHint(platform: Platform, { dir, names, partial }: Stranded): Promise<void> {
  if (hinted.has(platform)) return;
  hinted.add(platform);
  const path = `${dir}/mcp.json`;
  const auth = `${dir}/mcp-auth.json`;
  const command = partial ? `mcpcat import ${path} ${names.join(' ')}` : `mcpcat import ${path}`;
  const tokens = (await platform.fs.exists(auth).catch(() => false))
    ? `; tokens in ${auth} stay there, so sign in again in Settings › MCP servers`
    : '';
  await platform.write(
    2,
    `mcpcat: servers found in ${path} that the agent does not read; run "${command}" to copy them to ${userConfigPath(platform)} (the agent still refuses stdio, literal secrets and sse entries)${tokens}\n`
  );
}

export async function hintLegacyConfig(platform: Platform): Promise<void> {
  const stranded = await strandedServers(platform);
  if (stranded) await writeHint(platform, stranded);
}

export async function legacyPathFor(
  { platform, quiet }: LegacyHint,
  name: string
): Promise<string | undefined> {
  const stranded = await strandedServers(platform);
  if (!stranded) return undefined;
  if (!quiet) await writeHint(platform, stranded);
  const key = lookupKey(name);
  return stranded.names.some((n) => lookupKey(n) === key) ? `${stranded.dir}/mcp.json` : undefined;
}
