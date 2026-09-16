---
name: tdd
description: Test-driven development loop: red, green, refactor.
triggers: tdd, test first, unit test, write tests
---

# TDD Loop

1. **RED** — write the smallest failing test that expresses the next behaviour. Run it. Confirm it fails
   for the RIGHT reason (not an import error).
2. **GREEN** — write the minimum code to pass. Do not add unrequested features.
3. **REFACTOR** — clean up with tests green. Rerun after every change.
4. Repeat.

Rules:
- One behaviour per test. Name tests as sentences: `returns_empty_list_when_no_matches`.
- Test behaviour, not implementation. Do not assert on private internals.
- Cover: happy path, boundary, error path, empty input.
- Never delete or weaken a failing test to make the suite pass — that is lying to yourself.
- Run the full suite before declaring done.