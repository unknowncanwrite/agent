/* Lifecycle hooks + checkpoints.
   Hooks let the user run shell commands before/after agent actions — the
   programmable-harness capability Claude Code is known for. */
import fs from "node:fs/promises";
import fss from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runStream } from "./shell.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HOOKS = path.join(__dirname, "hooks.json");
const CKPT = path.join(__dirname, ".checkpoints");
fss.mkdirSync(CKPT, { recursive: true });

/* ---------------- hooks ---------------- */
export async function loadHooks() {
  try { return JSON.parse(await fs.readFile(HOOKS, "utf8")); }
  catch { return { hooks: [] }; }
}
export async function saveHooks(cfg) { await fs.writeFile(HOOKS, JSON.stringify(cfg, null, 2), "utf8"); }

export async function ensureHooks() {
  if (fss.existsSync(HOOKS)) return;
  await saveHooks({
    _comment: "Run shell commands around agent events. $TOOL, $ARGS, $FILE, $EXIT are available.",
    _events: ["before_tool", "after_tool", "before_write", "after_write", "session_start", "session_end"],
    _example: { event: "after_write", match: "\\.js$", command: "npx prettier --write \"$FILE\"", disabled: true },
    hooks: [],
  });
}

/**
 * Fire hooks for an event.
 * A `before_*` hook that exits non-zero BLOCKS the action (guardrail behaviour).
 */
export async function fire(event, ctx = {}, onLog = () => {}) {
  const cfg = await loadHooks();
  const list = (cfg.hooks || []).filter((h) => h.event === event && !h.disabled);
  if (!list.length) return { blocked: false, ran: 0 };

  let ran = 0;
  for (const h of list) {
    if (h.match) {
      const target = ctx.file || ctx.tool || "";
      try { if (!new RegExp(h.match).test(target)) continue; } catch {}
    }
    const env = {
      TOOL: ctx.tool || "", FILE: ctx.file || "",
      ARGS: JSON.stringify(ctx.args || {}).slice(0, 4000),
      EXIT: String(ctx.exit ?? ""),
    };
    const r = await runStream(h.command, { cwd: ctx.cwd || __dirname, timeout: h.timeout || 60, env });
    ran++;
    const out = (r.stdout || r.stderr || "").trim().slice(0, 400);
    onLog(`hook[${event}] ${h.command} → exit ${r.code}${out ? "\n" + out : ""}`);
    if (event.startsWith("before_") && r.code !== 0) {
      return { blocked: true, ran, reason: out || `hook "${h.command}" exited ${r.code}` };
    }
  }
  return { blocked: false, ran };
}

/* ---------------- checkpoints ---------------- */
/** Snapshot a file before mutation so any change is undoable. */
export async function checkpoint(file, label = "") {
  try {
    const content = await fs.readFile(file, "utf8");
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 5);
    const meta = { id, file, label, at: Date.now(), bytes: content.length };
    await fs.writeFile(path.join(CKPT, id + ".txt"), content, "utf8");
    await fs.writeFile(path.join(CKPT, id + ".json"), JSON.stringify(meta), "utf8");
    await prune();
    return meta;
  } catch { return null; }   // new file: nothing to snapshot
}

async function prune(max = 300) {
  const files = (await fs.readdir(CKPT)).filter((f) => f.endsWith(".json"));
  if (files.length <= max) return;
  const metas = [];
  for (const f of files) {
    try { metas.push(JSON.parse(await fs.readFile(path.join(CKPT, f), "utf8"))); } catch {}
  }
  metas.sort((a, b) => a.at - b.at);
  for (const m of metas.slice(0, metas.length - max)) {
    await fs.rm(path.join(CKPT, m.id + ".txt"), { force: true });
    await fs.rm(path.join(CKPT, m.id + ".json"), { force: true });
  }
}

export async function listCheckpoints(n = 30) {
  const files = (await fs.readdir(CKPT)).filter((f) => f.endsWith(".json"));
  const metas = [];
  for (const f of files) {
    try { metas.push(JSON.parse(await fs.readFile(path.join(CKPT, f), "utf8"))); } catch {}
  }
  return metas.sort((a, b) => b.at - a.at).slice(0, n);
}

export async function restore(id) {
  const metaPath = path.join(CKPT, id + ".json");
  const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
  const content = await fs.readFile(path.join(CKPT, id + ".txt"), "utf8");
  await fs.writeFile(meta.file, content, "utf8");
  return `Restored ${meta.file} to its state from ${new Date(meta.at).toLocaleString()}`;
}

/** Undo the most recent change to a given file (or the most recent overall). */
export async function undoLast(file) {
  const all = await listCheckpoints(300);
  const m = file ? all.find((c) => c.file === file || c.file.endsWith(file)) : all[0];
  if (!m) return "No checkpoint found to undo.";
  return await restore(m.id);
}
