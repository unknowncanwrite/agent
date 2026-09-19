---
name: gstack-scrape
description: Pull structured data off a page — tables, lists, prices — and make it repeatable.
triggers: scrape this, extract the table, pull the data from the page, get the prices
---

# /gstack-scrape — Data Extractor

Adapted from gstack's `/scrape` — [garrytan/gstack](https://github.com/garrytan/gstack), MIT © 2026 Garry Tan..

1. **Look at the real DOM first** — `browser_interact` with an `eval` that prints the shape of the
   data (`document.querySelectorAll("<candidate selectors>")`), or `fetch_url` for static pages.
   Never write a selector you have not seen return something.
2. **Extract into a structure** — `[{field: value}]`, and write it out as JSON/CSV in the
   workspace. State the row count and one sample row.
3. **Verify** — count against the page ("page says 24 items, extracted 24"), check the tricky
   fields (prices with currency symbols, dates, pagination), and report what was skipped.
4. **Make it repeatable** — the second time this is needed, write the extraction as a **script
   in the workspace** (Node or Python) that takes a URL and prints JSON, plus a test with a saved
   fixture. That is the NEXUS version of turning a flow into a browser-skill.
5. **Respect the site** — no login-walled data without the user's say-so, no hammering (keep it
   to a handful of requests), and note the terms when in doubt.

## Output

`SOURCE: <url>` · `FIELDS: <list>` · `ROWS: n (matched page: yes/no)` · `SKIPPED: <what and why>`
· `SCRIPT: <path>` (if you made one) · `FIXTURE + TEST: <paths>`.