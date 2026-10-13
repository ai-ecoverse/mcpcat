import type { AgentWarning, McpServerConfig } from './types.ts';

const SECRET_HEADER = /authorization|cookie|token|key|secret|password|session/i;
const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
const SCHEME = /^\s*(?:bearer|basic|token|apikey|api-key)\s+/i;
const SECRET_PARAM = /token|key|secret|password|signature|sig|auth|code/i;

export function literalSecret(header: string, value: string): boolean {
  if (!SECRET_HEADER.test(header)) return false;
  return value.replace(PLACEHOLDER, '').replace(SCHEME, '').trim() !== '';
}

export function urlHasSecret(url: string): string | undefined {
  if (!URL.canParse(url)) return undefined;
  const parsed = new URL(url);
  if (parsed.username || parsed.password) return 'url';
  for (const name of parsed.searchParams.keys()) if (SECRET_PARAM.test(name)) return `url ?${name}`;
  return undefined;
}

const SLICC_OAUTH_REFUSED: Record<string, string> = {
  clientSecret: 'a client secret would have to live in mcp.json; SLICC signs in as a public client',
  callbackPort: 'SLICC signs in through its own page, not a loopback port',
  callbackUrl: 'SLICC signs in through its own page, not a loopback URL',
  clientRegistration: 'SLICC registers dynamically or uses oauth.clientId',
};

export function checkAgentWarnings(name: string, config: McpServerConfig): AgentWarning[] {
  const warnings: AgentWarning[] = [];

  if ('command' in config && config.command) {
    warnings.push({
      server: name,
      message: 'stdio servers need slicc-kernel#68, so the agent will skip this entry',
      advice: 'use mcpcat serve --proxy to bridge it as HTTP',
    });
  }

  if ('headers' in config && config.headers) {
    for (const [h, v] of Object.entries(config.headers)) {
      if (v.trim().startsWith('!')) {
        warnings.push({
          server: name,
          message: `headers.${h} runs a command, which the agent can't do`,
          advice: 'use ${NAME} and set the value in Settings > MCP servers',
        });
      }
      if (literalSecret(h, v)) {
        warnings.push({
          server: name,
          message: `headers.${h} holds a literal secret`,
          advice: 'write ${NAME} instead, and add the value in Settings > MCP servers',
        });
      }
    }
  }

  if ('url' in config && config.url) {
    const secret = urlHasSecret(config.url);
    if (secret) {
      warnings.push({
        server: name,
        message: `${secret} holds a literal secret`,
        advice: 'put it in a header as ${NAME}',
      });
    }
  }

  if ('oauth' in config && config.oauth) {
    for (const key of Object.keys(config.oauth)) {
      const reason = SLICC_OAUTH_REFUSED[key];
      if (reason) {
        warnings.push({
          server: name,
          message: `oauth.${key} is not supported by the agent: ${reason}`,
          advice: `remove oauth.${key}`,
        });
      }
    }
  }

  return warnings;
}
