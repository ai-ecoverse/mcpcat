export function callHelpText(version: string): string {
  return `mcpcat ${version} – call

Usage: mcpcat call <target> <tool> [args…]
       mcpcat [options] <target> <tool> [args…]

Call a tool on an MCP server. <target> is a name from mcp.json, an https URL,
or stdio:… / -- <command>. Tool arguments are schema-driven flags after the
tool name, or one JSON object with -d.

Arguments:
  --name value               Set a property (types follow the tool's inputSchema)
  --name=value               Same, inline form
  --no-name                  Set a boolean property to false
  -d <json>                  Tool arguments as JSON (or @file, @- for stdin)
  --no-validate              Skip required-property checks before the request

Bare key=value after the tool name is not accepted; use --key value or
--key=value. Literal secrets in arguments are refused the same way as for
--key forms.

Global options that affect call (before the tool name):
  --json                     JSON output
  -m, --timeout <s>          Request timeout
  --async                    Allow a task handle instead of waiting
  -H, --header 'N: V'        Extra header
  -v, --verbose              Trace on stderr

Examples:
  mcpcat call docs search --q oauth --limit 5
  mcpcat call docs search --q=oauth
  mcpcat call docs search -d '{"q":"oauth","limit":5}'
  mcpcat --json call https://example.com/mcp search --q oauth
`;
}

export function wantsCallHelp(args: string[], verb: string | undefined): boolean {
  if (args[0] === 'help') return args[1] === 'call';
  return verb === 'call';
}

export async function writeCallHelp(
  write: (fd: number, data: string) => Promise<void>,
  version: string,
  args: string[],
  verb: string | undefined
): Promise<boolean> {
  if (!wantsCallHelp(args, verb)) return false;
  await write(1, callHelpText(version));
  return true;
}
