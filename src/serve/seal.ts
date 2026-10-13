import type { Platform } from '../platform/types.ts';

export interface SealOptions {
  server: string;
  url: string;
}

export interface SealResult {
  placeholder: string;
}

export async function sealSecret(
  platform: Platform,
  name: string,
  value: string,
  options: SealOptions
): Promise<SealResult> {
  if (!platform.seal) {
    throw Object.assign(new Error('vault device not available'), { sealErrno: 'ENOTCONN' });
  }
  const request = JSON.stringify({
    v: 1,
    op: 'seal',
    kind: 'mcp',
    name,
    value,
    server: options.server,
    url: options.url,
  });
  let responseText: string;
  try {
    responseText = await platform.seal(request);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTCONN') {
      throw Object.assign(new Error('vault device not available'), { sealErrno: 'ENOTCONN' });
    }
    throw Object.assign(new Error(`vault: ${(err as Error).message}`), {
      sealErrno: code ?? 'EACCES',
    });
  }
  const response = JSON.parse(responseText);
  if (response.error) {
    throw Object.assign(new Error(response.error), { sealErrno: response.errno ?? 'EACCES' });
  }
  return { placeholder: response.placeholder };
}

export function sealExitCode(errno: string): number {
  if (errno === 'EEXIST') return 2;
  return 4;
}

export function sealErrorMessage(errno: string, name: string): string {
  if (errno === 'EEXIST') return `a non-bridge secret named ${name} already exists`;
  if (errno === 'ENOTCONN') return "no vault available; use --bearer '${VAR}' or --no-auth";
  if (errno === 'EACCES') return "vault locked; use --bearer '${VAR}' or --no-auth";
  return `vault error: ${errno}`;
}
