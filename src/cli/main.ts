import type { Platform } from '../platform/types.ts';

const VERBS = [
  'info',
  'tools',
  'call',
  'describe',
  'resources',
  'read',
  'prompts',
  'prompt',
  'grep',
  'complete',
  'task',
  'add',
  'rm',
  'list',
  'enable',
  'disable',
  'exposure',
  'import',
  'login',
  'logout',
  'serve',
  'code',
  'discover',
  'inbox',
  'help',
];

function helpText(version: string): string {
  return `mcpcat ${version} – a curl for the Model Context Protocol

Usage: mcpcat [options] <target> [<tool> [args…]]
       mcpcat [options] <verb> …

Client verbs:
  info <target>              Server identity and capabilities
  tools <target>             List tools (not implemented yet)
  call <target> <tool>       Call a tool (not implemented yet)
  describe <target> [tool]   Tool schema and help (not implemented yet)
  resources <target>         List resources (not implemented yet)
  read <target> <uri>        Read a resource (not implemented yet)
  prompts <target>           List prompts (not implemented yet)
  prompt <target> <name>     Render a prompt (not implemented yet)
  grep <pattern>             Search across servers (not implemented yet)
  complete <target> …        Completion (not implemented yet)
  task get|cancel …          Task extension (not implemented yet)

Configuration verbs:
  add <name> <url>           Add a server to mcp.json (not implemented yet)
  rm <name>                  Remove a server (not implemented yet)
  list                       List configured servers (not implemented yet)
  enable|disable <name>      Toggle a server (not implemented yet)
  exposure <name> <mode>     Set exposure mode (not implemented yet)
  import <file>              Import from other configs (not implemented yet)
  login <target>             OAuth sign-in (not implemented yet)
  logout <target>            Remove tokens (not implemented yet)

Server and code verbs:
  serve [--stdio|--http] …   Expose commands as MCP server (not implemented yet)
  code [-e src|file.js]      Run a codemode script (not implemented yet)
  discover <url>             Find MCP servers (not implemented yet)
  inbox                      Discovery inbox (not implemented yet)
  help [verb]                Show help

Options:
  --json                     JSON output
  -H, --header 'N: V'       Extra header
  -m, --timeout <s>          Request timeout (default 60)
  -v, --verbose              Trace on stderr
  -s, --silent               Suppress progress
  -o, --output <path>        Write result to file
  -V, --version              Print version
  -h, --help                 Show this help
`;
}

export async function run(
  platform: Platform,
  version: string,
  args: string[],
): Promise<number> {
  if (args.includes('--version') || args.includes('-V')) {
    await platform.write(1, `${version}\n`);
    return 0;
  }

  if (args.includes('--help') || args.includes('-h') || args[0] === 'help') {
    await platform.write(1, helpText(version));
    return 0;
  }

  if (args.length === 0) {
    await platform.write(1, helpText(version));
    return 0;
  }

  const verb = args[0];
  if (VERBS.includes(verb)) {
    await platform.write(2, `mcpcat: '${verb}' is not implemented yet\n`);
    return 1;
  }

  await platform.write(2, `mcpcat: unknown command '${verb}'\n`);
  return 2;
}
