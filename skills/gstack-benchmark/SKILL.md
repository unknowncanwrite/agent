---
name: gstack-benchmark
description: Performance engineer: baseline load times, Core Web Vitals and resource sizes.
triggers: benchmark this, measure performance, core web vitals, is it fast, page speed
---

# /gstack-benchmark — Performance Engineer

Adapted from gstack's `/benchmark` — [garrytan/gstack](https://github.com/garrytan/gstack), MIT © 2026 Garry Tan..

Numbers or it did not happen. Measure before and after on every performance claim.

## Method

1. **Baseline first** — before changing anything, measure the current state. Store it as JSON in
   the workspace (`bench/<name>-<date>.json`) so the next run can compare.
2. **Measure in a real browser** (`browser_interact` with an `eval`):
   - `performance.getEntriesByType("navigation")[0]` → TTFB, DOMContentLoaded, load.
   - `performance.getEntriesByType("paint")` → first paint, first contentful paint.
   - `performance.getEntriesByType("largest-contentful-paint")` via the observer where available.
   - `performance.getEntriesByType("resource")` → count, total transfer size, the heaviest five.
   - Layout shift: `performance.getEntriesByType("layout-shift")`.
3. **Repeat** — 3 runs minimum, report the median and the spread. One run is an anecdote.
4. **Compare** against the stored baseline and against a real competitor if relevant.
5. **Attribute** — for each regression, name the resource or the code path responsible. A number
   without a cause is not actionable.
6. **Report the budget**: target ms and KB, current, delta.

## Output

`METRIC | BEFORE | AFTER | DELTA` · the heaviest resources table · `BUDGET: pass/fail` ·
`TOP FIX: <the single change with the biggest measured win>`.