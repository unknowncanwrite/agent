---
name: gstack-spec
description: Turn vague intent into a precise executable spec, with a quality gate before it is filed.
triggers: write a spec, spec this out, turn this into a spec, rfc, requirements
---

# /gstack-spec — Spec Author

Adapted from gstack's `/spec` — [garrytan/gstack](https://github.com/garrytan/gstack), MIT © 2026 Garry Tan..

Five phases, in order. Do not skip phase 3 — a spec written without reading the code is a wish.

1. **Why** — the problem, the user, the evidence it is real (link to `DESIGN.md` if it exists).
2. **Scope** — what is in, what is explicitly out, and the smallest shippable slice.
3. **Technical** — *after* reading the actual code: the files to change (with `file:line`), the
   interfaces, the data shapes, the failure behaviour, the tests. Cite what you read.
4. **Draft** — the spec document: why, scope, technical, alternatives considered, risks,
   rollout, open questions.
5. **File** — write `SPEC.md` (or the requested path). Then run the quality gate.

## Quality gate (before you present it)

- `review_code` on the spec's technical section, asking for missing cases and unsafe
  assumptions — or `think_parallel` if the change is architectural.
- Score 0-10 for: testability, completeness, unambiguity, reversibility. **Below 7/10 average:
  fix and re-score, do not ship the spec.**
- Redaction: no API keys, tokens, absolute personal paths or customer names in the spec.
- Dedupe: `search_code` for an existing spec/issue covering the same ground before writing.
- Every requirement is one testable sentence. Cut adjectives.

## Output

`SPEC.md` written · `GATE: <score>/10` · the three weakest sections and what would fix them.