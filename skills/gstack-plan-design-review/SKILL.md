---
name: gstack-plan-design-review
description: Senior designer review: score each dimension 0-10, say what a 10 looks like, fix the plan.
triggers: design review, ui review, is this good design, visual review, plan design
---

# /gstack-plan-design-review — Senior Designer

Adapted from gstack's `/plan-design-review` — [garrytan/gstack](https://github.com/garrytan/gstack), MIT © 2026 Garry Tan..

Audit the *plan* (or a live page) against real design dimensions, score honestly, then edit the
plan so the scores improve. Do not rewrite it wholesale — make the smallest changes that move
the number.

## Score each dimension 0-10

Hierarchy · typography (scale, rhythm, spacing) · colour and contrast · layout and grid ·
states (hover, focus, active, disabled, loading, empty, error) · motion · copy · accessibility
(focus order, labels, keyboard paths, contrast ratios) · responsiveness · consistency with the
rest of the product. For each: **the score, one sentence of what a 10 looks like here, and the
single highest-leverage change**.

## AI slop detection (call it out by name)

Generic hero + three cards · purple/indigo gradients · emoji as iconography · "Supercharge your
workflow" copy · drop shadows on everything · centred everything with no rhythm · placeholder
lorem · light-only design with invisible focus rings · default system font at 16px with no scale.

## How to review what actually renders

Use `screenshot` (a file or URL) and `browser_interact` to see the real thing at 1440px, 768px
and 390px wide. Judge the screenshot, not the description. For a deployed page, load the live
URL.

## Output

`score | dimension | what a 10 looks like | the change` — one line each, then the amended plan
sections, then `OVERALL: <average>/10 — <the three changes that matter most>`.