import type { FsApi } from '../platform/types.ts';
import { acquireLock } from './lock.ts';
import type { McpServerConfig } from './types.ts';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function detectIndent(text: string): string {
  const match = /^([ \t]+)\S/m.exec(text);
  return match ? match[1] : '  ';
}

async function readText(fs: FsApi, path: string): Promise<string | undefined> {
  try {
    const data = await fs.readFile(path);
    return new TextDecoder().decode(data);
  } catch {
    return undefined;
  }
}

export interface EditResult {
  changed: boolean;
}

async function editMcpServers(
  fs: FsApi,
  path: string,
  edit: (servers: Record<string, unknown> | undefined, parsed: Record<string, unknown>) => boolean
): Promise<EditResult> {
  const release = await acquireLock(fs, path);
  try {
    const text = await readText(fs, path);
    const parsed: unknown = text === undefined ? {} : JSON.parse(text);
    if (!isRecord(parsed) || (parsed.mcpServers !== undefined && !isRecord(parsed.mcpServers)))
      throw new Error(`${path}: expected an object with an "mcpServers" object`);
    const servers = isRecord(parsed.mcpServers) ? parsed.mcpServers : undefined;
    if (!edit(servers, parsed)) return { changed: false };
    const indent = text ? detectIndent(text) : '  ';
    const output = `${JSON.stringify(parsed, null, indent)}\n`;
    const dir = path.slice(0, path.lastIndexOf('/'));
    if (dir) {
      try {
        await fs.mkdir(dir);
      } catch {}
    }
    const tmpPath = `${path}.tmp.${Date.now()}`;
    await fs.writeFile(tmpPath, output);
    await fs.rename(tmpPath, path);
    return { changed: true };
  } finally {
    await release();
  }
}

export async function addServer(
  fs: FsApi,
  path: string,
  name: string,
  config: McpServerConfig
): Promise<{ replaced: boolean }> {
  let replaced = false;
  await editMcpServers(fs, path, (servers, parsed) => {
    const target = servers ?? {};
    replaced = target[name] !== undefined;
    target[name] = config;
    parsed.mcpServers = target;
    return true;
  });
  return { replaced };
}

export async function removeServer(fs: FsApi, path: string, name: string): Promise<boolean> {
  let removed = false;
  await editMcpServers(fs, path, (servers) => {
    if (!servers || servers[name] === undefined) return false;
    delete servers[name];
    removed = true;
    return true;
  });
  return removed;
}

export async function updateServer(
  fs: FsApi,
  path: string,
  name: string,
  patch: { enabled?: boolean; exposure?: string; toolExposure?: Record<string, string> }
): Promise<boolean> {
  let updated = false;
  await editMcpServers(fs, path, (servers) => {
    if (!servers || !isRecord(servers[name])) return false;
    const entry = servers[name] as Record<string, unknown>;
    if (patch.enabled !== undefined) entry.enabled = patch.enabled;
    if (patch.exposure !== undefined) entry.exposure = patch.exposure;
    if (patch.toolExposure !== undefined) entry.toolExposure = patch.toolExposure;
    updated = true;
    return true;
  });
  return updated;
}

export async function setExposure(
  fs: FsApi,
  path: string,
  name: string,
  exposure: string,
  toolGlob?: string
): Promise<boolean> {
  let updated = false;
  await editMcpServers(fs, path, (servers) => {
    if (!servers || !isRecord(servers[name])) return false;
    const entry = servers[name] as Record<string, unknown>;
    if (toolGlob) {
      const te = isRecord(entry.toolExposure) ? { ...entry.toolExposure } : {};
      te[toolGlob] = exposure;
      entry.toolExposure = te;
    } else {
      entry.exposure = exposure;
    }
    updated = true;
    return true;
  });
  return updated;
}
