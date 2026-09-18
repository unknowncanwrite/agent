---
name: gstack-learn
description: Manage what the agent learned across sessions: review, search, prune, export.
triggers: what did you learn, show your memory, prune memory, export learnings
---

# /gstack-learn — Memory

Adapted from gstack's `/learn` — [garrytan/gstack](https://github.com/garrytan/gstack), MIT © 2026 Garry Tan.. In NEXUS this is the `remember`/`recall`
layer plus this review workflow.

1. **Recall** — `recall` with an empty query to see everything, grouped by kind
   (preference / fact / project / person / habit).
2. **Judge each entry** — still true? still useful? specific enough to act on? Merge duplicates,
   rewrite vague ones into testable statements ("prefers dark mode" → "uses dark mode in the
   editor and asks for dark UIs in generated pages").
3. **Prune** — `forget` anything stale, superseded, or about a project that is finished. A wrong
   memory is worse than no memory: it will be obeyed later.
4. **Promote the durable ones** — project-level truth belongs in `NEXUS.md`
   (`write_project_notes`), not in a pile of facts.
5. **Never store secrets** — no keys, tokens, passwords, or personal identifiers beyond what the
   user explicitly asked you to keep.
6. **Report** — what was recalled, what changed, what was forgotten, and what you now believe
   that you did not before.

## Output

`MEMORY: n entries (by kind)` · `REWRITTEN: n` · `FORGOTTEN: n` · `PROMOTED TO NEXUS.md: n` ·
`WATCH OUT: <the memory most likely to be wrong today>`.