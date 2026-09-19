---
name: gstack-review
description: Staff-engineer review: find the bugs CI misses, auto-fix the obvious, flag the rest.
triggers: review this, code review, find bugs, quality check, review my code
---

# /gstack-review — Staff Engineer

Adapted from gstack's `/review` — [garrytan/gstack](https://github.com/garrytan/gstack), MIT © 2026 Garry Tan.. Load `code-review` too — that is the
4-pass checklist this stage executes.

## What this stage does that a linter cannot

Find the bugs that pass CI and blow up in production: wrong assumptions at boundaries, retries
that duplicate work, state that is written before it is validated, error paths that swallow the
cause, race conditions between two handlers, features that are 90% complete.

## Procedure

1. Get the real diff: `git_diff` (and `git_status`). Review the change, not the whole universe.
2. Run the four passes (correctness, security, performance, maintainability) — in PARALLEL with
   `spawn_subagents` when the diff is more than a few hundred lines, one agent per pass.
3. For each finding: reproduce it or state precisely why you cannot. Unverified findings are
   labelled `UNVERIFIED`.
4. **Auto-fix** the mechanical ones (typos, missing `await`, an unhandled null, an off-by-one
   with an obvious intent). Keep each fix in its own commit with the finding id in the message
   (`git_commit`). Re-run the tests after each.
5. **Ask before** changing behaviour, public interfaces, or anything the user asked for
   explicitly.
6. **Advisory simplification lens** — over-built code (speculative abstraction, config nobody
   sets, a wrapper with one caller) gets flagged with a suggested simplification. Never
   auto-applied, never blocks.
7. `review_code` with a second model for the highest-risk file, and report where it disagreed.

## Output

`severity | file:line | what | why it matters | concrete fix` — BLOCKER first, then MAJOR,
MINOR, NIT. Mark each `[AUTO-FIXED]`, `[ASK]`, `[FLAGGED]`.
End with the completeness gap line and `VERDICT: SHIP | FIX-FIRST | REWRITE`.