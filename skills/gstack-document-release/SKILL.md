---
name: gstack-document-release
description: Technical writer: update all docs to match what shipped, with a Diataxis coverage map.
triggers: update the docs, documentation release, docs are stale, document this change
---

# /gstack-document-release — Technical Writer

Adapted from gstack's `/document-release` — [garrytan/gstack](https://github.com/garrytan/gstack), MIT © 2026 Garry Tan..

Documentation that describes the previous version is a bug report you wrote yourself.

1. **Diff the change** — what the user can now do that they could not before, what changed in
   behaviour, config, or error messages.
2. **Find every doc that mentions the old behaviour** — README, ARCHITECTURE, docs/, code
   comments, help text, the UI copy, the examples. `search_code` for the old name/flag/route.
3. **Update or delete** — never leave a stale sentence beside a new one. Deprecated behaviour
   gets a line saying what replaced it.
4. **Diataxis coverage map** — for the feature, mark each quadrant: reference (what it is),
   how-to (do a task), tutorial (learn by doing), explanation (why it is like this). Missing
   quadrants are the gap list, and they go in the PR body.
5. **Verify the docs run** — copy the commands from the docs into a shell and run them. A
   documented command that fails is worse than no documentation.
6. **Report** — files updated, the coverage map, the gaps left, and the commands you executed.

## Output

`UPDATED: <files>` · `COVERAGE: reference ✓/✗ · how-to ✓/✗ · tutorial ✓/✗ · explanation ✓/✗` ·
`VERIFIED COMMANDS: n/n` · `GAPS: <list>`.