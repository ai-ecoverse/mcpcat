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

mcpcat runs natively on macOS, Linux and Windows (Node ≥ 26), and inside Sliccy Seven as a kernel program, with the same flags, the same output and the same config file in both places. Orphan-free shutdown of stdio server trees in the kernel needs slicc-kernel ≥ 1.74.0; on older kernels only the direct child is signalled. A SIGKILLed mcpcat runs no handler. On slicc-kernel ≥ 1.88.0, mcpcat spawns stdio servers and served commands with a parent death signal (like Linux `PR_SET_PDEATHSIG`), so the kernel SIGKILLs each server's process group when mcpcat dies. On older kernels, and on the host, where there is no portable equivalent, servers that exit on stdin EOF (most MCP servers) still stop, but servers that ignore it keep running.

## CI and releases

`.github/workflows/ci.yml` is the only workflow. It calls [slicc-shared-web's pipeline](https://github.com/ai-ecoverse/slicc-shared-web#pipeline): lint (Biome, tsc and the shared rules) on every event; on pull requests and in the merge queue the integration suite (`npm test`, every `test/integration/*.test.mjs` on Node 26, split over Linux shards); on pull requests a Claude and a Codex review. The checks to require are `ci / integration` and `ci / review`. Every merge to `main` is released to npm as `latest` by semantic-release, with provenance, through trusted publishing bound to `ci.yml`. When a merge releases (a new `v*` tag at the commit), the `binaries` job packs the published tarball, runs the installer tests on Ubuntu (with and without Node) and Alpine, and attaches the tarball, `install.sh` and `SHA256SUMS` to the GitHub release. `kernel-floor.test.mjs` runs the kernel tests on the `engines.slicc-kernel` floor; `MCPCAT_KERNEL_DIR` points the kernel tests at any installed `@ai-ecoverse/slicc-kernel`.

## Quick start

```sh
mcpcat https://mcp.example.com/mcp
mcpcat weather get-forecast --lat 51.5 --lon -0.12
mcpcat serve --http 8808 ./scripts/jira.jsh
```

## Agent skill

The package ships an [Agent Skill](https://agentskills.io/specification) that teaches an agent mcpcat in one file: `dist/skills/mcpcat/SKILL.md`, built from [`src/skill/SKILL.txt`](src/skill/SKILL.txt) (the repo keeps no Markdown besides README.md and AGENTS.md). It covers targets, listing and calling tools, `mcp.json`, exit codes, and the secrets rule: `${NAME}` placeholders in single quotes, never a value in a command, a file or the conversation, and never a token in `mcp.json`. `mcpcat help --skill` prints the copy that matches the installed version. `package.json` declares it as a pi package skill (`"pi": { "skills": ["dist/skills"] }`). In seven, bios links it into `/usr/share/skills` for the catalog install.

## License

Apache-2.0
