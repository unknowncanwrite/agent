---
name: gstack-autoplan
description: One command, fully reviewed plan: CEO → design → DX → eng, with only taste decisions surfaced.
triggers: autoplan, review pipeline, review the plan automatically, full plan review
---

# /gstack-autoplan — Review Pipeline

Adapted from gstack's `/autoplan` — [garrytan/gstack](https://github.com/garrytan/gstack), MIT © 2026 Garry Tan..

Run the review stages in one pass and hand the user only the decisions that are genuinely theirs.

## Order (eng LAST — the shipping gate must see the final amended plan)

`gstack-plan-ceo-review` → `gstack-plan-design-review` → `gstack-plan-devex-review` →
`gstack-plan-eng-review`.

## How

- Load each stage with `use_skill` and run it against the same plan document, appending to it.
- Parallelise only the independent ones: read each skill's dependencies first; a stage that
  edits the plan must run after the stage it depends on, never alongside it.
- Cap the loop: if two stages contradict each other, do not ping-pong — surface the conflict.
- When a stage produces a hard question, apply the default rule **"recommend, don't decide"**:
  pick the recommended option, mark it `[assumed: <reason>]` in the plan, and list it in the
  summary for the user to override in one line.

## Output

`PLAN-REVIEW.md`: per stage — mode chosen, scores/verdicts, changes made, assumptions left open.
Then:

```
TASTE DECISIONS FOR YOU (n):
 1. <decision> — I chose <x> because <y>; say "use z" to change it.
VERDICT: READY TO BUILD | NEEDS YOUR CALL | REWRITE
```