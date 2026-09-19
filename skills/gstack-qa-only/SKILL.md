---
name: gstack-qa-only
description: QA reporter — the same audit as gstack-qa but report only, changing nothing.
triggers: qa report, just test it, find bugs but don't change code, report only, bug report
---

# /gstack-qa-only — QA Reporter

Adapted from gstack's `/qa-only` — [garrytan/gstack](https://github.com/garrytan/gstack), MIT © 2026 Garry Tan.

Identical method to `/gstack-qa` — real browser, real flows, real console — with a hard rule:

**Change nothing.** No edits, no commits, no "quick fixes" while you are in there. The user
asked for a report, usually because the change is being shipped by someone else or reviewed in
a PR.

## Method

1. Chart the flows (happy path, the two likely mistakes, the destructive action, the empty state).
2. Drive each in a real browser: `start_server` or the live URL, `browser_interact` per step,
   `screenshot` as evidence, console and failed requests captured with an `eval` action.
3. Reproduce every defect twice, then write it up:
   `severity | flow | steps to reproduce | expected | actual | evidence`.
4. State what you could NOT test and why (login-walled, needs a device, no test data). Silent
   gaps are the one thing a report cannot afford.
5. Do not file, do not fix, do not reformat — hand it back.

## Output

`DEFECTS: n (by severity)` · the evidence table · `NOT TESTED: <list + reason>` ·
`VERDICT: PASS | PASS WITH OPEN ISSUES | FAIL` — and a one-line note that no code was touched.