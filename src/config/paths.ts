import type { Platform } from '../platform/types.ts';

export function userConfigDir(platform: Platform): string {
  const piDir = platform.env.PI_CODING_AGENT_DIR;
  if (piDir) return piDir;
  const home = platform.env.HOME ?? platform.env.USERPROFILE ?? '/';
  return `${home}/.pi/agent`;
}

export function userConfigPath(platform: Platform): string {
  return `${userConfigDir(platform)}/mcp.json`;
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
