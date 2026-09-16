/* Self-modification with git safety net, syntax validation and rollback */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runStream } from "./shell.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const APP_DIR = __dirname;

/** Files the agent is allowed to modify in its own codebase. */
export const EDITABLE = [
  "agent.js", "server.js", "browser.js", "models.js", "shell.js", "setup.js",
  "selfedit.js", "workers.js", "start.js", "router.js", "jarvis.js", "oscontrol.js",
  "memory.js", "mcp.js", "hooks.js", "package.json", "README.md",
  "public/app.js", "public/index.html", "public/style.css",
];

const PROTECTED = [".env", ".git", "node_modules", "package-lock.json"];

export function resolveSelf(file) {
  if (!file || typeof file !== "string") throw new Error("file required");
  const clean = file.replace(/\\/g, "/").trim();
  if (path.isAbsolute(clean)) throw new Error("use a path relative to the app directory");
  if (clean.split("/").includes("..")) throw new Error("path traversal ('..') is not allowed");

  const first = clean.split("/")[0];
  if (PROTECTED.includes(first) || PROTECTED.includes(clean)) throw new Error(`${clean} is protected and cannot be modified`);

  const full = path.resolve(APP_DIR, clean);
  if (full !== APP_DIR && !full.startsWith(APP_DIR + path.sep)) throw new Error("outside app directory");

  const relp = path.relative(APP_DIR, full).replace(/\\/g, "/");
  if (!EDITABLE.includes(relp)) {
    throw new Error(`${relp} is not in the editable set. Allowed: ${EDITABLE.join(", ")}`);
  }
  return full;
}

async function git(args, timeout = 30) {
  return await runStream(`git ${args}`, { cwd: APP_DIR, timeout });
}

/** Ensure the app dir is a git repo so every self-edit is revertible. */
export async function ensureRepo() {
  const r = await git("rev-parse --is-inside-work-tree");
  if (r.code !== 0) {
    await git("init");
    await git('config user.email "nexus@agent.local"');
    await git('config user.name "NEXUS"');
    await git("add -A");
    await git('commit -q -m "NEXUS: initial snapshot"');
    return "initialised git repo for self-edit safety";
  }
  return "repo ready";
}

/** Snapshot current state; returns a ref you can roll back to. */
export async function snapshot(label = "pre-self-edit") {
  await ensureRepo();
  await git("add -A");
  const c = await git(`commit -q -m "NEXUS snapshot: ${label.replace(/"/g, "")}" --allow-empty`);
  const h = await git("rev-parse --short HEAD");
  return { ok: c.code === 0 || c.code === 1, ref: (h.stdout || "").trim() };
}

export async function rollback(ref) {
  const target = ref || "HEAD~1";
  const r = await git(`reset --hard ${target}`);
  return r.code === 0 ? `Rolled back to ${target}` : `Rollback failed: ${r.stderr}`;
}

export async function history(n = 10) {
  const r = await git(`log --oneline -n ${n}`);
  return r.stdout || "(no history)";
}

export async function diff(file) {
  const r = await git(`diff HEAD ${file ? `-- ${file}` : ""}`.trim(), 40);
  const out = r.stdout || "(no uncommitted changes)";
  return out.length > 20000 ? out.slice(0, 20000) + "\n…[truncated]" : out;
}

/** Validate a JS/JSON file parses before we let it stick. */
export async function validate(file) {
  const full = resolveSelf(file);
  if (/\.json$/.test(file)) {
    try { JSON.parse(await fs.readFile(full, "utf8")); return { ok: true }; }
    catch (e) { return { ok: false, error: "Invalid JSON: " + e.message }; }
  }
  if (/\.(js|mjs)$/.test(file)) {
    const r = await runStream(`node --check "${full}"`, { cwd: APP_DIR, timeout: 30 });
    return r.code === 0 ? { ok: true } : { ok: false, error: (r.stderr || r.stdout).slice(0, 1500) };
  }
  return { ok: true }; // html/css/md: nothing to parse
}

/**
 * Write to NEXUS's own source with a safety net:
 * snapshot → write → syntax check → auto-revert that file if broken.
 */
export async function writeSelf({ file, content }) {
  const full = resolveSelf(file);
  const before = await fs.readFile(full, "utf8").catch(() => null);
  const snap = await snapshot(`before edit ${file}`);

  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, "utf8");

  const v = await validate(file);
  if (!v.ok) {
    if (before !== null) await fs.writeFile(full, before, "utf8");
    return { ok: false, reverted: true, error: `Syntax check FAILED — change reverted.\n${v.error}` };
  }
  return { ok: true, ref: snap.ref, bytes: content.length, lines: content.split("\n").length };
}

/** Targeted patch of own source. */
export async function patchSelf({ file, old_text, new_text }) {
  const full = resolveSelf(file);
  const src = await fs.readFile(full, "utf8");
  let next;
  if (src.includes(old_text)) next = src.replace(old_text, new_text);
  else {
    const norm = (s) => s.replace(/\s+/g, " ").trim();
    const line = src.split("\n").find((l) => norm(l) === norm(old_text));
    if (!line) return { ok: false, error: `old_text not found in ${file}. read_own_code it and match exactly.` };
    next = src.replace(line, new_text);
  }
  return await writeSelf({ file, content: next });
}

/** Run the app's own smoke test: every source file must parse. */
export async function selfTest() {
  const files = EDITABLE.filter((f) => /\.(js|json)$/.test(f));
  const results = await Promise.all(files.map(async (f) => {
    try { const v = await validate(f); return `${v.ok ? "OK  " : "FAIL"} ${f}${v.ok ? "" : " — " + v.error.split("\n")[0]}`; }
    catch (e) { return `SKIP ${f} (${e.message})`; }
  }));
  const bad = results.filter((r) => r.startsWith("FAIL"));
  return { ok: bad.length === 0, report: results.join("\n") };
}
