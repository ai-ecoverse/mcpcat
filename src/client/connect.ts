import type { Platform } from '../platform/types.ts';
import type { McpConnection } from './connection.ts';
import { createPiConnection } from './pi-connection.ts';
import {
  createStatelessConnection,
  StatelessHttpError,
  StatelessRpcError,
} from './stateless-connection.ts';

export interface ConnectOptions {
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  protocolVersion?: string;
  version?: string;
}

export async function connect(platform: Platform, options: ConnectOptions): Promise<McpConnection> {
  if (options.command) {
    return createPiConnection({
      command: options.command,
      args: options.args,
      env: options.env,
      cwd: options.cwd,
      version: options.version,
    });
  }

  if (!options.url) {
    throw new Error('connect requires either a url or a command');
  }

  if (options.protocolVersion && !options.protocolVersion.startsWith('2026')) {
    return createPiConnection({
      url: options.url,
      headers: options.headers,
      version: options.version,
    });
  }

  try {
    return await createStatelessConnection({
      url: options.url,
      headers: options.headers,
      fetchImpl: platform.fetch,
      clientInfo: { name: 'mcpcat', version: options.version ?? '0.0.0' },
    });
  } catch (err) {
    const isMethodNotFound =
      (err instanceof StatelessRpcError && err.code === -32601) ||
      (err instanceof StatelessHttpError && err.status >= 400 && err.status < 500);

    if (options.protocolVersion?.startsWith('2026')) {
      throw err;
    }

    if (isMethodNotFound) {
      return createPiConnection({
        url: options.url,
        headers: options.headers,
        version: options.version,
      });
    }

    throw err;
  }
}
