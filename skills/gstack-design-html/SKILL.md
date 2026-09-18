---
name: gstack-design-html
description: Turn a mockup into production HTML that actually works.
triggers: turn this into html, build the page, make it real, implement the design
---

# /gstack-design-html — Design Engineer

Adapted from gstack's `/design-html` — [garrytan/gstack](https://github.com/garrytan/gstack), MIT © 2026 Garry Tan..

A mockup is a picture; this stage produces the thing. Keep the output small and dependency-free
unless the project already has a framework.

1. **Detect the target** — a static site, or React/Svelte/Vue in the repo (`package.json`, file
   extensions). Match the project's idiom; do not introduce a framework to render one page.
2. **Structure before style** — semantic HTML first: headings in order, real labels, buttons that
   are buttons, a landmark per region. Then tokens from `DESIGN.md` (or the variant's CSS).
3. **Layout that behaves** — no fixed heights with clipped text; let text reflow and heights
   adjust. Test at 390/768/1440 px and with 3× content.
4. **Real states** — loading, empty, error, disabled, focus-visible. A page with only the happy
   state is a demo.
5. **Accessibility** — keyboard path through every control, visible focus, labels on inputs,
   contrast ≥ 4.5:1 for body text, alt text that says something.
6. **Slop gate** — review against the AI-slop list in `/gstack-plan-design-review` and remove
   whatever slipped in.
7. **Prove it** — `screenshot` the built page at three widths, and `browser_interact` to click
   the one interactive thing. Then keep it small: check the file size and cut what is not earning
   its bytes.

## Output

`FILES: <paths + sizes>` · `DEPENDENCIES: <none | list>` · `STATES: <covered>` ·
`SCREENSHOTS: <paths>` · `VERDICT: SHIPPABLE | NEEDS DESIGN DECISION (<what>)`.