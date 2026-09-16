---
name: code-review
description: Rigorous multi-pass code review: correctness, security, performance, style.
triggers: review, audit, pr, pull request
---

# Code Review

Run these passes IN PARALLEL with spawn_subagents when the diff is large.

## Pass 1 — Correctness
- Logic errors, off-by-one, wrong operators, inverted conditions
- Unhandled promise rejections / missing await
- Null and undefined paths; empty-array and empty-string cases
- Race conditions and shared mutable state

## Pass 2 — Security
- Injection: SQL, shell, template, path traversal
- Secrets committed in code or logs
- Missing authz checks on mutating endpoints
- Unsafe deserialisation, `eval`, unvalidated redirects
- Dependency CVEs (run the audit command for the ecosystem)

## Pass 3 — Performance
- N+1 queries, unbounded loops, sync I/O on hot paths
- Missing indexes, unnecessary re-renders, memory leaks

## Pass 4 — Maintainability
- Dead code, duplicated logic, unclear naming
- Missing tests for new branches

## Output format
For each finding: `severity | file:line | what | why it matters | concrete fix`.
Severity: BLOCKER / MAJOR / MINOR / NIT. Lead with BLOCKERs.
End with a one-line verdict: SHIP / FIX-FIRST / REWRITE.
Only report things you actually verified by reading the code.