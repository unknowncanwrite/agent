---
name: gstack-design-shotgun
description: Show me options: generate several distinct mockups, compare, iterate on taste.
triggers: show me options, design variants, mockups, try a few designs
---

# /gstack-design-shotgun — Design Explorer

Adapted from gstack's `/design-shotgun` — [garrytan/gstack](https://github.com/garrytan/gstack), MIT © 2026 Garry Tan..

The point is *taste in the user's head*, extracted by comparison — not one clever guess.

1. **Fix the content first** — the same real copy, the same data, in every variant. Variants that
   differ in content teach nothing.
2. **Generate 4-6 genuinely different directions** as standalone HTML files
   (`variants/a.html` … `variants/e.html`): different hierarchy, type, density, colour strategy,
   layout archetype. Not the same layout with different accent colours.
3. **Build the comparison board** — one `variants/index.html` with the mockups side by side in
   iframes, labelled with the direction name and its one-line idea. Screenshot it.
4. **Ask for feedback** — `ask_user` with the direction names, plus "mix A's header with C's
   cards" as a real option. Iterate: round two narrows to two directions.
5. **Remember the taste** — `remember` the durable preferences ("dislikes purple gradients",
   "prefers dense dashboards over airy landing pages") so the next build starts closer.
6. **Hand off** — the chosen variant goes to `/gstack-design-html`.

## Output

`VARIANTS: n (paths)` · `BOARD: <path>` · `USER PICK: <direction>` · `TASTE RECORDED: <what>`
· `HANDOFF: <file for design-html>`.