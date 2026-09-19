---
name: gstack-canary
description: Post-deploy monitoring loop: console errors, performance regressions, page failures.
triggers: watch the deploy, canary, monitor production, is it stable after deploy
---

# /gstack-canary — SRE

Adapted from gstack's `/canary` — [garrytan/gstack](https://github.com/garrytan/gstack), MIT © 2026 Garry Tan..

The deploy is not the finish line; the next few minutes are.

1. **Define the window and the checks** before you start: how long to watch (default: 5-10
   minutes or 20 requests), which URLs, which signals count as failure.
2. **Loop** — every 30-60 s, in the background where possible: fetch each URL, record status,
   latency, body size, and page errors. In a browser, capture console errors and failed
   requests (`browser_interact` with an `eval` that returns `performance.getEntriesByType`).
3. **Compare** to the baseline you have (the `/gstack-benchmark` numbers, or the pre-deploy run).
   A 20% latency jump and a new console error are both regressions.
4. **Report, do not fix blindly** — for a regression: the evidence, the most likely cause from
   the diff, and the rollback option. Fix forward only if the cause is obvious and the fix is
   small.
5. **Close with the verdict and the monitored window** so the claim is checkable.

## Output

`WINDOW: <start-end> · REQUESTS: n` · `ok: n | errors: n | slow: n` · `REGRESSIONS` (with
evidence) · `BASELINE COMPARISON` · `VERDICT: STABLE | DEGRADED (<what>) | BROKEN (<what>)`.