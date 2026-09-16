# NEXUS test suite

A black-box + white-box test suite for this repository. It boots the **real**
`server.js` against a scripted mock model upstream, drives the real HTTP/SSE
endpoints, and reports every defect it finds as a *finding* (with severity) instead
of failing the run — so the suite can be run against a version that still has the
bugs described in `REPORT.md`.

```bash
cd /home/user/agent
npm install                # once
node tests/run.mjs         # all suites
node tests/run.mjs 04      # only suites whose filename matches "04"
node tests/run.mjs security
```

* exit code `0` = no failed assertions (findings do not fail the run)
* one suite per process (`run-one.mjs`), because the product keeps module-level state
* every suite runs inside a throwaway copy of the app under `/tmp` with
  `AGENT_WORKSPACE` pointing at a temp workspace — your repo and workspace are untouched

Last full run on this commit: **154 passed, 0 failed, 15 findings**.

## What is in here

| file | purpose |
|---|---|
| `run.mjs` | aggregate runner: discovers `*.test.mjs`, runs each in its own process, merges results, sorts findings by severity |
| `run-one.mjs` | runs a single suite and writes its JSON result |
| `lib.mjs` | assertions (`ok/eq/has/rejects`), `finding()` / `expectDefect()`, sandbox + server bootstrapping, HTTP/SSE clients |
| `mock-upstream.mjs` | OpenAI-compatible mock upstream: `/v1/models`, `/v1/chat/completions` (stream + non-stream), control API `POST /__ctl`, `GET /__requests`, `POST /__reset` |

### Suites

| suite | scope |
|---|---|
| `01-static.test.mjs` | repo sanity: every source parses, assets/launchers/skills exist, no committed credentials, repo hygiene |
| `02-units.test.mjs` | shell guards + `runStream`, memory, router (`heuristic`, `route`, `roleFor`), supervisor detectors `detect()`/`isFailure`/`tracker`, hooks, skills, mcp, jobs, and the agent tool implementations (`makeImpl`) |
| `03-models.test.mjs` | model catalogue, ranking/pick/chainFor, `sanitize`, quota/balance classification, `complete()` retries + failover, `streamWithFailover()` stall guard, `parallel()`, provider resolution |
| `04-server.test.mjs` | the real server end-to-end: SSE chat, `/api/smart` routing, the full autonomous loop (write → run → verify), parallel tool batches, unknown tool, `ask_user`, supervisor gates, maxSteps, jobs list/reattach/stop/duplicate, terminal, upload, workspace API + reset, memory, discovery endpoints |
| `05-security.test.mjs` | default jailed config vs `AGENT_FULL_ACCESS=true` (what the public deployment runs), auth surface, shell-guard coverage, hook injection, key-preview exposure |

### Mock upstream

Scenario control (`POST /__ctl` on the mock's origin, not under `/v1`):

```js
{ mode: "text" | "echo-system" | "badparam" | "fail500" | "quota" | "stall"
      | "agent" | "agent-slow-verify" | "agent-parallel" | "agent-loop"
      | "agent-unknown-tool" | "agent-ask" | "agent-prose"
      | "route-agent" | "route-chat",
  delayMs: 0, failModels: [], hangModels: [] }
```

Models served: `mock-max` (200k ctx, reasoning+tools+vision), `mock-flash` (32k),
`mock-plain` (128k), `mock-embedding-v1` (no tools), `mock-paid-max` (paid tier).

`GET /__requests` returns every completion request the mock received (model,
message roles, tool names, whether `temperature` was sent, …) — that is how the
retry/sanitising tests prove what actually went over the wire.

## Design notes (hard-won)

* **Fault isolation in suite 03.** `models.js` benches dead models/providers in
  process-global maps that are never reset. Each fault scenario therefore gets its
  *own* mock upstream, its own provider entry, and a *fresh* `models.js` module
  instance (`import(url + "?v=N")`). Sharing a provider between a quota test and a
  happy-path test produces phantom failures.
* **`forceAgent: true`** is passed for every scripted agent scenario — the mock
  classifier would otherwise route a build prompt to plain chat.
* **Timing.** Long-running scenarios need `ctl.state.delayMs > 0` to stay observable;
  the suite always resets it to `0` afterwards, otherwise later runs crawl.
* **`invalidateCache()`.** `write_file`/`edit_file`/`delete_file` invalidate the read
  and tree caches; the HTTP layer does not (see the stale-cache finding in 04).
* A defect that must be *proved* is written as `expectDefect(...)`: while the bug is
  present the suite prints a finding; once the bug is fixed the same test turns into
  a green `✓ (fixed)` line. Nothing here silently skips.

## Running against the live deployment

The suite is offline by default. To probe a deployment as well:

```bash
NEXUS_LIVE=https://agent-3tll.onrender.com node tests/run.mjs 05
```

That adds one extra check that reports whether an anonymous caller can read
`/etc/passwd` or get a shell on that host. It needs outbound network access (the
sandbox this was developed in blocks it, so the live result recorded in
`REPORT.md` comes from direct HTTP probes, not from this flag).
