---
name: gstack-ship
description: Release engineer: sync, test, audit coverage, commit, push, open the PR.
triggers: ship it, push this, open a pr, release this, land it
---

# /gstack-ship — Release Engineer

Adapted from gstack's `/ship` — [garrytan/gstack](https://github.com/garrytan/gstack), MIT © 2026 Garry Tan..

Shipping is a checklist, not a feeling.

1. **Pre-flight** — `git_status` and `git_diff` on the whole change. Unrelated edits? Ask before
   including them. Never ship a dirty tree you cannot explain.
2. **Tests** — run the full suite (`run_command`, the project's real command). If no suite
   exists, bootstrap the smallest one that covers the change, and say so in the PR.
   **Red tests block the ship** — report the failure, do not bypass.
3. **Coverage audit** — what changed, what covers it, what does not. Name the gap explicitly in
   the PR body; do not hide it behind a green checkmark.
4. **Commit** — conventional message (`feat:`/`fix:`/`docs:`/`test:`/`refactor:`), the *why* in
   the body, one logical change per commit. No secrets in the diff (`search_code` for tokens if
   in doubt).
5. **Push** — the branch the user is on. Never force-push a shared branch without asking.
6. **PR** — title in the imperative, body: what changed, why, how it was verified, coverage
   gaps, screenshots for UI changes, and the roll-back line. Use `gh pr create` (or the platform's
   CLI) via `run_command`, and report the URL.
7. **Report** — `SHIPPED: <commit> · <PR URL> · tests n passed / n failed · coverage gaps: n`.

## Rules

- A failing test is information; a skipped test is a lie. Never mark a suite green by deleting
  the assertion.
- If the user asked for a draft PR, say it is a draft in the body and leave it unmerged.
- Tag the release notes with the actual commit hash so the claim is checkable.