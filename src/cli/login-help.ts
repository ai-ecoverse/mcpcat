export function loginHelpText(version: string): string {
  return `mcpcat ${version} – login

Usage: mcpcat login <target> [options]

Sign in to an MCP server that uses OAuth. <target> is a name from mcp.json or
an https URL. On the host, named entries that a new enough jerk lists use
jerk create; otherwise tokens go to pi's mcp-auth.json. Login is not available
in seven.

mcpcat listens for the redirect on 127.0.0.1, or on oauth.callbackUrl when
that is a loopback URL (localhost, 127.0.0.1, [::1]). An oauth.callbackUrl on
any other host without a port, such as https://app.example.com/oauth/callback,
is a web redirect: it is sent verbatim as redirect_uri, nothing listens, and
you paste the URL of the page you land on after signing in (the browser still
opens unless --no-browser). Web redirects always use mcpcat's own sign-in.
oauth.callbackPort with a web callbackUrl keeps a listener: the port is added
to the URL and mcpcat listens on that host.

Options:
  --no-browser               Print the authorize URL; paste the redirect URL back
  --no-jerk                  Skip slicc-jerk; always use mcpcat's own sign-in
                             (tokens in mcp-auth.json). MCPCAT_NO_JERK=1 is the
                             same opt-out; a workaround only — reads try pi then jerk
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
