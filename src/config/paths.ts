import type { Platform } from '../platform/types.ts';

export const AGENT_CONFIG_DIR = '/etc/slicc/agent';

function homeConfigDir(platform: Platform): string {
  const home = platform.env.HOME ?? platform.env.USERPROFILE ?? '/';
  return `${home}/.pi/agent`;
}

export function userConfigDir(platform: Platform): string {
  const piDir = platform.env.PI_CODING_AGENT_DIR;
  if (piDir) return piDir;
  if (platform.kind === 'kernel' && platform.uid === 0) return AGENT_CONFIG_DIR;
  return homeConfigDir(platform);
}

export function legacyConfigDir(platform: Platform): string | undefined {
  return userConfigDir(platform) === AGENT_CONFIG_DIR && !platform.env.PI_CODING_AGENT_DIR
    ? homeConfigDir(platform)
    : undefined;
}

export function userConfigPath(platform: Platform): string {
  return `${userConfigDir(platform)}/mcp.json`;
}

export function agentIgnoresConfig(platform: Platform, path: string): boolean {
  return (
    platform.kind === 'kernel' &&
    Boolean(platform.uid) &&
    !platform.env.PI_CODING_AGENT_DIR &&
    path === userConfigPath(platform)
  );
}

export function projectConfigPath(platform: Platform): string {
  return `${platform.cwd}/.pi/mcp.json`;
}

export function cacheDir(platform: Platform): string {
  if (platform.env.XDG_CACHE_HOME) return `${platform.env.XDG_CACHE_HOME}/mcpcat`;
  const home = platform.env.HOME ?? platform.env.USERPROFILE ?? '/';
  if (platform.env.LOCALAPPDATA) return `${platform.env.LOCALAPPDATA}\\mcpcat\\cache`;
  return `${home}/Library/Caches/mcpcat`;
}

export function stateDir(platform: Platform): string {
  if (platform.env.XDG_STATE_HOME) return `${platform.env.XDG_STATE_HOME}/mcpcat`;
  const home = platform.env.HOME ?? platform.env.USERPROFILE ?? '/';
  if (platform.env.LOCALAPPDATA) return `${platform.env.LOCALAPPDATA}\\mcpcat\\state`;
  if (platform.env.SLICC_KERNEL) return `${home}/.local/state/mcpcat`;
  return `${home}/Library/Application Support/mcpcat`;
}
