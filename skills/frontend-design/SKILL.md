---
name: frontend-design
description: Produce distinctive, professional UI instead of generic AI-looking pages.
triggers: ui, frontend, design, page, website, component, css
---

# Frontend Design

## Avoid the AI-slop signature
Do NOT ship: centred purple gradient hero, Inter + generic card grid, emoji bullet lists,
`box-shadow: 0 4px 6px rgba(0,0,0,0.1)`, three equal feature cards, "Lorem ipsum"-grade copy.

## Do instead
- **Pick a real point of view**: editorial, brutalist, Swiss, terminal, glassmorphic, neo-retro. Commit to it.
- **Type**: one distinctive display face + one clean text face. Set real scale (1.25 or 1.333 ratio).
- **Colour**: one dominant, one accent, generous neutrals. Check contrast ≥ 4.5:1.
- **Space**: use an 8px grid. Whitespace is the cheapest way to look expensive.
- **Motion**: 150–250ms, ease-out, only on interaction. Never animate on load without reason.
- **Detail**: focus states, hover states, empty states, loading states, error states. These separate real from demo.

## Always verify
screenshot the result and judge it as a designer. Then browser_interact to confirm it functions.
If it looks generic, redo it — "works" is not the bar.