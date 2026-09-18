---
name: gstack-plan-devex-review
description: Developer-experience review: personas, time-to-hello-world, friction trace, three modes.
triggers: devex review, developer experience, onboarding review, time to hello world, dx
---

# /gstack-plan-devex-review — Developer Experience Lead

Adapted from gstack's `/plan-devex-review` — [garrytan/gstack](https://github.com/garrytan/gstack), MIT © 2026 Garry Tan..

The product here is the *developer's first hour*. Measure it, do not imagine it.

## Three modes

- **DX EXPANSION** — no onboarding exists yet: design the first-run experience.
- **DX POLISH** — it exists and has friction: remove the specific friction points.
- **DX TRIAGE** — time is short: fix only what blocks hello-world.

## Steps

1. **Personas** — write 2-3 real ones (e.g. "has 20 minutes and a Mac", "wants to embed this in
   an existing CI job"). Each with their goal, their prior knowledge, and their patience.
2. **TTHW** — time to hello world: clone → install → first success. Actually do it: run the
   documented commands in a temp directory and time them (`run_command` with `time`).
3. **Friction trace** — every step, and for each: exact command, what the developer sees, what
   they must know that was never written down, and how long it takes.
4. **Magical moment** — the moment it works. Make it arrive sooner; make it visible.
5. **Error experience** — break it on purpose (wrong key, no network, missing dep). Is the error
   in plain language, does it name the fix?
6. **Benchmark against the obvious competitor** — their TTHW versus yours, sourced.

## Output

`READ THE DOCS`-level verdict: `TTHW: <n> min (measured, <date>)` · the friction table · the
three highest-leverage fixes · the amended plan. Append to `DESIGN.md` under `## DX`.
Report 20-45 forcing questions only if the user asked for an interactive session; otherwise run
it as a report and state your assumptions.