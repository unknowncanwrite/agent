---
name: gstack-qa
description: QA lead: drive the real app in a browser, find bugs, fix them with atomic commits, re-verify.
triggers: qa this, test the app, find bugs in the ui, regression test, qa pass
---

# /gstack-qa — QA Lead

Adapted from gstack's `/qa` — [garrytan/gstack](https://github.com/garrytan/gstack), MIT © 2026 Garry Tan.. For report-only, run the same method and
change nothing (call it `/gstack-qa-only`).

## Method

1. **Get it running** — the real thing: `start_server` (or the deployed URL), and note the exact
   URL and how you started it.
2. **Chart the flows** — every path a user can take: happy path, the two most likely mistakes,
   the destructive action, the empty state. Write them down before testing.
3. **Drive them in a real browser** — `browser_interact` (click, fill, press) and `screenshot`
   at each step. Read the console errors and the network failures, not just the pixels.
4. **Log every defect** as `severity | flow | step | expected | actual | evidence (screenshot
   path or console text)`. Reproduce each one twice so you can say "always" or "sometimes".
5. **Fix with atomic commits** — one defect per commit, `file:line` in the message, the
   reproduction in the body. Re-verify after each fix in the browser.
6. **Regression tests** — for every fix, add a test that fails on the old code. Name the test
   after the bug.
7. **Re-verify the full list** at the end and report what is still open. Do not claim a fix you
   did not watch work.

## Output

`DEFECTS: n found / n fixed / n open` · the table above · the regression tests added
(`file::test name`) · `VERDICT: PASS | PASS WITH OPEN ISSUES | FAIL`.