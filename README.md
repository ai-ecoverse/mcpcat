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

Every change that alters what mcpcat ships is certified before it reaches `main`. A pull request that touches `src/`, the build, the dependencies or the release workflows gets mcpcat's cert-review on a pack of its head, and again in the merge queue on the exact tree that lands on `main`; a FAIL blocks the merge. Docs-, test- and CI-only changes skip it as "not behaviour". Each merge to `main` is then released to npm as `latest` in one step by semantic-release, with provenance, so `npm install @ai-ecoverse/mcpcat` and the installer always get certified code. The verdict line is a comment on the pull request and the `cert-review` commit status.

A pull request or merge group that touches the certification itself (the `cert-review` and `ci` workflows, `scripts/cert-review/` and `rows.json`, `scripts/cert.mjs`, `scripts/kernel-test-files.mjs`, and the cert-row, cert-gate, cert-review, cert-runner and cert-self-guard tests) fails `cert-review` with "needs coordinator review" until the label `cert-review-approved` is applied after its head arrived. The check is the shared [cert self-guard](https://github.com/ai-ecoverse/slicc-shared-web/tree/64467c916d5c6936992da7fad0be74b653bc303d/.github/actions/cert-self-guard), pinned to a full sha in `cert-review.yml`. Only the lane coordinator applies the label, after reading the diff; workers never add or remove it. Any push removes it, so every new head needs a fresh approval; a label change re-runs the checks but reuses the recorded cert-review verdict of an unchanged head. To re-check an approval, run the label event, not the earlier push. The label is procedural: every agent acts as one admin account, so the permission check cannot tell a coordinator from a worker, and a deliberate rewrite of the workflow is not stopped. The `kernel-cert-*` pins in `package.json` are not guarded, because the guard matches whole files and guarding `package.json` would hold every Renovate bump for approval.

## Quick start

```sh
mcpcat https://mcp.example.com/mcp
mcpcat weather get-forecast --lat 51.5 --lon -0.12
mcpcat serve --http 8808 ./scripts/jira.jsh
```

## License

Apache-2.0
