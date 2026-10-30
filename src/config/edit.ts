import type { FsApi } from '../platform/types.ts';
import { acquireLock } from './lock.ts';
import type { McpServerConfig } from './types.ts';

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const PI_DIR = /\/\.pi(\/agent)?$/;

async function privateDir(fs: FsApi, dir: string, made: boolean): Promise<void> {
  try {
    await fs.mkdir(dir, { mode: DIR_MODE });
  } catch {}
  if (fs.chmod && (made || PI_DIR.test(dir))) {
    try {
      await fs.chmod(dir, DIR_MODE);
    } catch {}
  }
}

async function keptMode(fs: FsApi, path: string): Promise<number> {
  const mode = await fs.stat(path).then(
    (s) => s.mode,
    () => undefined
  );
  return mode === undefined ? FILE_MODE : mode & FILE_MODE;
}

async function privateFile(fs: FsApi, path: string, output: string, mode: number): Promise<void> {
  await fs.writeFile(path, output, { mode: FILE_MODE });
  if (!fs.chmod) return;
  try {
    await fs.chmod(path, mode);
  } catch {}
}

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
  const dir = path.slice(0, path.lastIndexOf('/'));
  const made = dir !== '' && !(await fs.exists(dir).catch(() => false));
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
    if (dir) await privateDir(fs, dir, made);
    const tmpPath = `${path}.tmp.${Date.now()}`;
    try {
      await privateFile(fs, tmpPath, output, await keptMode(fs, path));
      await fs.rename(tmpPath, path);
    } catch (renameErr) {
      try {
        if (fs.unlink) await fs.unlink(tmpPath);
      } catch {}
      throw renameErr;
    }
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
