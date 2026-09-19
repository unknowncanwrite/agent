---
name: gstack-design-review
description: Designer who codes: audit the live UI, then fix what it finds with atomic commits.
triggers: fix the design, the ui looks off, make it look good, design pass
---

# /gstack-design-review — Designer Who Codes

Adapted from gstack's `/design-review` — [garrytan/gstack](https://github.com/garrytan/gstack), MIT © 2026 Garry Tan.. This is
`/gstack-plan-design-review` applied to the running product, with fixes.

1. **See it first** — real screenshots at 1440/768/390 px of the real page (live URL or a started
   dev server). No review from source code alone.
2. **Score the dimensions** (hierarchy, type, colour/contrast, layout, states, motion, copy,
   accessibility, responsiveness, consistency) 0-10, with what a 10 looks like and the
   highest-leverage change for each.
3. **Fix mechanically first** — spacing that ignores the scale, missing focus rings, contrast
   below 4.5:1, inconsistent radii, an unstyled empty state. Small, safe, visible wins.
4. **Atomic commits** — one concern per commit (`fix(ui): focus ring on the primary button`), and
   re-screenshot after each so the before/after is real.
5. **Big changes get a question** — hierarchy or brand-level changes go to the user with the
   before/after images and your recommendation.
6. **Re-score** — the same dimensions after the pass, so the improvement is measurable.

## Output

`BEFORE/AFTER: <screenshot pairs + scores>` · `FIXED: <commits>` · `ASKED: <decisions>` ·
`REMAINING: <what you did not change and why>`.