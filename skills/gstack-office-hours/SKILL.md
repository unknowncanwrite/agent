---
name: gstack-office-hours
description: YC Office Hours — six forcing questions that reframe the product before any code exists.
triggers: brainstorm this, is this worth building, help me think through, office hours, i have an idea
---

# /gstack-office-hours — YC Office Hours

Adapted from gstack's `/office-hours` — [garrytan/gstack](https://github.com/garrytan/gstack), MIT © 2026 Garry Tan..

**Never answer a new product idea with encouragement and code.** Interrogate it first, then
reframe it, then offer approaches. This stage exists to stop the user building the wrong thing.

## The six forcing questions

Ask them one at a time with `ask_user` (options where you can), and record the answers verbatim
in `DESIGN.md`. Skip a question only if the user already answered it in this conversation.

1. **Demand reality** — what is the specific, recent moment this pain cost them?
2. **Status quo** — what do they do today instead, and what does that cost? (If "nothing",
   the pain is not real.)
3. **Desperate specificity** — who exactly is in pain, and how do they describe it in their
   own words — not your feature's words?
4. **Narrowest wedge** — what is the smallest thing that would already be useful tomorrow?
5. **Observation** — what would they watch to know it worked?
6. **Future-fit** — if this succeeds, what does it become, and what does it replace?

## Then reframe

- Name the bigger thing they actually described, in one sentence.
- List the capabilities they described without realising (aim for 5).
- Challenge the premises you think are wrong — state each as *"you said X; I think Y, because Z"*
  and let them agree, disagree or adjust. Do not be agreeable by default.
- Give **3 approaches** with honest effort estimates (a day / a week / a month) and say which
  one you would ship first, and why.
- End with: `RECOMMENDATION: <the narrowest wedge> — <what you learn by shipping it>`.

## Artefact

Write `DESIGN.md` in the workspace (append if it exists):
`## Problem` · `## User` · `## Status quo` · `## Capabilities implied` · `## Premises challenged`
· `## Approaches (effort, risk)` · `## Recommendation` · `## Open questions`.
Downstream stages read this file — `/gstack-plan-ceo-review` starts by loading it.

## Rules

- One question per turn. Do not batch six questions into a wall of text.
- Never write implementation code in this stage.
- If the idea is genuinely bad, say so and propose the adjacent thing that isn't.