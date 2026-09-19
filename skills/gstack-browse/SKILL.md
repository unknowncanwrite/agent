---
name: gstack-browse
description: Give the agent eyes: drive a real browser, click real flows, capture what happened.
triggers: open the browser, look at the page, browse this, check the site visually
---

# /gstack-browse — QA Engineer (browser)

Adapted from gstack's `/browse` — [garrytan/gstack](https://github.com/garrytan/gstack), MIT © 2026 Garry Tan.. NEXUS's equivalent is the browser toolset:
`screenshot`, `browser_interact`, `fetch_url`, `start_server`.

## Method

1. **Know what you are opening** — a local file, a dev server (`start_server` first, note the
   port), or a live URL. Never assume a page is up: check the status code, or you will debug
   your own typo for ten minutes.
2. **Look before clicking** — `screenshot` first, then act. Describe what you see in one line so
   the user can follow without opening the image.
3. **Act deliberately** — one `browser_interact` batch per intent (fill the form, submit, wait
   for the result). After each: screenshot + read the console errors.
4. **Read the console and the network** — an `eval` action returning
   `{errors, failedRequests}` catches what pixels hide.
5. **Report the journey** — URL, the step, what appeared, what the console said, screenshot path.
   Screenshots are evidence, not decoration.
6. **Leave it as you found it** — close the pages and stop the servers you started.

## Power moves

- Fill and submit a real form to test a real API.
- Measure load performance while you are there (`performance.getEntriesByType`).
- Compare the same page at 390 / 768 / 1440 px before declaring a layout done.
- Use `fetch_url` when you only need text — it is faster than a browser and needs no Chromium.

## Output

`OPENED: <url>` · `SAW: <one line per step>` · `CONSOLE: <errors or none>` ·
`SCREENSHOTS: <paths>` · `VERDICT: <what works, what does not>`.