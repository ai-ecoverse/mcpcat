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

mcpcat runs natively on macOS, Linux and Windows (Node ≥ 24), and inside Sliccy Seven as a kernel program, with the same flags, the same output and the same config file in both places. Orphan-free shutdown of stdio server trees in the kernel needs slicc-kernel ≥ 1.74.0; on older kernels only the direct child is signalled. A SIGKILLed mcpcat runs no handler. On slicc-kernel ≥ 1.88.0, mcpcat spawns stdio servers and served commands with a parent death signal (like Linux `PR_SET_PDEATHSIG`), so the kernel SIGKILLs each server's process group when mcpcat dies. On older kernels, and on the host, where there is no portable equivalent, servers that exit on stdin EOF (most MCP servers) still stop, but servers that ignore it keep running.

## Releases: certified = latest

Every npm release of mcpcat is certified first. A merge to `main` tags a version, packs its tarball, and runs mcpcat's cert-review on those exact bytes. Only a `certified` verdict whose sha256 matches the tarball gets published to npm as `latest`, with provenance. A failing version stays tagged as a GitHub prerelease and is never published, so `npm install @ai-ecoverse/mcpcat` and the installer always get the last certified release. The verdict line is in each release's notes and in the `cert-review` commit status.

## Quick start

```sh
mcpcat https://mcp.example.com/mcp
mcpcat weather get-forecast --lat 51.5 --lon -0.12
mcpcat serve --http 8808 ./scripts/jira.jsh
```

## License

Apache-2.0
