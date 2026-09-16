# ⚡ NEXUS

One chat box. It talks, builds, browses, and runs your computer.
See `ARCHITECTURE.md` for the design.

An autonomous multi-model AI agent that runs **on your own machine**. One prompt in → planned,
built, tested, visually verified result out. Watch every command it runs, live.

![status](https://img.shields.io/badge/node-%3E%3D18-green) ![platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-blue)

---

## Quick start

### Easiest — double-click

| OS | File |
|---|---|
| Windows | **`START-WINDOWS.bat`** |
| macOS / Linux | **`START-MAC-LINUX.sh`** |

It installs dependencies, creates your `.env`, and opens it so you can paste your API key.

### Manual

```bash
git clone https://github.com/unknowncanwrite/agent.git
cd agent
npm install
cp .env.example .env      # then EDIT it and set XKIRO_API_KEY=sk-...
npm start
```

Open **http://localhost:3000** and click **⚡ NEXUS Agent**.

Windows PowerShell:
```powershell
git clone https://github.com/unknowncanwrite/agent.git
cd agent
npm install
copy .env.example .env
notepad .env              # set XKIRO_API_KEY=sk-...
npm start
```

**You don't need to install Chromium.** The first time the agent uses a visual tool it
detects your existing Chrome/Edge, or downloads Playwright's Chromium automatically —
streaming the progress into the terminal panel. You can also click
**System → ⬇ Install Chromium** to do it up front.

---

## What makes it different

### 🧠 Multi-model parallel intelligence
Instead of one model guessing, NEXUS consults several **simultaneously**:

| Tool | What it does |
|---|---|
| `think_parallel` | Asks 2–4 different models the same hard question at once, then synthesizes the strongest reasoning |
| `delegate_parallel` | Splits independent subtasks across models and builds them concurrently |
| `review_code` | A second model critically reviews code before it's called done |

Roles are matched to models automatically — reasoning models plan, coder models write,
vision models look at screenshots.

### 💸 Free-first model selection
All 40+ free models are ranked by quality and **always tried before paid ones**. The
`free only` toggle in the header hard-locks the agent to free models. The picker groups
models as ★ FREE / PREMIUM / PAID with 👁 vision and 🧠 reasoning markers.

### 🔁 Never gives up
Every call has retry + automatic failover down a ranked chain. Failing models are
benched for 3 minutes. If a whole model family goes down mid-task, the agent switches
provider and keeps working — this was verified during a real outage.

### 🖥 Live terminal — see everything
Every command the agent runs streams **character by character** into the Terminal tab:
the command, working directory, stdout in white, stderr in red, and the real exit code.
There's a prompt at the bottom so you can run your own commands in the same session.

### 👁 Real eyes
`screenshot` renders a page in headless Chromium and feeds the **actual image back to the
model** as vision input. It's instructed to critique its own UI as a designer and fix what
looks wrong. `browser_interact` clicks, types and evaluates JS to prove the app functions.

### 🤖 JARVIS mode — full control of your PC

Flip the **🤖 JARVIS** toggle in the header (or set `AGENT_FULL_ACCESS=true` in `.env`) and
NEXUS operates your whole machine:

| Category | Tools |
|---|---|
| **Apps** | `open_app` · `close_app` · `list_apps` · `open_path` |
| **Files anywhere** | `find_files` (whole disk) · `known_folders` (Desktop/Downloads/…) · all file tools unrestricted |
| **Screen** | `screen_capture` — sees your *real* desktop, not just a browser |
| **Keyboard** | `type_text` · `press_keys` — drives the focused window |
| **Clipboard** | `clipboard_read` · `clipboard_write` |
| **Voice** | `speak` (talks aloud) · `notify` (desktop popup) |
| **System** | `system_stats` · `volume_control` · `power_control` (lock/sleep/shutdown/restart) |
| **Automation** | `schedule_task` · `list_scheduled` · `unschedule_task` |

All cross-platform — PowerShell on Windows, AppleScript on macOS, xdotool/amixer on Linux.

**Try:** *"Open VS Code and my project folder, check disk space, and tell me out loud when done."*

**Guardrails:** it confirms before deleting outside the workspace, shutting down, or mass file
operations. Shutdown/restart are delayed and cancellable (`power_control cancel`). Everything
else it just does. Toggle JARVIS off any time to snap back to workspace-only.

> Verified: asked for a status report, it pulled live system stats, resolved real folder paths,
> counted 930 `.js` files across the home directory, and wrote `jarvis-report.txt` to the
> **Desktop** — outside the sandbox folder.

### 🧬 Self-modifying
NEXUS can rewrite **its own source code** — and yours. Ask it to add a feature to itself and
it reads its code, patches it, syntax-checks, and restarts.

| Tool | Purpose |
|---|---|
| `read_own_code` | Read any of its own files |
| `write_own_code` / `patch_own_code` | Rewrite or patch itself |
| `self_test` | Syntax-check every source file |
| `self_diff` / `self_history` | Review what changed |
| `rollback_self` | Undo a self-edit |
| `restart_app` | Apply server-side changes live |

**Safety net:** every self-edit is git-snapshotted, then syntax-checked — a broken change is
**reverted automatically**. `.env`, `.git`, `node_modules` and `package-lock.json` are
protected, path traversal is blocked, and only whitelisted files are writable. The supervisor
(`start.js`) relaunches the server after `restart_app` and gives up after 5 rapid crash loops.

> Verified: asked to add a `count_lines` tool to itself, NEXUS read `agent.js`, patched both the
> schema and the implementation, self-tested, restarted, then **used the tool it had just written**.

### ⚡ Parallel execution (3.9x measured)
Read-only tools (`read_file`, `list_files`, `search_code`, `web_search`, `fetch_url`,
`screenshot`) issued in the same turn run **concurrently** through a bounded worker pool;
mutating tools stay strictly ordered so writes never race. Measured 2404ms → 619ms on an 8-task batch.

### 🗜 Never runs out of context
Conversations are compacted automatically: old tool outputs are summarised into a fact list
while the system prompt, original task and recent window are preserved — and never mid
tool-call pair. Measured 227k → 8k tokens on a 402-message run. Live counter in the cockpit.

### 🚀 Caching
File reads, directory trees and web searches are TTL-cached (15s / 8s / 5min), and writes
invalidate instantly.

---

## The Cockpit

A pinned right-hand dock — never scrolls away:

- **Stats** — step, tool count, elapsed timer, live status
- **📋 Plan** — the agent's own steps, animating `pending → active → done`
- **📡 Activity** — thinking, every tool with args/timing/output, inline screenshots, red bars on failure
- **▶ Terminal** — live streaming command output + your own prompt
- **🖥 System** — OS, shell, cores, RAM, and detected toolchain (node/python/git/docker/browser)

---

## Full tool list

**Files** `list_files` · `read_file` · `write_file` · `edit_file` · `delete_file` · `search_code`
**Execution** `run_command` · `start_server` · `list_processes` · `stop_server`
**Web** `web_search` · `fetch_url`
**Vision** `screenshot` · `browser_interact`
**Intelligence** `think_parallel` · `delegate_parallel` · `review_code`
**Meta** `update_plan` · `read_own_code` · `system_info`

---

## Configuration

| Variable | Default | Purpose |
|---|---|---|
| `XKIRO_API_KEY` | — | Your API key (required) |
| `XKIRO_BASE_URL` | `https://api.xkiro.com/v1` | OpenAI-compatible endpoint |
| `PORT` | `3000` | Web UI port |
| `AGENT_WORKSPACE` | `./workspace` | Where the agent builds |
| `AGENT_FULL_ACCESS` | `false` | Allow access beyond the workspace |

---

## Verified example

> *"Use think_parallel to decide the best approach, then build wordfreq.py that counts word
> frequencies and prints a bar chart. Write tests, run them, verify on a real file."*

The agent: planned 7 steps → consulted 3 models in parallel → wrote 177 lines + a 250-line
test suite → ran tests, **hit 3 failures**, diagnosed that `redirect_stdout` doesn't capture
`stderr` → patched the tests → **36/36 passing** → generated a sample file and verified the
CLI end-to-end. All while Qwen was down, so it failed over to DeepSeek and MiniMax mid-run.

```
python        ██████████████████████████████ 15
and           ██████████████████████ 11
is            ████████████████████ 10
```

---

## ⚠️ Safety

The agent runs **real commands on your machine**. Destructive patterns (`rm -rf /`, `mkfs`,
fork bombs, `Format-Volume`) are blocked and paths are confined to the workspace by default —
but with `AGENT_FULL_ACCESS=true` it can touch anything you can. Run it in a VM or container
if you're not comfortable with that. Never commit your `.env`.

## License

MIT

---

## 📦 Versioned builds

```bash
npm run build          # auto-increments: v3 -> v4
node build.js 7        # force a specific version
```

Produces `nexus-agent-v<N>.zip` and `nexus-agent-v<N>.bundle` one level up.
**The highest number is always the newest build.** The version is tracked in
`VERSION` and mirrored into `package.json`.

Excluded from every build: `node_modules`, `.git`, `.env`, `.pwlibs`,
`workspace/`, `public/shots/` — so no secrets or generated files ever ship.


---

## Troubleshooting

**No models in the dropdown / no chat reply** — open the **📜 Logs** tab in the cockpit; the
real error is printed there. Or click **System → 🩺 Run connection diagnostics**, which tests
your key and the upstream API and tells you exactly what is wrong.

**`OpenAIError: Missing credentials`** — no API key. The `.env` file is deliberately never
shipped (it would leak secrets). Copy `.env.example` to `.env` and set `XKIRO_API_KEY=sk-...`.
From v5 the supervisor detects this before booting and tells you exactly what to do.

**`Cannot find package 'x'`** — run `npm install`.

**`Port 3000 is already in use`** — from v6 NEXUS automatically tries 3001, 3002… and prints
the port it settled on. Just read the startup line for the right URL.

**Supervisor keeps restarting** — it now stops after 3 consecutive crashes and prints the
likely fix. The real error is the one *above* the supervisor message.

---

# v8 — feature comparison

Researched against Claude Code, Cursor, Devin, Codex, Copilot, Antigravity, Cline and OpenCode,
then closed every gap that mattered.

| Capability | Claude Code | Cursor | Devin | **NEXUS** |
|---|---|---|---|---|
| MCP servers | ✅ | ✅ | ❌ | ✅ |
| Parallel subagents | ✅ | ✅ (8) | ✅ | ✅ (6, nested) |
| Lifecycle hooks | ✅ (30 events) | ⚠️ | ❌ | ✅ (6 events) |
| Cross-session memory | ✅ | ⚠️ | ❌ | ✅ |
| Checkpoint / undo | ⚠️ git | ✅ | ❌ | ✅ per-write |
| Self-modifying code | ❌ | ❌ | ❌ | ✅ |
| Physical mouse/keyboard | ❌ | ❌ | ❌ | ✅ |
| Desktop app control | ❌ | ❌ | ❌ | ✅ |
| Screen vision | ❌ | ⚠️ browser | ❌ | ✅ full desktop |
| Browser automation | ⚠️ | ✅ | ✅ | ✅ |
| Multi-model routing | ❌ Claude only | ✅ | ❌ | ✅ 112 models |
| Model failover | ❌ | ❌ | ❌ | ✅ automatic |
| Free to run | ❌ $20/mo | ❌ $16/mo | ❌ $20+ | ✅ free tier |
| Open source | partial | ❌ | ❌ | ✅ |

## v13 — CRITIC auto-fixes, runs on the best model, learns from you

Three gaps closed from v12:

**🔧 Auto-fix, not just advice** — when the corrective action is unambiguous, CRITIC *executes
the tool itself* and hands the result to the agent, instead of only telling it what to do.
Guarded by a strict allowlist: `read_file`, `list_files`, `search_code`, `git_diff`, `git_status`,
`use_skill`, `recall`, `self_test`, `system_info`.
**Never** auto-runs a delete, a write, or a power action — verified.

**🧠 Master model** — CRITIC now resolves the strongest reasoning model available
(`plan` tier before `review` tier), so the watcher is smarter than the worker.

**📚 Learns from what you say** — previously it only learned from tool failures. Now it also
mines your corrections and preferences ("no, use plain CSS", "always run the tests first")
and stores them as durable lessons, even on a run where nothing failed.

## v12 — CRITIC supervisor + self-learning 🛡

A **second master agent watches every step** of the main agent, in parallel, and corrects it.

### Instant detectors (free, zero latency)
Run before every model call:

| Detector | Catches |
|---|---|
| `loop` | Same tool + same args 3× in 6 steps |
| `oscillation` | Ping-ponging A→B→A→B |
| `repeat_fail` | Same tool failing 3× — wrong approach, not wrong args |
| `error_streak` | 3 consecutive failures |
| `thrash` | Rewriting one file 4+ times instead of reading it |
| `unverified` | **Blocks completion** if it built something and never ran or looked at it |
| `stalled` | 6 steps with no concrete progress |

*All verified against synthetic runs; a properly-verified run passes clean.*

### CRITIC — the senior reviewer
Every 3 steps a **reasoning-tier model** reviews the trace **asynchronously** (never blocks).
It looks for wrong approaches, unverified claims, fabricated APIs, scope drift, security risk,
and giving up early — returning `ok` / `warn` / `intervene` with concrete guidance that is
injected straight into the agent's context.

### 🛰 Live agents panel
Click the **"N agents"** pill in the header to see every agent in flight: the primary agent,
CRITIC, and each subagent — with what tool each is running, tool counts, elapsed time and status.

### 🧠 Self-learning
After any run with failures or interventions, a model distils **durable lessons** into long-term
memory — environment quirks, your preferences, mistakes to avoid. They load automatically next
session, so the same mistake isn't repeated twice.

## v11 — UI overhaul, attachments, connectors

**🗂 Expandable sidebar** — it previously had *no expand mechanism at all*, just icon buttons.
Now: click ☰ or press **Ctrl+B**. Shows chat titles, live search (**Ctrl+K**), and per-chat delete.

**📎 Attachments** — click ＋, **drag & drop**, or **paste** straight into the composer.
- **Images** → sent to the vision model as real image parts (it sees them)
- **Text/code** → inlined into the prompt
- **Anything else** → uploaded to `workspace/uploads/` so the file tools can open it
Up to 10 files, 20 MB each. Chips show a thumbnail and are removable.

**🔗 Connectors panel** — one-click MCP integrations from the sidebar:
Files · GitHub · Postgres · SQLite · Slack · Knowledge-graph · Browser · Google Drive,
plus a custom-server form. Credentials are prompted for and stored locally in `mcp.json`.
*Verified: Files connector attached 14 live tools.*

## v10 — 83 tools · Android APK builds 📱

NEXUS can now produce **real, installable `.apk` files**.

| Tool | What it does |
|---|---|
| `android_status` | Is the toolchain ready? |
| `android_setup` | Auto-installs JDK 17 + Android SDK + build-tools (~500 MB, once) |
| `android_create` | Scaffolds a buildable project — `webview` (wrap a URL or bundled HTML) or `native` |
| `android_build` | Runs Gradle, returns the real `.apk` path and size |
| `android_install` | Pushes it to a USB-connected phone via adb |

**Zero setup on your side.** No Android Studio needed — the agent downloads and configures
the JDK, SDK, platform-34, build-tools and Gradle itself, streaming progress to the terminal.

The APK is **debug-signed**, so it installs on any phone with "unknown sources" enabled.
Finished builds appear as a download card right in the chat.

**Verified end-to-end:** built `app-debug.apk` (3.16 MB), confirmed with `aapt2 dump badging` —
`package=com.nexus.demo, minSdk=24, targetSdk=34`, valid APK Signing Block, and served correctly
through the download endpoint.

> The first build hit a real Kotlin stdlib duplicate-class conflict from appcompat. Fixed with a
> Gradle `resolutionStrategy` in the generated template, so your builds start clean.

**Best workflow for "make me an app":** the agent builds the UI as a web page, screenshots it to
verify it looks right, then wraps it in a WebView APK — you get a visually-checked app.

## v9 — 78 tools

**🎓 Skills** — methodology playbooks the agent loads on demand (Claude Code Skills, but auto-matched
to your task). Ships with `code-review`, `systematic-debugging`, `frontend-design`, `tdd`,
`deep-research`. `create_skill` teaches it your way of working permanently — stored in `skills/`.

**📄 Real deliverables** — `create_document` produces actual **.docx / .xlsx / .pptx / .pdf** files,
auto-installing the Python library. Manus's headline capability; no other coding agent ships this.
*Verified: all four formats generated and opened cleanly.*

**📊 Data analysis** — `analyze_data` profiles CSV/Excel/JSON/Parquet with pandas (shape, dtypes,
summary stats, missing values, top categories) and renders a chart PNG **the agent then looks at**
with its vision. *Verified: correct aggregation, chart rendered.*

**🌳 Git suite** — `git_status`, `git_diff`, `git_commit` (conventional commits), and
`git_worktree` so parallel subagents work on isolated branches instead of colliding — the
technique Cursor and Claude Code use for parallel agents. *Verified end-to-end.*

**🏗 Scaffolding** — `scaffold_project` for next / vite-react / vite-vue / express / fastapi / python,
plus `install_packages` with clear failure reporting.

## New in v8

**🧠 Persistent memory** — `remember`, `recall`, `forget`, `write_project_notes`.
Facts, preferences and project knowledge survive restarts and are injected into every session.
`NEXUS.md` is a human-editable brief the agent reads first.

**👥 Parallel subagents** — `spawn_subagents` runs up to 6 independent agents at once, each with
full tools and its own model. Nesting is capped at depth 2 to prevent runaway spawning.

**🔌 MCP client** — connect any Model Context Protocol server (GitHub, Postgres, Slack, filesystem…).
Their tools appear as `mcp__<server>__<tool>`. Configure in `mcp.json` or call `mcp_add`.
*Verified live against `@modelcontextprotocol/server-filesystem`: 14 tools, real call succeeded.*

**🪝 Hooks** — run shell commands on `before_tool`, `after_tool`, `before_write`, `after_write`,
`session_start`, `session_end`. A non-zero `before_*` hook **blocks** the action — real guardrails.
Configure in `hooks.json`. Example: auto-run prettier after every `.js` write.

**↩️ Checkpoints** — every write/edit/delete is snapshotted first.
`undo_last_change`, `list_checkpoints`, `restore_checkpoint`. Instant rollback of any change.

**❓ ask_user** — a real clarify-and-wait tool with clickable options, for genuinely blocking
decisions only. The agent halts rather than guessing.

## Config files

| File | Purpose |
|---|---|
| `NEXUS.md` | Project brief the agent reads every session |
| `mcp.json` | MCP servers to connect |
| `hooks.json` | Lifecycle hook commands |
| `.memory/` | Long-term facts + session history |
| `.checkpoints/` | File snapshots for undo |
