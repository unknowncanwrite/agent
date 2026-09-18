---
name: gstack-land-and-deploy
description: Merge the PR, wait for CI and deploy, verify production health.
triggers: merge the pr, deploy this, land it, ship to production, release to prod
---

# /gstack-land-and-deploy — Release Engineer

Adapted from gstack's `/land-and-deploy` — [garrytan/gstack](https://github.com/garrytan/gstack), MIT © 2026 Garry Tan..

From "approved" to "verified in production" — and no further until the health check passes.

1. **Pre-merge** — CI status on the PR (`run_command` with `gh pr checks`, or the API), the review
   comments that are still open, and the base branch state (`git_status`). A red check is a stop,
   not a speed bump.
2. **Merge** — the method the repo uses (squash for a clean history unless told otherwise). Note
   the merge commit hash.
3. **Watch the deploy** — the platform's own signal: CI run on the default branch, a deploy
   hook, a Render/Vercel build. Wait for a terminal state; report the elapsed time. Free-tier
   hosts hibernate — retry the first request with backoff instead of calling it down.
4. **Verify production health** — the real URL, not a local copy: `fetch_url` (or `run_command`
   with `curl`) against an endpoint that exercises the change (health endpoint, the page that was
   built, the API route that was added). Record status code, response time and a body snippet.
5. **Smoke the changed flow** — one `browser_interact` click-through of the feature that was
   shipped, with a `screenshot` for UI work.
6. **Roll back if health fails** — revert the merge commit or redeploy the previous build, and
   say plainly what you rolled back and why. Do not leave a broken deploy live while you debug.

## Output

`MERGED: <sha>` · `DEPLOY: <status, elapsed>` · `HEALTH: <url> <code> <ms>` · `SMOKE: <what you
clicked> <result>` · `VERDICT: LIVE-AND-VERIFIED | ROLLED BACK (<reason>)`.