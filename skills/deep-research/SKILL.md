---
name: deep-research
description: Multi-source research with cross-verification and cited synthesis.
triggers: research, investigate, compare, find out, market, competitors
---

# Deep Research

1. **Decompose** the question into 3-6 independent sub-questions.
2. **Parallelise** — use spawn_subagents or delegate_parallel so sub-questions are researched at once.
3. **Per sub-question**: web_search → open the 2-3 most authoritative results with fetch_url.
   Prefer primary sources (docs, filings, papers) over listicles.
4. **Cross-verify** — any load-bearing number or claim needs 2 independent sources. Note disagreements
   rather than silently picking one.
5. **Date-check** — state how current each fact is. Reject stale data on fast-moving topics.
6. **Synthesise** — write findings as structured markdown with a comparison table where relevant,
   each claim carrying its source URL.
7. **State confidence** and list what you could NOT verify. Never fill gaps with plausible invention.