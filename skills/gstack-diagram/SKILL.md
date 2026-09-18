---
name: gstack-diagram
description: English in, editable diagram out: mermaid source plus a rendered image.
triggers: draw a diagram, make a flowchart, architecture diagram, show the flow
---

# /gstack-diagram — Diagram Maker

Adapted from gstack's `/diagram` — [garrytan/gstack](https://github.com/garrytan/gstack), MIT © 2026 Garry Tan..

1. **Decide the diagram type from the question** — flow (what happens in order), sequence (who
   talks to whom), state machine (allowed transitions), architecture (what sits where), ER
   (data shape), timeline. Wrong type = useless picture.
2. **Write the mermaid source** into the workspace (`diagrams/<name>.mmd`) — that is the editable
   artefact.
3. **Keep it honest and small** — one idea per diagram, ≤ 15 nodes, real names from the code
   (`file.js`, `POST /api/smart`), no invented boxes. If it needs a legend, split it.
4. **Render** to SVG/PNG and look at the image (`screenshot` a small HTML wrapper that loads the
   mermaid, or an existing renderer on the machine). Fix overlap and clipped labels — a diagram
   you did not look at is a guess.
5. **Embed** the source in the markdown so it can be regenerated, and reference the image for
   surfaces that cannot render mermaid.
6. **State the invariant** the diagram is meant to convey, in one sentence, under the image.

## Output

`TYPE: <kind>` · `SOURCE: <path>` · `IMAGE: <path>` · `INVARIANT: <one sentence>` ·
`VERIFIED: rendered and visually checked`.