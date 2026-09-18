---
name: gstack-retro
description: Engineering retrospective: what shipped, streaks, test health, growth opportunities.
triggers: retro, retrospective, how did this week go, what did we ship
---

# /gstack-retro — Eng Manager

Adapted from gstack's `/retro` — [garrytan/gstack](https://github.com/garrytan/gstack), MIT © 2026 Garry Tan..

Look at evidence, not vibes. The git log, the test runs, the jobs list, the memory.

1. **Gather** — `run_command` for `git log --stat` over the window, the real test-suite results,
   `GET /api/jobs` (or `run_command` with `curl localhost:463/api/jobs`) when NEXUS ran the work,
   the workspace diff, and `recall` for what previous sessions learned. Count, do not estimate.
2. **What shipped** — one line per meaningful change: what changed for the user, and the commit.
   Split real features from chores; do not pad the list.
3. **Test health trend** — passed/failed per run over the window, tests added, tests deleted
   (a deleted test is a headline, not a footnote), the slowest suite.
4. **Friction and waste** — repeated failures, rework of the same file, work started and
   abandoned, time lost to broken environments. Name the pattern, not the incident.
5. **Per-contributor** (when the repo has more than one) or per-project breakdown.
6. **Growth opportunities** — two or three, concrete: a skill to write, an automation to add, a
   habit to drop. Each with the first step.
7. **One change for next week** — the smallest one that would have prevented the worst friction.

## Output

`RETRO.md`: `## Shipped` · `## Test health` · `## Friction` · `## Growth` · `## Next week: one
change`. Keep it under a page — a retro nobody reads is a chore.