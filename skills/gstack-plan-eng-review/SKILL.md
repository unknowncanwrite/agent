---
name: gstack-plan-eng-review
description: Eng manager review: architecture, data flow, diagrams, edge cases, test matrix, failure modes.
triggers: eng review, architecture review, how should we build it, technical plan, data flow
---

# /gstack-plan-eng-review — Eng Manager

Adapted from gstack's `/plan-eng-review` — [garrytan/gstack](https://github.com/garrytan/gstack), MIT © 2026 Garry Tan..

Turn the plan into something an engineer can execute without asking questions. Read the actual
code first — a plan reviewed without reading the code is fiction.

## What this stage must produce

1. **Architecture** — the modules/files that change, and the contract between them.
2. **Data flow** — an ASCII diagram of one real request or task through the system, start to end.
3. **State machine** — every state a job/resource can be in, and every allowed transition.
4. **Error paths** — for each step: what fails, what the user sees, what is retried, what is
   logged. Timeouts and partial failure included.
5. **Edge cases** — empty inputs, huge inputs, unicode, concurrent runs, restarts mid-work.
6. **Test matrix** — unit / integration / end-to-end rows against the cases above. Name the
   test files you will write.
7. **Failure modes** — what breaks in production, how you would notice, how you would recover.
8. **Migration & rollback** — what existing users/data need, and how to undo a bad deploy.
9. **Security** — anything user-controlled reaching a shell, a path or a query.
10. **Open assumptions** — every "we assume X" written down so it can be falsified.

## Rules

- Read the real code (`read_file`, `search_code`) and cite `file:line` for each claim about
  current behaviour. Never plan against an imagined codebase.
- Quantify: "3 queries per request", "1500-line file", "adds 40ms" — not "fast" or "large".
- Prefer the reuse ladder: existing helper → stdlib → platform feature → existing dependency.
- The test plan is mandatory. "We'll test it later" is not a test plan.
- End with `VERDICT: BUILDABLE | NEEDS-DECISION | UNDERSPECIFIED` plus the blocking questions.