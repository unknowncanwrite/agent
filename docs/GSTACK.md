# gstack in NEXUS

[gstack](https://github.com/garrytan/gstack) is Garry Tan's opionated agent setup: 23+ slash-command
specialists that run a product sprint — **think → plan → build → review → test → ship → reflect** —
where each stage feeds the next (the design doc `/office-hours` writes is what `/plan-ceo-review`
reads, and so on).

NEXUS now ships that sprint as **29 skills** (a hub plus 28 stages) in its own skill format, wired
to NEXUS's real tools. Ported with attribution: gstack is MIT © 2026 Garry Tan. The port keeps
gstack's *method*, not its Claude-Code plumbing (no `~/.claude/skills` preambles, no telemetry, no
`AskUserQuestion` protocol) — every stage is written against tools this agent actually has.

## Try it right now

```bash
npm start          # then open http://localhost:3000
```

Type `/` in the message box: a menu lists every skill with its triggers and description. Pick one,
add your task, press Enter:

```
/gstack-office-hours I want to build a daily briefing app for my calendar
/gstack-investigate why does the publish step lose the site name?
/gstack-review review the change I just made to publish.js
/gstack-ship ship the paste feature
```

Or in a terminal:

```bash
curl -sN -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"/gstack-ship ship the paste feature"}],"chatId":"x","maxSteps":12}' \
  http://localhost:3000/api/smart | grep '"type":"skill"'
```

`/ship` and `/gstack-ship` are the same command; the bare name resolves to the pack.
The agent can also load a stage itself with the `use_skill` tool when a request looks like that
stage's work — the triggers below drive that.

## What each stage does

| Command | Specialist | What it does in NEXUS |
|---|---|---|
| `/gstack-office-hours` | YC Office Hours | the six forcing questions (`ask_user`), then a reframe, 3 approaches, and `DESIGN.md` |
| `/gstack-plan-ceo-review` | CEO | 4 scope modes, 10-section review, appends the decision to `DESIGN.md` |
| `/gstack-plan-design-review` | Designer | scores 10 dimensions 0-10, names what a 10 looks like, edits the plan |
| `/gstack-plan-devex-review` | DX Lead | personas, TTHW measured for real, friction trace, 3 modes |
| `/gstack-plan-eng-review` | Eng Manager | architecture, ASCII data flow, state machine, error paths, test matrix |
| `/gstack-autoplan` | Review pipeline | CEO → design → DX → eng in one pass, surfaces only taste decisions |
| `/gstack-spec` | Spec Author | 5 phases, code-reading mandatory, quality gate ≥7/10 before filing |
| `/gstack-review` | Staff Engineer | 4 passes (in parallel for big diffs), auto-fixes the obvious, verdict SHIP/FIX-FIRST/REWRITE |
| `/gstack-investigate` | Debugger | Iron Law: no fix without a reproduction and a causal chain; stops after 3 failed fixes |
| `/gstack-qa` `/gstack-qa-only` | QA | drives the real UI with `browser_interact` + screenshots, atomic fix commits, regression tests |
| `/gstack-cso` | Security | application model, supported findings, independent challenge, explicit coverage |
| `/gstack-ship` | Release | diff audit, full test run, commit, push, PR with coverage gaps stated |
| `/gstack-land-and-deploy` | Release | merge, watch CI/deploy with backoff, verify production health, roll back if red |
| `/gstack-canary` | SRE | post-deploy watch: console errors, latency, failed requests, baseline comparison |
| `/gstack-benchmark` | Performance | Core Web Vitals and resource sizes via `performance.getEntriesByType`, stored baselines |
| `/gstack-document-release` | Tech Writer | find every stale doc sentence, Diataxis coverage map in the PR body |
| `/gstack-document-generate` | Doc Author | write the missing quadrants from the code, verify every command runs |
| `/gstack-retro` | Eng Manager | shipped / test health / friction / growth, written to `RETRO.md` |
| `/gstack-learn` | Memory | review, merge, prune `remember` entries; promote durable ones into `NEXUS.md` |
| `/gstack-browse` | QA (eyes) | open a page, act deliberately, read the console, report the journey |
| `/gstack-scrape` | Data Extractor | extract structured data, verify the row count, freeze it into a script + fixture |
| `/gstack-design-consultation` | Design Partner | research 5-8 products, 3 directions with trade-offs, tokens + components, `DESIGN.md` |
| `/gstack-design-shotgun` | Design Explorer | 4-6 genuinely different variants, a comparison board, taste recorded via `remember` |
| `/gstack-design-html` | Design Engineer | mockup → semantic, responsive, dependency-free HTML with real states |
| `/gstack-design-review` | Designer who codes | live screenshots, scores, mechanical fixes, before/after re-score |
| `/gstack-make-pdf` | Publisher | markdown → `create_document` (pdf/docx/pptx/xlsx), verified not empty |
| `/gstack-diagram` | Diagram Maker | mermaid source + rendered image + the invariant it conveys |
| `/gstack` | the hub | the ethos (Boil the Ocean, Search Before Building, User Sovereignty, Build for Yourself), the reuse ladder, the sprint order, the voice rules |

## How it is wired

| Piece | Where |
|---|---|
| the playbooks | `skills/gstack*/SKILL.md` (hub + 28 stages), auto-discovered like every other skill |
| the catalogue | every system prompt lists them, so the model always knows they exist (`skills.js: catalogue()`) |
| trigger matching | a plain request like *"is this worth building"* surfaces `/gstack-office-hours` (`skills.js: match()`) |
| slash commands | `skills.js: expandCommand()` → `server.js: runSmart()` injects the playbook, emits a `skill` event, forces the agent loop |
| the API | `GET /api/skills` (light list) and `GET /api/skills?full=1` (with bodies) |
| the UI | `/` opens the menu; a `🧩 skill loaded` card shows which playbook a run is following (live and on replay) |
| the tests | `tests/08-gstack.test.mjs` (16 tests) |
| the live check | GitHub Actions → *live smoke test (deployment)* → Run workflow → `gstack` = `true` |

The mindset rules from gstack's instruction-only digest (ethos, reuse ladder, voice) live in the
hub skill, so `/gstack` is also the thing to load when you want the agent to *behave* like a
gstack agent without running a specific stage.

## What the port had to fix (found by the tests)

* **Job titles and memory were being polluted.** A slash command injects the whole playbook into
  the conversation, and the code that records a session's task took the *first* user message — so
  memory started storing "TASK: [SKILL /gstack-office-hours] …" and the next run's context was
  contaminated with it (which is how the tests caught it: a later stage matched the *previous*
  stage's text). There is now one helper, `taskOf(messages)` in `agent.js`, that skips the
  injected `[SKILL]`/`[CONTEXT]`/`[SUPERVISOR]` blocks and unwraps `[USER TASK]`; the job title,
  the memory record and the skill-trigger matching all use it.
* **Stage detection had to be explicit.** Injected playbook + memory means several `[SKILL …]`
  markers can be present in one conversation; the agents that consume a stage's own text must take
  the *last* marker, not "the one that appears somewhere".

## Differences from upstream gstack (on purpose)

* **Host machinery removed.** gstack ships shell preambles, telemetry, plan-mode rules and a
  Claude-Code-specific question protocol; NEXUS has no plan mode and asks with `ask_user`, so those
  stages are written as NEXUS workflows.
* **NEXUS tools instead of Claude Code tools.** `spawn_subagents` replaces parallel sub-agent
  fan-out, `browser_interact`/`screenshot` replace the Aside browser integration,
  `create_document` replaces the PDF toolchain, `think_parallel` replaces cross-model consultation,
  `remember`/`recall` replace the learnings store.
* **No evals/benchmark harness.** gstack's model evals are not ported — NEXUS already has
  `tests/` for that, and the pack is verified there (see `tests/REPORT.md`).

## Verify the pack yourself

```bash
node tests/run.mjs 08                       # 16 tests: the pack, the plumbing, the behaviour
node tests/run.mjs                          # everything (226 passed at the time of writing)
curl -s localhost:3000/api/skills | grep -c gstack
```

Against a live deployment, once this code is deployed:

> Actions → *live smoke test (deployment)* → **Run workflow** → set `gstack` to `true`.
> The run sends `/gstack-office-hours …` to the deployment, and prints an annotation with the
> loaded skill, the route, the tools used and the first line of the answer.
