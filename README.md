# mcpcat

A curl for the Model Context Protocol. One command that talks to any MCP server from a shell, and turns any shell command into an MCP server.

## Install

```sh
curl -fsSL https://get.sliccy.ai/mcpcat | sh
```

The same installer from the GitHub release, if the short URL is unreachable:

```sh
curl -fsSL https://github.com/ai-ecoverse/mcpcat/releases/latest/download/install.sh | sh
```

Options pass through, for example `curl -fsSL https://get.sliccy.ai/mcpcat | sh -s -- --help`.

Or via npm:

```sh
npm install -g @ai-ecoverse/mcpcat
```

mcpcat runs natively on macOS, Linux and Windows (Node ≥ 24), and inside Sliccy Seven as a kernel program, with the same flags, the same output and the same config file in both places. Orphan-free shutdown of stdio server trees in the kernel needs slicc-kernel ≥ 1.74.0; on older kernels only the direct child is signalled. When the kernel sends SIGKILL to mcpcat's process group, no handler can run and the server tree survives; a kernel "parent death signal" spawn option (like Linux `PR_SET_PDEATHSIG`) would cover that case.

## Quick start

```sh
mcpcat https://mcp.example.com/mcp
mcpcat weather get-forecast --lat 51.5 --lon -0.12
mcpcat serve --http 8808 ./scripts/jira.jsh
```

## License

Apache-2.0
