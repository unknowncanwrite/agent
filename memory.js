/* Persistent memory: facts, project knowledge, and session recall across restarts */
import fs from "node:fs/promises";
import fss from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const MEM_DIR = path.join(__dirname, ".memory");
fss.mkdirSync(MEM_DIR, { recursive: true });

const FACTS = path.join(MEM_DIR, "facts.json");
const SESSIONS = path.join(MEM_DIR, "sessions.json");
const NOTES = path.join(__dirname, "NEXUS.md");   // human-editable project brief

const readJSON = async (f, d) => { try { return JSON.parse(await fs.readFile(f, "utf8")); } catch { return d; } };
const writeJSON = (f, v) => fs.writeFile(f, JSON.stringify(v, null, 2), "utf8");

/* ---------------- facts ---------------- */
/** kind: preference | fact | project | person | credential-hint | habit */
/** Reject facts that are only true for one task. */
function isEphemeral(t) {
  return /\b(does not exist|doesn'?t exist|was not found|currently|right now|this task|in the workspace|failed because|the file '|port \d{4})\b/i.test(t)
      || t.length < 12;
}
/** Cheap similarity so "avoid calling update_plan repeatedly" is not stored twice. */
function tokens(s) { return new Set(String(s).toLowerCase().match(/[a-z]{4,}/g) || []); }
function similar(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let hit = 0; for (const w of A) if (B.has(w)) hit++;
  return hit / Math.min(A.size, B.size);
}

export async function remember({ text, kind = "fact", tags = [], importance = 3 }) {
  const all = await readJSON(FACTS, []);
  const norm = text.trim().toLowerCase();
  if (isEphemeral(text)) return `Not stored — that is task-specific, not a durable fact.`;
  const near = all.find((f) => similar(f.text, text) >= 0.75);
  if (near) {
    near.hits = (near.hits || 1) + 1;
    near.at = Date.now();
    near.importance = Math.max(near.importance || 3, importance);
    if (text.length > near.text.length) near.text = text.trim();
    await writeJSON(FACTS, all);
    return `Merged with an existing similar memory (#${near.id}).`;
  }
  const dup = all.find((f) => f.text.trim().toLowerCase() === norm);
  if (dup) {
    dup.hits = (dup.hits || 1) + 1;
    dup.at = Date.now();
    dup.importance = Math.max(dup.importance || 3, importance);
    await writeJSON(FACTS, all);
    return `Already knew that (reinforced). #${dup.id}`;
  }
  const rec = { id: Math.random().toString(36).slice(2, 8), text: text.trim(), kind, tags, importance, at: Date.now(), hits: 1 };
  all.push(rec);
  // cap: drop least important / oldest
  if (all.length > 600) {
    all.sort((a, b) => (b.importance - a.importance) || (b.at - a.at));
    all.length = 600;
  }
  await writeJSON(FACTS, all);
  return `Remembered [${kind}] "${rec.text.slice(0, 90)}" (#${rec.id})`;
}

export async function recall(query = "", limit = 25) {
  const all = await readJSON(FACTS, []);
  if (!query) {
    return all.sort((a, b) => (b.importance - a.importance) || (b.at - a.at)).slice(0, limit);
  }
  const words = query.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
  const scored = all.map((f) => {
    const hay = (f.text + " " + f.tags.join(" ") + " " + f.kind).toLowerCase();
    let s = 0;
    for (const w of words) if (hay.includes(w)) s += 2;
    s += (f.importance || 3) * 0.4 + Math.min(f.hits || 1, 5) * 0.2;
    return { ...f, _s: s };
  }).filter((f) => f._s > 1);
  return scored.sort((a, b) => b._s - a._s).slice(0, limit);
}

export async function forget(id) {
  const all = await readJSON(FACTS, []);
  const n = all.length;
  const next = all.filter((f) => f.id !== id && !f.text.toLowerCase().includes(String(id).toLowerCase()));
  await writeJSON(FACTS, next);
  return `Forgot ${n - next.length} item(s).`;
}

/* ---------------- project notes (NEXUS.md) ---------------- */
export async function projectNotes() {
  try { return await fs.readFile(NOTES, "utf8"); } catch { return null; }
}
export async function writeProjectNotes(text) {
  await fs.writeFile(NOTES, text, "utf8");
  return `Saved project brief to NEXUS.md (${text.length} chars)`;
}

/* ---------------- session log ---------------- */
export async function logSession({ task, outcome, files = [], ms = 0 }) {
  const all = await readJSON(SESSIONS, []);
  all.unshift({ at: Date.now(), task: String(task).slice(0, 300), outcome: String(outcome).slice(0, 500), files, ms });
  all.length = Math.min(all.length, 200);
  await writeJSON(SESSIONS, all);
}
export async function recentSessions(n = 8) {
  return (await readJSON(SESSIONS, [])).slice(0, n);
}

/** Compact block injected into the system prompt every run. */
export async function contextBlock() {
  const [factsAll, notes, sess] = await Promise.all([recall("", 60), projectNotes(), recentSessions(3)]);
  // strongest signal only: importance x reinforcement, capped so the prompt stays lean
  const facts = factsAll
    .sort((a, b) => ((b.importance || 3) * 2 + Math.min(b.hits || 1, 5)) -
                    ((a.importance || 3) * 2 + Math.min(a.hits || 1, 5)))
    .slice(0, 12);
  let out = "";
  if (notes) out += `\n=== PROJECT BRIEF (NEXUS.md, written by the user) ===\n${notes.slice(0, 3000)}\n`;
  if (facts.length) {
    out += "\n=== WHAT YOU REMEMBER ABOUT THIS USER ===\n" +
      facts.map((f) => `- [${f.kind}] ${f.text.slice(0, 160)}`).join("\n") + "\n";
  }
  if (sess.length) {
    out += "\n=== RECENT WORK ===\n" +
      sess.map((s) => `- ${new Date(s.at).toLocaleDateString()}: ${s.task.slice(0, 110)} → ${s.outcome.slice(0, 90)}`).join("\n") + "\n";
  }
  if (out) out += "\nUse this naturally. Do not recite it back unless asked. If you learn something durable " +
    "about the user or the project, call remember().\n";
  return out;
}

export async function stats() {
  const [f, s] = await Promise.all([readJSON(FACTS, []), readJSON(SESSIONS, [])]);
  return { facts: f.length, sessions: s.length, hasNotes: !!(await projectNotes()) };
}
