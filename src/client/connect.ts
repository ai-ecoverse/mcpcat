import type { AuthProvider } from '@earendil-works/pi-mcp';
import type { VerboseLogger } from '../cli/verbose.ts';
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
  timeoutMs?: number;
  signal?: AbortSignal;
  verbose?: VerboseLogger;
  authProvider?: AuthProvider;
}

export async function connect(platform: Platform, options: ConnectOptions): Promise<McpConnection> {
  const shared = {
    version: options.version,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    verbose: options.verbose,
    platform,
  };

  if (options.command) {
    return createPiConnection({
      command: options.command,
      args: options.args,
      env: options.env,
      cwd: options.cwd,
      ...shared,
    });
  }

  if (!options.url) throw new Error('connect requires either a url or a command');

  if (options.authProvider) {
    const token = await options.authProvider.token();
    if (token) {
      return createPiConnection({
        url: options.url,
        headers: options.headers,
        fetchImpl: platform.fetch,
        authProvider: options.authProvider,
        ...shared,
      });
    }
  }

  if (options.protocolVersion && !options.protocolVersion.startsWith('2026')) {
    return createPiConnection({
      url: options.url,
      headers: options.headers,
      fetchImpl: platform.fetch,
      ...shared,
    });
  }

  try {
    return await createStatelessConnection({
      url: options.url,
      headers: options.headers,
      fetchImpl: platform.fetch,
      clientInfo: { name: 'mcpcat', version: options.version ?? '0.0.0' },
      timeoutMs: options.timeoutMs,
      signal: options.signal,
      verbose: options.verbose,
    });
  } catch (err) {
    const isMethodNotFound =
      (err instanceof StatelessRpcError && err.code === -32601) ||
      (err instanceof StatelessHttpError && err.status >= 400 && err.status < 500);
    if (options.protocolVersion?.startsWith('2026')) throw err;
    if (isMethodNotFound) {
      return createPiConnection({
        url: options.url,
        headers: options.headers,
        fetchImpl: platform.fetch,
        authProvider: options.authProvider,
        ...shared,
      });
    }
    throw err;
  }
}
