import {
  type CallToolResult,
  McpClient,
  type McpClientOptions,
  type McpTransport,
  StdioTransport,
  StreamableHttpTransport,
  type Tool,
} from '@earendil-works/pi-mcp';
import type { Platform } from '../platform/types.ts';
import type { McpConnection, ServerInfo } from './connection.ts';
import { PlatformStdioTransport } from './platform-stdio-transport.ts';

export interface PiConnectionOptions {
  url?: string;
  headers?: Record<string, string>;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  version?: string;
  fetchImpl?: typeof globalThis.fetch;
  platform?: Platform;
}

export async function createPiConnection(options: PiConnectionOptions): Promise<McpConnection> {
  const clientOptions: McpClientOptions = {
    name: 'mcpcat',
    version: options.version ?? '0.0.0',
  };

  const client = new McpClient(clientOptions);

  let transport: McpTransport;
  if (options.url) {
    transport = new StreamableHttpTransport({
      url: options.url,
      headers: options.headers,
      fetch: options.fetchImpl,
    });
  } else if (options.command) {
    if (options.platform) {
      transport = new PlatformStdioTransport({
        command: options.command,
        args: options.args,
        env: options.env,
        cwd: options.cwd,
        inheritEnv: true,
        platform: options.platform,
      }) as unknown as McpTransport;
    } else {
      transport = new StdioTransport({
        command: options.command,
        args: options.args,
        env: options.env,
        cwd: options.cwd,
        inheritEnv: true,
        stderr: 'pipe',
      });
    }
  } else {
    throw new Error('PiConnection requires either a url or a command');
  }

  const initResult = await client.connect(transport);

  return {
    async info(): Promise<ServerInfo> {
      return {
        name: initResult.serverInfo?.name,
        version: initResult.serverInfo?.version,
        title: (initResult.serverInfo as unknown as Record<string, unknown>)?.title as
          | string
          | undefined,
        protocolVersion: initResult.protocolVersion,
        capabilities: initResult.capabilities as unknown as Record<string, unknown>,
        instructions: initResult.instructions,
      };
    },

    async listTools(): Promise<Tool[]> {
      return client.listTools();
    },

    async callTool(name: string, args?: Record<string, unknown>): Promise<CallToolResult> {
      return client.callTool(name, args);
    },

    async close(): Promise<void> {
      await client.close();
    },
  };
}
