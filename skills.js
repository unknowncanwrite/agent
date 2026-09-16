/* Skills — dynamic instruction folders that teach NEXUS specialised workflows.
   Mirrors Claude Code's Skills, but auto-discovered and model-agnostic.
   A skill is  skills/<name>/SKILL.md  with optional supporting files. */
import fs from "node:fs/promises";
import fss from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SKILLS_DIR = path.join(__dirname, "skills");
fss.mkdirSync(SKILLS_DIR, { recursive: true });

/** Parse the YAML-ish frontmatter Claude-style skills use. */
function parseFront(src) {
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(src);
  if (!m) return { meta: {}, body: src };
  const meta = {};
  for (const line of m[1].split("\n")) {
    const kv = /^([a-zA-Z_-]+)\s*:\s*(.*)$/.exec(line.trim());
    if (kv) meta[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  return { meta, body: m[2] };
}

export async function list() {
  const out = [];
  let dirs = [];
  try { dirs = await fs.readdir(SKILLS_DIR, { withFileTypes: true }); } catch { return out; }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const f = path.join(SKILLS_DIR, d.name, "SKILL.md");
    try {
      const src = await fs.readFile(f, "utf8");
      const { meta, body } = parseFront(src);
      out.push({
        name: meta.name || d.name,
        dir: d.name,
        description: meta.description || body.split("\n").find((l) => l.trim()) || "",
        triggers: (meta.triggers || "").split(",").map((s) => s.trim()).filter(Boolean),
        body,
        bytes: src.length,
      });
    } catch {}
  }
  return out;
}

export async function get(name) {
  const all = await list();
  return all.find((s) => s.name === name || s.dir === name) || null;
}

export async function install({ name, description, body, triggers = [] }) {
  const dir = path.join(SKILLS_DIR, name.replace(/[^\w-]/g, "-"));
  await fs.mkdir(dir, { recursive: true });
  const front = `---\nname: ${name}\ndescription: ${description || ""}\ntriggers: ${triggers.join(", ")}\n---\n\n`;
  await fs.writeFile(path.join(dir, "SKILL.md"), front + body, "utf8");
  return `Installed skill "${name}" → skills/${path.basename(dir)}/SKILL.md`;
}

export async function remove(name) {
  const s = await get(name);
  if (!s) return `No skill named "${name}"`;
  await fs.rm(path.join(SKILLS_DIR, s.dir), { recursive: true, force: true });
  return `Removed skill "${name}"`;
}

/** Short catalogue injected into every system prompt (cheap). */
export async function catalogue() {
  const all = await list();
  if (!all.length) return "";
  return "\n=== SKILLS AVAILABLE (load with use_skill before doing that kind of work) ===\n" +
    all.map((s) => `- ${s.name}: ${s.description.slice(0, 110)}`).join("\n") + "\n";
}

/** Auto-suggest skills whose triggers match the task. */
export async function match(text) {
  const all = await list();
  const t = (text || "").toLowerCase();
  return all.filter((s) => s.triggers.some((k) => k && t.includes(k.toLowerCase())));
}

/* ---------------- built-in starter skills ---------------- */
const BUILTINS = {
  "code-review": {
    description: "Rigorous multi-pass code review: correctness, security, performance, style.",
    triggers: "review, audit, pr, pull request",
    body: `# Code Review

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
- Unsafe deserialisation, \`eval\`, unvalidated redirects
- Dependency CVEs (run the audit command for the ecosystem)

## Pass 3 — Performance
- N+1 queries, unbounded loops, sync I/O on hot paths
- Missing indexes, unnecessary re-renders, memory leaks

## Pass 4 — Maintainability
- Dead code, duplicated logic, unclear naming
- Missing tests for new branches

## Output format
For each finding: \`severity | file:line | what | why it matters | concrete fix\`.
Severity: BLOCKER / MAJOR / MINOR / NIT. Lead with BLOCKERs.
End with a one-line verdict: SHIP / FIX-FIRST / REWRITE.
Only report things you actually verified by reading the code.`,
  },
  "systematic-debugging": {
    description: "Root-cause debugging methodology instead of guess-and-check.",
    triggers: "debug, bug, error, failing, broken, crash",
    body: `# Systematic Debugging

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
If you have tried 3 fixes and none worked, STOP and re-read your assumptions from step 1.`,
  },
  "frontend-design": {
    description: "Produce distinctive, professional UI instead of generic AI-looking pages.",
    triggers: "ui, frontend, design, page, website, component, css",
    body: `# Frontend Design

## Avoid the AI-slop signature
Do NOT ship: centred purple gradient hero, Inter + generic card grid, emoji bullet lists,
\`box-shadow: 0 4px 6px rgba(0,0,0,0.1)\`, three equal feature cards, "Lorem ipsum"-grade copy.

## Do instead
- **Pick a real point of view**: editorial, brutalist, Swiss, terminal, glassmorphic, neo-retro. Commit to it.
- **Type**: one distinctive display face + one clean text face. Set real scale (1.25 or 1.333 ratio).
- **Colour**: one dominant, one accent, generous neutrals. Check contrast ≥ 4.5:1.
- **Space**: use an 8px grid. Whitespace is the cheapest way to look expensive.
- **Motion**: 150–250ms, ease-out, only on interaction. Never animate on load without reason.
- **Detail**: focus states, hover states, empty states, loading states, error states. These separate real from demo.

## Always verify
screenshot the result and judge it as a designer. Then browser_interact to confirm it functions.
If it looks generic, redo it — "works" is not the bar.`,
  },
  "tdd": {
    description: "Test-driven development loop: red, green, refactor.",
    triggers: "tdd, test first, unit test, write tests",
    body: `# TDD Loop

1. **RED** — write the smallest failing test that expresses the next behaviour. Run it. Confirm it fails
   for the RIGHT reason (not an import error).
2. **GREEN** — write the minimum code to pass. Do not add unrequested features.
3. **REFACTOR** — clean up with tests green. Rerun after every change.
4. Repeat.

Rules:
- One behaviour per test. Name tests as sentences: \`returns_empty_list_when_no_matches\`.
- Test behaviour, not implementation. Do not assert on private internals.
- Cover: happy path, boundary, error path, empty input.
- Never delete or weaken a failing test to make the suite pass — that is lying to yourself.
- Run the full suite before declaring done.`,
  },
  "deep-research": {
    description: "Multi-source research with cross-verification and cited synthesis.",
    triggers: "research, investigate, compare, find out, market, competitors",
    body: `# Deep Research

1. **Decompose** the question into 3-6 independent sub-questions.
2. **Parallelise** — use spawn_subagents or delegate_parallel so sub-questions are researched at once.
3. **Per sub-question**: web_search → open the 2-3 most authoritative results with fetch_url.
   Prefer primary sources (docs, filings, papers) over listicles.
4. **Cross-verify** — any load-bearing number or claim needs 2 independent sources. Note disagreements
   rather than silently picking one.
5. **Date-check** — state how current each fact is. Reject stale data on fast-moving topics.
6. **Synthesise** — write findings as structured markdown with a comparison table where relevant,
   each claim carrying its source URL.
7. **State confidence** and list what you could NOT verify. Never fill gaps with plausible invention.`,
  },
};

export async function ensureBuiltins() {
  for (const [name, s] of Object.entries(BUILTINS)) {
    const dir = path.join(SKILLS_DIR, name);
    if (fss.existsSync(path.join(dir, "SKILL.md"))) continue;
    await install({ name, description: s.description, body: s.body, triggers: s.triggers.split(",").map((x) => x.trim()) });
  }
}
