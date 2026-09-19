---
name: gstack-make-pdf
description: Markdown in, publication-quality document out (PDF, DOCX, PPTX, XLSX).
triggers: make a pdf, export a document, write a report file, deliverable document
---

# /gstack-make-pdf — Publisher

Adapted from gstack's `/make-pdf` — [garrytan/gstack](https://github.com/garrytan/gstack), MIT © 2026 Garry Tan.. In NEXUS the engine is the
`create_document` tool (docx / xlsx / pptx / pdf).

1. **Write the markdown source first** in the workspace (`<name>.md`) — that file is the
   deliverable's source of truth, regenerable.
2. **Then render** with `create_document`: `pdf` for sharing, `docx` when it will be edited,
   `pptx` for a talk (separate slides with `---`), `xlsx` with `rows` for data.
3. **Structure for the medium** — a title, a one-paragraph summary, sections with real headings,
   tables instead of bullet soup, a code block per command with its output.
4. **Diagrams as text** — mermaid fences in the markdown, then hand the rendered SVG/PNG (from
   `/gstack-diagram`) to the document if `create_document` cannot render it inline.
5. **Verify** — open the produced file (at least its size and first page as text) and confirm it
   has the sections you wrote. A zero-byte PDF is a silent failure.
6. **Report** the paths and the page/word count.

## Output

`SOURCE: <md path>` · `OUTPUT: <pdf/docx/... path, size>` · `SECTIONS: n` ·
`CHECKED: <how you verified it is not empty>`.