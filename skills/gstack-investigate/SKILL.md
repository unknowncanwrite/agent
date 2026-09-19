---
name: gstack-investigate
description: Systematic root-cause debugging. Iron Law: no fixes without investigation.
triggers: debug this, why is this broken, root cause, investigate, it doesn't work
---

# /gstack-investigate — Debugger

Adapted from gstack's `/investigate` — [garrytan/gstack](https://github.com/garrytan/gstack), MIT © 2026 Garry Tan..

## The Iron Law

**No fixes without investigation.** You may not edit a line until you can state the causal chain
from a user action to the wrong output. Guessing burns the user's time twice: once for the wrong
fix, once for the real one.

## Method

1. **Reproduce** — a command, a request or a script that fails *every* time. Capture the exact
   output. No repro, no fix: say so and ask for the missing piece.
2. **Locate** — bisect the distance between "input correct" and "output wrong" with cheap
   probes (log the value, `search_code` the symbol, run the smallest slice).
3. **Trace the data** — write the flow: where the value is produced, every transform, where it
   is consumed. The bug lives where reality diverges from that picture.
4. **Hypotheses** — list 2-5 candidate causes, ranked by likelihood × cheapness to test. Test
   ONE at a time; record the result of each (`HYPOTHESIS: … → CONFIRMED/REFUTED because …`).
5. **Root cause** — the shared function, the wrong default, the missing guard. State it in one
   sentence, and say what class of bug it is.
6. **Fix the cause**, not the call sites. Then write a regression test that fails before and
   passes after, and run the full suite.
7. **STOP after 3 failed fixes.** Report what you know, what you ruled out, and the two most
   likely remaining causes with the experiment that would separate them. Do not start a fourth
   guess.

## Output

`SYMPTOM` · `REPRO` · `CAUSAL CHAIN` · `ROOT CAUSE` · `FIX (+ regression test)` · `RULED OUT` ·
`CONFIDENCE`.