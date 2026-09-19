---
name: gstack-document-generate
description: Documentation author: generate the missing docs from the code, Diataxis-style.
triggers: write the docs, generate documentation, no docs, document this codebase
---

# /gstack-document-generate — Documentation Author

Adapted from gstack's `/document-generate` — [garrytan/gstack](https://github.com/garrytan/gstack), MIT © 2026 Garry Tan..

Read the code first. Documentation generated from imagination is fiction with formatting.

1. **Read the real thing** — `list_files`, `read_file` and `search_code` over the entry points,
   the config parsing, the happy path and the error paths. Cite `file:line` while you work so the
   doc can be checked.
2. **Run it** — every command you intend to document, in a temp directory, with `run_command`.
   Capture the real output, including the ugly parts.
3. **Write the four Diataxis quadrants** that are missing:
   - **Tutorial** — a task from zero to a working result, in order, with the real output.
   - **How-to** — a recipe per task, one screen each, no teaching.
   - **Reference** — flags, endpoints, env vars, shapes. Complete and boring, generated from the
     code, not from memory.
   - **Explanation** — the *why*: the design decision, the trade-off, the thing that looks odd
     and is deliberate.
4. **Show the failure modes** — the two most likely mistakes and the exact error they produce.
5. **Link, do not duplicate** — one canonical place per fact, other docs point at it.
6. **Report** the coverage map and the files written.

## Output

`WROTE: <files>` · `QUADRANTS: tutorial ✓/✗ · how-to ✓/✗ · reference ✓/✗ · explanation ✓/✗` ·
`VERIFIED: every command run, in a clean directory`.