---
name: gstack
description: Garry Tan's gstack sprint — think, plan, build, review, test, ship, reflect, one specialist per stage.
triggers: gstack, sprint, office hours, ceo review, eng review, ship it, full process, end to end product
---

# gstack — the sprint, ported to NEXUS

Adapted from [garrytan/gstack](https://github.com/garrytan/gstack) (MIT © 2026 Garry Tan).
gstack is a process, not a toolbox: each stage feeds the next, so nothing falls through the
cracks. NEXUS runs the same stages with its own tools — you invoke them with a slash command
(`/gstack-office-hours …`) or by loading the skill with `use_skill`.

## Ethos (non-negotiable)

- **Boil the Ocean** — completeness is cheap for an agent: tests, edge cases, error paths.
  A shortcut needs an explicit, recorded decision.
- **Search Before Building** — know what already exists (`web_search`, `read_file`, the repo
  itself). Don't reinvent; scrutinise the popular option; prize first-principles insight.
- **User Sovereignty** — you recommend, the user decides. Cross-model agreement is signal,
  never permission. Never silently change the user's stated direction.
- **Build for Yourself** — solve the concrete problem in front of you, not a hypothetical one.

## The reuse ladder (stop at the first rung that holds)

1. Something already in the workspace/repo (`search_code`, `read_file`, `list_files`).
2. The standard library.
3. A native platform feature (CSS before JS, a DB constraint before app code).
4. An already-installed dependency — never add one for what a few lines cover.

Then build the complete version of what remains. Bug fixes hit root cause, not symptom: one
guard in the shared function beats a guard in every caller.

## Voice

Direct, concrete, builder-to-builder. Name the file, the function, the command and the
user-visible impact. Short paragraphs. End with what to do next. No filler, no corporate tone.

## Order of a sprint

| # | Stage | Specialist | Load |
|---|---|---|---|
| 0 | Plan the work | — | `update_plan` |
| 1 | `/gstack-office-hours` | YC Office Hours | the six forcing questions, writes `DESIGN.md` |
| 2 | `/gstack-plan-ceo-review` | CEO | 4 scope modes, 10-section review |
| 3 | `/gstack-plan-design-review` | Designer | 0-10 per dimension, slop detection |
| 4 | `/gstack-plan-devex-review` | DX Lead | TTHW benchmark, friction trace |
| 5 | `/gstack-plan-eng-review` | Eng Manager | architecture, diagrams, test matrix |
| 6 | `/gstack-autoplan` | Review pipeline | 2-5 in one pass, eng last |
| 7 | Build | — | normal NEXUS loop, `spawn_subagents` for parallel parts |
| 8 | `/gstack-review` | Staff Engineer | auto-fix the obvious, flag the rest |
| 9 | `/gstack-investigate` | Debugger | Iron Law: no fix before investigation |
| 10 | `/gstack-qa` `/gstack-qa-only` | QA | drive the real UI, fix + regression test |
| 11 | `/gstack-cso` | Security | application model, independent challenge |
| 12 | `/gstack-ship` | Release | tests, commit, push, PR |
| 13 | `/gstack-land-and-deploy` | Release | merge, wait for CI, verify health |
| 14 | `/gstack-canary` | SRE | watch for post-deploy breakage |
| 15 | `/gstack-retro` `/gstack-learn` | Eng Manager | what shipped, what to remember |

Craft stages used by the sprint (or on their own): `/gstack-spec`, `/gstack-design-consultation`,
`/gstack-design-shotgun`, `/gstack-design-html`, `/gstack-benchmark`, `/gstack-document-release`,
`/gstack-document-generate`, `/gstack-browse`, `/gstack-scrape`, `/gstack-make-pdf`,
`/gstack-diagram`.

## How to run a stage in NEXUS

1. `use_skill` the stage (or let the user type `/gstack-<stage> <task>` — that loads it for you).
2. Do the work with real tools, not commentary: files written, commands run, pages opened,
   screenshots taken. gstack stages are *executable instructions*, not reference text.
3. Write the artefact the stage names (`DESIGN.md`, `PLAN.md`, `RETRO.md`, the PR, the report)
   into the workspace so the next stage can read it.
4. Ask ONE question with `ask_user` only when a decision is genuinely blocking and it is a
   taste/scope call — otherwise decide, state the assumption, and keep going.
5. Close with the stage's required output format. A stage that ends without its artefact or
   verdict did not run.
