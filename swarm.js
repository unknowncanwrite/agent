/* Swarm orchestration — many agents on one task, safely and in parallel.
   Adds what plain spawn_subagents lacked: workspace isolation, dependency
   ordering (waves), a shared scratchpad, and live per-agent telemetry. */
import fs from "node:fs/promises";
import fss from "node:fs";
import path from "node:path";

/** Split tasks into dependency waves. Tasks with no unmet deps run together. */
export function planWaves(tasks) {
  const byName = new Map(tasks.map((t) => [t.name, t]));
  const done = new Set();
  const waves = [];
  let remaining = [...tasks];
  let guard = 0;

  while (remaining.length && guard++ < 20) {
    const ready = remaining.filter((t) =>
      (t.needs || []).every((d) => done.has(d) || !byName.has(d)));
    if (!ready.length) { waves.push(remaining); break; }   // cycle: run the rest together
    waves.push(ready);
    ready.forEach((t) => done.add(t.name));
    remaining = remaining.filter((t) => !ready.includes(t));
  }
  return waves;
}

/** Per-agent sandbox so parallel writers never clobber each other. */
export async function makeCell(root, name) {
  const safe = String(name).replace(/[^\w.-]/g, "_").slice(0, 40);
  const dir = path.join(root, ".swarm", safe);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** Copy a cell's produced files back into the main workspace. */
export async function mergeCell(cellDir, root, onConflict = "keep-both") {
  const moved = [], skipped = [];
  async function walk(dir, rel = "") {
    let ents = [];
    try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const from = path.join(dir, e.name);
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) { await walk(from, r); continue; }
      let to = path.join(root, r);
      if (fss.existsSync(to)) {
        // identical content is not a conflict — skip silently
        let same = false;
        try {
          const [a, b] = await Promise.all([fs.readFile(from), fs.readFile(to)]);
          same = a.equals(b);
        } catch {}
        if (same) { skipped.push(r); continue; }
        if (onConflict === "skip") { skipped.push(r); continue; }
        if (onConflict === "keep-both") {
          const ext = path.extname(r), base = r.slice(0, r.length - ext.length);
          to = path.join(root, `${base}.${path.basename(cellDir)}${ext}`);
        }
      }
      await fs.mkdir(path.dirname(to), { recursive: true });
      await fs.copyFile(from, to);
      moved.push(path.relative(root, to));
    }
  }
  await walk(cellDir);
  return { moved, skipped };
}

/** Shared scratchpad so agents in later waves see earlier findings. */
export class Board {
  constructor() { this.notes = []; }
  add(from, text) {
    if (!text) return;
    this.notes.push({ from, text: String(text).slice(0, 1500), at: Date.now() });
    if (this.notes.length > 60) this.notes.shift();
  }
  digest(limit = 12) {
    if (!this.notes.length) return "";
    return "\n=== FINDINGS FROM OTHER AGENTS ===\n" +
      this.notes.slice(-limit).map((n) => `[${n.from}] ${n.text.slice(0, 400)}`).join("\n") + "\n";
  }
}

/** How many agents to run at once, based on machine size. */
export function idealConcurrency(n, cpus = 4) {
  return Math.max(2, Math.min(n, cpus, 6));
}
