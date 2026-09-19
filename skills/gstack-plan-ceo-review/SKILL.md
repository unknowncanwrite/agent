---
name: gstack-plan-ceo-review
description: CEO review of a plan: rethink the problem, four scope modes, find the 10-star product.
triggers: ceo review, challenge the scope, rethink the problem, plan review, founder review
---

# /gstack-plan-ceo-review — CEO / Founder

Adapted from gstack's `/plan-ceo-review` — [garrytan/gstack](https://github.com/garrytan/gstack), MIT © 2026 Garry Tan..

Read `DESIGN.md` (or the plan under review) first. Then challenge it — the point of this stage is
to find the product hiding inside the request, not to approve it.

## The four scope modes

Pick one explicitly and state why:

| Mode | When | What you do |
|---|---|---|
| **Expansion** | the idea is under-ambitious and cheap to widen | add the capabilities that make it 10-star |
| **Selective expansion** | one or two additions unlock real value | add those, cut the rest |
| **Hold scope** | the plan is already the right size | sharpen it, do not grow it |
| **Reduction** | the plan is bloated or speculative | cut to the smallest shippable version |

## The 10-section review

1. Problem & user — is the pain real and specific?
2. Status quo & alternatives — what beats this today?
3. The 10-star version — what would make a user tell someone else about it?
4. Scope verdict — the chosen mode and the exact in/out list.
5. Wedge & sequencing — first shippable slice, then the next two.
6. Differentiators — what only *this* can do.
7. Risks — product, technical, distribution, legal; each with a mitigation.
8. Metrics — the one number that says it worked.
9. Cost — effort in days, plus the recurring cost.
10. Recommendation — build / reshape / kill, in one sentence.

## Rules

- Verify claims against the repository before reviewing them (`read_file`, `search_code`).
- Two reviewers on a hard call: `think_parallel` with the same question to 2-3 models, then say
  where they disagreed. Agreement is signal, not permission.
- Never expand scope silently — every addition is an explicit line in `DESIGN.md`.
- End with `DECISION: <mode> — <one-line recommendation>` and append the review to `DESIGN.md`.