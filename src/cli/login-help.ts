export function loginHelpText(version: string): string {
  return `mcpcat ${version} – login

Usage: mcpcat login <target> [options]

Sign in to an MCP server that uses OAuth. <target> is a name from mcp.json or
an https URL. On the host, named entries that a new enough jerk lists use
jerk create; otherwise tokens go to pi's mcp-auth.json. Login is not available
in seven.

Options:
  --no-browser               Print the authorize URL; paste the redirect URL back
  --no-jerk                  Skip slicc-jerk; always use mcpcat's own sign-in
                             (tokens in mcp-auth.json). Also set MCPCAT_NO_JERK=1
                             so later commands read that store while jerk is on PATH
  --scope <scope>            Request these scopes (space-separated)
  -m, --timeout <s>          Request timeout

Examples:
  mcpcat login ch
  mcpcat login ch --no-browser
  mcpcat login ch --no-jerk
  mcpcat login https://mcp.example.com/mcp --scope mcp:access
`;
}

export function wantsLoginHelp(args: string[], verb: string | undefined): boolean {
  if (args[0] === 'help') return args[1] === 'login';
  return verb === 'login';
}

export async function writeLoginHelp(
  write: (fd: number, data: string) => Promise<void>,
  version: string,
  args: string[],
  verb: string | undefined
): Promise<boolean> {
  if (!wantsLoginHelp(args, verb)) return false;
  await write(1, loginHelpText(version));
  return true;
}
