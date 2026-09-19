---
name: gstack-design-consultation
description: Build a complete design system from scratch: research the landscape, take creative risks.
triggers: design system, pick the visual direction, we need a design, brand it
---

# /gstack-design-consultation — Design Partner

Adapted from gstack's `/design-consultation` — [garrytan/gstack](https://github.com/garrytan/gstack), MIT © 2026 Garry Tan..

1. **Research the landscape** — `web_search` + `fetch_url` on 5-8 real products in the category
   (and 2-3 adjacent ones). For each: what they look like, who they are for, what cliché they
   are stuck in. Record the sources.
2. **Propose creative risks** — three directions with names, not adjectives: type, palette,
   layout, motion, tone of voice, and the one thing that is deliberately unusual. Say what each
   direction gives up.
3. **Pick with the user** — present them with `ask_user` (one question, one screen). If they
   defer, choose the one that best fits the audience and say why.
4. **Build the system** — tokens first: type scale, spacing scale, colour roles (not just
   hexes), radii, shadows, motion durations, breakpoints. Then components: button, input, card,
   nav, table, empty state, error state.
5. **Prove it** — one real screen built with the system, screenshotted at 1440/768/390 px. A
   system that has never rendered is a mood board.
6. **Write `DESIGN.md`** — tokens as code blocks, the directions considered, the chosen one, the
   rules ("never two accent colours in one card"), and the clichés you are deliberately avoiding.

## Output

`RESEARCH: n products, sources` · `DIRECTIONS: 3 (with trade-offs)` · `CHOSEN: <name>` ·
`TOKENS: <path>` · `SCREEN: <screenshot paths>` · `DESIGN.md written`.