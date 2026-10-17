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

Every change that alters what mcpcat ships is certified before it reaches `main`. A pull request that touches `src/`, the build, the dependencies or the release workflows gets mcpcat's cert-review on a pack of its head, and again in the merge queue on the exact tree that lands on `main`; a FAIL blocks the merge. Docs-, test- and CI-only changes skip it as "not behaviour". Each merge to `main` is then released to npm as `latest` in one step by semantic-release, with provenance, so `npm install @ai-ecoverse/mcpcat` and the installer always get certified code. The verdict line is a comment on the pull request and the `cert-review` commit status. It reads `certified …`, `cert-ci: FAIL …` when the reviewer or a check in code found a defect (status `failure`), or `cert-ci: INCOMPLETE …` when the review couldn't decide: the review job didn't succeed or was skipped, no verdict could be read, or the artifact or the runner's own `gh` was missing (status `error`). A fork's change to shipped behaviour also reads INCOMPLETE, since it gets no review. INCOMPLETE never certifies; re-run the failed jobs. A run that ends without `record` posting its status (a crashed plan, record or verdict job) still posts one on the head: `error` with its INCOMPLETE line, `failure` for a FAIL, or `pending` while the coordinator approval is missing. So the required `cert-review` check never waits forever, and a label change reuses only a `success` or `failure` verdict, never an INCOMPLETE one. The reviewer's verdict can add defects but never clear one found in code: `record` re-reads the suites' evidence (`stage.json`, `suites.json`), uploaded before the reviewer runs and bound by the artifact id and digest the review job output. A suite or security row that failed on the host or a pinned kernel, a changed test that fails on the head, an import in the kernel bundle or an unexplained rebuild difference is a FAIL. Missing suites, kernels or rows are INCOMPLETE. A changed test that also passes on the base is named in the line as `gaps: no-negative <file>`. Every artifact a later job reads (the tarball, the verdict, the suites' evidence) is downloaded by the artifact id its producer output, after `bind.mjs` checks the artifact's name, run and digest against that producer's outputs. Any other artifact from this attempt of the run under `mcpcat-tarball-`, `mcpcat-npm-tarball-` or `cert-review-` makes the line INCOMPLETE. An earlier attempt's leftovers, created before this attempt started, are never read.

After each release, `cert-verify.yml` (on the Release run's success, or dispatched from `main` with a `version`) checks again that npm serves the SLSA subject built by `release.yml` on `main` from the tag, and that every pull request merged since the previous tag carries a green `cert-review` status on its head. Its hosted, write-only `notes` job then puts one line into the GitHub release notes, between `<!-- cert-verify -->` markers: `certified @ai-ecoverse/mcpcat@<version> sha256=<sha> (…; pr-certified since v<prev>: …)`, or `verified …` when some pull request lacks a green cert-review. A re-run with the same bytes leaves the notes as they are. Notes that already name another sha for the version, or npm bytes that don't verify, are a supply-chain alert: nothing is written and an issue is filed. Checks that couldn't run read `cert-ci: INCOMPLETE` and write nothing.

Silence never passes: every gate in the workflows prints a verdict line, and its caller requires that line, not just an exit code. These are `all-green: PASS|FAIL …`, the cert job's `cert: kernel <v> — N kernel tests passed`, shipped.mjs's `behaviour:`/`not behaviour:`, release verify's `verified …`, and the installer tests' `All installer tests passed.`. A gate that exits 0 without its line fails.

A pull request or merge group that touches the certification itself (the `cert-review` and `ci` workflows, `scripts/cert-review/` and `rows.json`, `scripts/cert.mjs`, `scripts/kernel-test-files.mjs`, and the cert-row, cert-gate, cert-review, cert-runner, cert-self-guard, cert-verify and cert-verdicts tests) fails `cert-review` with "needs coordinator review" until the label `cert-review-approved` is applied after its head arrived. The check is the shared [cert self-guard](https://github.com/ai-ecoverse/slicc-shared-web/tree/fe97ae242f8ddcc824334cad287346d7df3f0bbb/.github/actions/cert-self-guard), pinned to a full sha in `cert-review.yml`. Only the lane coordinator applies the label, after reading the diff; workers never add or remove it. Any push removes it, so every new head needs a fresh approval; a label change re-runs the checks but reuses the recorded cert-review verdict of an unchanged head. To re-check an approval, run the label event, not the earlier push. The label is procedural: every agent acts as one admin account, so the permission check cannot tell a coordinator from a worker, and a deliberate rewrite of the workflow is not stopped. The `kernel-cert-*` pins in `package.json` are not guarded, because the guard matches whole files and guarding `package.json` would hold every Renovate bump for approval.

## Quick start

```sh
mcpcat https://mcp.example.com/mcp
mcpcat weather get-forecast --lat 51.5 --lon -0.12
mcpcat serve --http 8808 ./scripts/jira.jsh
```

## License

Apache-2.0
