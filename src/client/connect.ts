import type { AuthProvider } from '@earendil-works/pi-mcp';
import { AuthStepUpError } from '../auth/auth-provider.ts';
import type { VerboseLogger } from '../cli/verbose.ts';
import type { Platform } from '../platform/types.ts';
import type { McpConnection } from './connection.ts';
import { createPiConnection } from './pi-connection.ts';
import {
  createStatelessConnection,
  McpAuthError,
  StatelessHttpError,
  StatelessRpcError,
} from './stateless-connection.ts';
import { probeStdioStateless } from './stdio-stateless.ts';

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
  roots?: { uri: string; name?: string }[];
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: protocol negotiation requires many branches
export async function connect(platform: Platform, options: ConnectOptions): Promise<McpConnection> {
  const shared = {
    version: options.version,
    timeoutMs: options.timeoutMs,
    signal: options.signal,
    verbose: options.verbose,
    platform,
  };

  if (options.command) {
    let fallbackProcess:
      | { proc: import('../platform/types.ts').SpawnResult; pendingStdout: string }
      | undefined;
    if (!options.protocolVersion || options.protocolVersion.startsWith('2026')) {
      const result = await probeStdioStateless({
        command: options.command,
        args: options.args,
        env: options.env,
        cwd: options.cwd,
        platform,
        version: options.version,
        timeoutMs: options.timeoutMs,
        signal: options.signal,
        verbose: options.verbose,
      });
      if (!('proc' in result)) return result;
      const isMethodNotFound =
        result.error instanceof StatelessRpcError && result.error.code === -32601;
      const isUnsupported = result.error.message.includes('does not support');
      if (options.protocolVersion?.startsWith('2026')) {
        try {
          await result.proc.kill('SIGTERM');
        } catch {}
        throw result.error;
      }
      if (!isMethodNotFound && !isUnsupported) {
        try {
          await result.proc.kill('SIGTERM');
        } catch {}
        throw result.error;
      }
      fallbackProcess = { proc: result.proc, pendingStdout: result.pendingStdout };
    }
    return createPiConnection({
      command: options.command,
      args: options.args,
      env: options.env,
      cwd: options.cwd,
      roots: options.roots,
      existingProcess: fallbackProcess,
      ...shared,
    });
  }

  if (!options.url) throw new Error('connect requires either a url or a command');

  if (options.protocolVersion && !options.protocolVersion.startsWith('2026')) {
    return createPiConnection({
      url: options.url,
      headers: options.headers,
      fetchImpl: platform.fetch,
      authProvider: options.authProvider,
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
      authProvider: options.authProvider,
    });
  } catch (err) {
    const isMethodNotFound =
      (err instanceof StatelessRpcError && err.code === -32601) ||
      (err instanceof StatelessHttpError && err.status >= 400 && err.status < 500);
    if (options.protocolVersion?.startsWith('2026')) throw err;
    if (err instanceof McpAuthError || err instanceof AuthStepUpError) throw err;
    if ((err as Error).name === 'McpOAuthAuthorizationRequiredError') throw err;
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
