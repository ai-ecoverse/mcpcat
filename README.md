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

Every change that alters what mcpcat ships is certified before it reaches `main`. A pull request that touches `src/`, the build, the dependencies or the release workflows gets mcpcat's cert-review on a pack of its head, and again in the merge queue on the exact tree that lands on `main`; a FAIL blocks the merge. Docs-, test- and CI-only changes skip it as "not behaviour". A draft pull request is not reviewed: its `cert-review` is red with `draft: not reviewed, mark it ready for review`, and marking it ready starts the review (converted_to_draft cancels a running one). Mark ready = reviewed, and merges on green; a pull request held for anything stays a draft. For a PR that needs the coordinator's security read, the order is: the coordinator reads the draft, it is marked ready, the cert runs, then the queue. Each merge to `main` is then released to npm as `latest` in one step by semantic-release, with provenance, so `npm install @ai-ecoverse/mcpcat` and the installer always get certified code. The verdict line is a comment on the pull request and the `cert-review` commit status. It reads `certified …`, `cert-ci: FAIL …` when the reviewer or a check in code found a defect (status `failure`), or `cert-ci: INCOMPLETE …` when the review couldn't decide: the review job didn't succeed or was skipped, no verdict could be read, or the artifact or the runner's own `gh` was missing (status `error`). A fork's change to shipped behaviour also reads INCOMPLETE, since it gets no review. INCOMPLETE never certifies; re-run the failed jobs. A run that ends without `record` posting its status (a crashed plan, record or verdict job) still posts one on the head: `error` with its INCOMPLETE line, or `failure` for a FAIL. So the required `cert-review` check never waits forever. The reviewer's verdict can add defects but never clear one found in code: `record` re-reads the suites' evidence (`stage.json`, `suites.json`), uploaded before the reviewer runs and bound by the artifact id and digest the review job output. A suite or security row that failed on the host or a pinned kernel, a changed test that fails on the head, an import in the kernel bundle or an unexplained rebuild difference is a FAIL. Missing suites, kernels or rows are INCOMPLETE. The NEGATIVE runs each changed test on the base's code: the subject's tests, helpers and fixtures with the base's `dist`, `scripts/` and `.github/workflows/`, all from the base sha, so a test of the cert tooling runs against main's tooling. The record names both shas. A changed test that also passes on the base is named in the line as `gaps: no-negative <file>`. Every artifact a later job reads (the tarball, the verdict, the suites' evidence) is downloaded by the artifact id its producer output, after `bind.mjs` checks the artifact's name, run and digest against that producer's outputs. Any other artifact from this attempt of the run under `mcpcat-tarball-`, `mcpcat-npm-tarball-` or `cert-review-` makes the line INCOMPLETE. An earlier attempt's leftovers, created before this attempt started, are never read.

After each release, `cert-verify.yml` (on the Release run's success, or dispatched from `main` with a `version`) checks that npm serves the SLSA subject built by `release.yml` on `main` from the tag, and that every pull request merged since the previous tag carries a green `cert-review` status on its head. Its hosted, write-only `notes` job then puts one line into the GitHub release notes, between `<!-- cert-verify -->` markers: `certified @ai-ecoverse/mcpcat@<version> sha256=<sha> (…; pr-certified since v<prev>: …)`, or `verified …` when some pull request lacks a green cert-review. A re-run with the same bytes leaves the notes as they are. Notes that already name another sha for the version, or npm bytes that don't verify, are a supply-chain alert: nothing is written and an issue is filed. Checks that couldn't run read `cert-ci: INCOMPLETE` and write nothing.

Silence never passes: every gate in the workflows prints a verdict line, and its caller requires that line, not just an exit code. These are `all-green: PASS|FAIL …`, the cert job's `cert: kernel <v> — N kernel tests passed`, shipped.mjs's `behaviour:`/`not behaviour:`, and the installer tests' `All installer tests passed.`. A gate that exits 0 without its line fails.

## Quick start

```sh
mcpcat https://mcp.example.com/mcp
mcpcat weather get-forecast --lat 51.5 --lon -0.12
mcpcat serve --http 8808 ./scripts/jira.jsh
```

## Agent skill

The package ships an [Agent Skill](https://agentskills.io/specification) that teaches an agent mcpcat in one file: `dist/skills/mcpcat/SKILL.md`, built from [`src/skill/SKILL.txt`](src/skill/SKILL.txt) (the repo keeps no Markdown besides README.md and AGENTS.md). It covers targets, listing and calling tools, `mcp.json`, exit codes, and the secrets rule: `${NAME}` placeholders in single quotes, never a value in a command, a file or the conversation, and never a token in `mcp.json`. `mcpcat help --skill` prints the copy that matches the installed version. `package.json` declares it as a pi package skill (`"pi": { "skills": ["dist/skills"] }`). In seven, bios links it into `/usr/share/skills` for the certified catalog install. It is shipped behaviour under `src/`, so a change to it gets a cert review.

## License

Apache-2.0
