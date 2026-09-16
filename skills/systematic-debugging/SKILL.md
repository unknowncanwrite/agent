---
name: systematic-debugging
description: Root-cause debugging methodology instead of guess-and-check.
triggers: debug, bug, error, failing, broken, crash
---

# Systematic Debugging

NEVER guess-and-patch. Follow this loop.

1. **Reproduce** — get a deterministic failing command. If you cannot reproduce it, that is step one.
2. **Read the actual error** — full stack trace, not the summary. Find the FIRST error; later ones are usually cascades.
3. **Localise** — binary-search the failure. Add temporary logging or run subsets of tests to halve the search space each time.
4. **Form ONE hypothesis** — state it explicitly: "I believe X because Y."
5. **Test that hypothesis cheaply** — smallest possible experiment that would disprove it.
6. **Fix the cause, not the symptom** — if you are adding a try/catch to make an error go away, you have not found the cause.
7. **Verify** — rerun the original reproduction. Then run the FULL suite to check you broke nothing.
8. **Add a regression test** that fails without your fix.

If two hypotheses are equally likely, use think_parallel to evaluate both at once.
If you have tried 3 fixes and none worked, STOP and re-read your assumptions from step 1.