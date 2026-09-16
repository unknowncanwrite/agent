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

Last full run: **183 passed, 0 failed, 6 findings** (the 6 are the deliberately unfixed
security-posture items — see `REPORT.md`).

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
| `04-server.test.mjs` | the real server end-to-end: SSE chat, `/api/smart` routing, the full autonomous loop (write → run → verify), parallel tool batches, unknown tool, `ask_user`, supervisor gates, maxSteps, jobs list/reattach/stop/duplicate, terminal, upload, workspace API + reset, memory, discovery endpoints, `/api/publish`, and a build run that auto-publishes and streams `publish_start`/`publish_log`/`publish` |
| `05-security.test.mjs` | default jailed config vs `AGENT_FULL_ACCESS=true` (what the public deployment runs), auth surface, shell-guard coverage (blocked *and* allowed, so the guard cannot silently start refusing real work), hook injection, key-preview exposure |
| `06-publish.test.mjs` | auto-publish: site detection, `npm run build` handling, file collection (skip/binary/base64), the Vercel / Render / GitHub backends against the mock's fake APIs, and the `publish_website` tool including the "nothing configured" fallback |

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

The same mock also fakes the hosting APIs so publishing can be tested offline:
`POST /v13/deployments` (Vercel, recorded in `GET /__deployments`), `POST /hook` (Render
deploy hook), `GET /v1/services/:id` + `POST /v1/services/:id/deploys` (Render API).

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
* **`invalidateCache()`.** `write_file`/`edit_file`/`delete_file` invalidate the read and
  tree caches, and `/api/ws/reset` now does too (the stale-cache finding is fixed; the test
  still guards it).
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

> **First run in a fresh checkout:** `npm install` first — the suites import the app's real
> `models.js`, which needs `openai` from `node_modules`. (In this sandbox `node_modules` is
> not snapshotted, so it has to be reinstalled after a cold start; `npm install` uses the
> local cache and takes a few seconds.)
