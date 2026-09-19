/* NEXUS — autonomous multi-model agent core */
import fs from "node:fs/promises";
import fss from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { screenshot, interact, fetchText, webSearch, SHOTS as SHOTS_DIR, setSetupLogger } from "./browser.js";
import { runStream, startBackground, killProc, killAll, PROCS, sysInfo, isFull, IS_WIN, HOME } from "./shell.js";
import { chainFor, complete, parallel, loadModels } from "./models.js";
import { detectToolchain } from "./setup.js";
import * as J from "./jarvis.js";
import * as OS from "./oscontrol.js";
import * as MEM from "./memory.js";
import * as MCP from "./mcp.js";
import * as HOOK from "./hooks.js";
import * as SKILL from "./skills.js";
import * as DEV from "./devtools.js";
import * as ANDROID from "./android.js";
import * as SUP from "./supervisor.js";
import * as SWARM from "./swarm.js";
import { pool, scheduleCalls, compact, convoTokens, TTLCache } from "./workers.js";
import * as SELF from "./selfedit.js";
import * as PUB from "./publish.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const APP_DIR = __dirname;
export const ROOT = path.resolve(process.env.AGENT_WORKSPACE || path.join(__dirname, "workspace"));
fss.mkdirSync(ROOT, { recursive: true });

/* ---------------- Path policy ---------------- */
/** In FULL_ACCESS the agent may reach anything under the OS user; otherwise workspace only. */
export function resolvePath(p) {
  const raw = p || ".";
  const full = path.isAbsolute(raw) || /^~[\\/]/.test(raw)
    ? path.resolve(raw.replace(/^~/, HOME))
    : path.resolve(ROOT, raw);
  if (isFull()) return full;
  if (full !== ROOT && !full.startsWith(ROOT + path.sep))
    throw new Error(`Path outside workspace: ${p}. Enable AGENT_FULL_ACCESS=true for full-PC access.`);
  return full;
}
const rel = (f) => { const r = path.relative(ROOT, f); return r.startsWith("..") ? f : r || "."; };

/* ---------------- Self-knowledge ---------------- */
const SELF_FILES = ["agent.js", "server.js", "browser.js", "models.js", "shell.js", "setup.js",
  "selfedit.js", "workers.js", "start.js", "router.js", "jarvis.js", "oscontrol.js",
  "memory.js", "mcp.js", "hooks.js", "package.json", "README.md",
  "public/app.js", "public/index.html", "public/style.css"];

export async function selfSource(file) {
  if (!file) return SELF_FILES.join("\n");
  const f = path.resolve(APP_DIR, file);
  if (!f.startsWith(APP_DIR)) throw new Error("outside app dir");
  return await fs.readFile(f, "utf8");
}

/* ---------------- Tools ---------------- */
const T = (name, description, properties, required = []) =>
  ({ type: "function", function: { name, description, parameters: { type: "object", properties, required } } });

export const TOOLS = [
  T("update_plan", "Record your step list ONCE for multi-step work, then update it only when a step actually completes. SKIP it entirely for simple one-or-two-step tasks — just do the work. Never call it twice in a row.",
    { steps: { type: "array", items: { type: "object", properties: {
        title: { type: "string" }, status: { type: "string", enum: ["pending", "active", "done", "failed"] },
      }, required: ["title", "status"] } } }, ["steps"]),

  T("list_files", "Recursive file tree. Accepts absolute paths in full-access mode.", { dir: { type: "string" }, depth: { type: "number" } }),
  T("read_file", "Read a text file.", { path: { type: "string" } }, ["path"]),
  T("write_file", "Create/overwrite a file with complete content.", { path: { type: "string" }, content: { type: "string" } }, ["path", "content"]),
  T("edit_file", "Replace first occurrence of old_text with new_text. Include ALL three fields.",
    { path: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" } }, ["path", "old_text", "new_text"]),
  T("delete_file", "Delete a file or directory.", { path: { type: "string" }, recursive: { type: "boolean" } }, ["path"]),
  T("search_code", "Regex search across files.", { query: { type: "string" }, dir: { type: "string" }, ext: { type: "string" } }, ["query"]),

  T("run_command", "Run a shell command. Output streams LIVE to the user's terminal. Use for builds, tests, installs, git, anything. Non-zero exit is a real failure you must handle.",
    { command: { type: "string" }, cwd: { type: "string" }, timeout: { type: "number", description: "seconds, default 120" } }, ["command"]),
  T("start_server", "Start a long-running process (dev server) in the background and keep streaming its logs.",
    { command: { type: "string" }, cwd: { type: "string" }, port: { type: "number" }, wait: { type: "number" } }, ["command"]),
  T("list_processes", "List background processes you started.", {}),
  T("stop_server", "Stop one background process (or all).", { id: { type: "string" }, all: { type: "boolean" } }),

  T("web_search", "Search the live internet.", { query: { type: "string" }, n: { type: "number" } }, ["query"]),
  T("fetch_url", "Load a URL in a real browser, return readable text.", { url: { type: "string" } }, ["url"]),
  T("screenshot", "Render a local file or URL in Chromium and SEE it (image is returned to your vision). Installs the browser automatically if missing.",
    { file: { type: "string" }, url: { type: "string" }, width: { type: "number" }, height: { type: "number" }, fullPage: { type: "boolean" } }),
  T("browser_interact", "Click/fill/press/eval on a page, then screenshot the result.",
    { file: { type: "string" }, url: { type: "string" }, actions: { type: "array", items: { type: "object", properties: {
        type: { type: "string", enum: ["click", "fill", "press", "wait", "eval"] },
        selector: { type: "string" }, value: { type: "string" }, key: { type: "string" },
        ms: { type: "number" }, script: { type: "string" } }, required: ["type"] } } }, ["actions"]),

  T("think_parallel", "Ask 2-4 DIFFERENT models the same hard question simultaneously, then compare their answers. Use for architecture decisions, tricky bugs, or when you're unsure. Much better than guessing alone.",
    { question: { type: "string" }, context: { type: "string" }, n: { type: "number", description: "how many models, 2-4" } }, ["question"]),
  T("delegate_parallel", "Run several INDEPENDENT subtasks at once on different models (e.g. write 3 separate files). Each returns its result. Great for speed.",
    { tasks: { type: "array", items: { type: "object", properties: {
        id: { type: "string" }, prompt: { type: "string" }, role: { type: "string", enum: ["code", "fast", "plan", "review"] },
      }, required: ["id", "prompt"] } } }, ["tasks"]),
  T("review_code", "Have a second model critically review code for bugs/security/quality before you finalize.",
    { code: { type: "string" }, path: { type: "string" }, focus: { type: "string" } }),

  T("open_app", "Launch an application on the user's computer (e.g. 'notepad', 'Google Chrome', 'code', 'Spotify').",
    { name: { type: "string" }, args: { type: "string" } }, ["name"]),
  T("close_app", "Close/quit a running application by name.", { name: { type: "string" } }, ["name"]),
  T("list_apps", "List currently running applications with visible windows.", {}),
  T("open_path", "Open a file, folder or URL with the system default handler.", { target: { type: "string" } }, ["target"]),
  T("find_files", "Search the whole computer for files by name pattern (e.g. '*.pdf', 'invoice*').",
    { pattern: { type: "string" }, root: { type: "string", description: "default: user home" }, limit: { type: "number" } }, ["pattern"]),
  T("known_folders", "Get the real paths of Desktop, Documents, Downloads, Pictures, Music, Videos etc.", {}),

  T("clipboard_read", "Read the user's clipboard.", {}),
  T("clipboard_write", "Put text on the user's clipboard.", { text: { type: "string" } }, ["text"]),
  T("notify", "Show a desktop notification popup.", { title: { type: "string" }, message: { type: "string" } }, ["message"]),
  T("speak", "Speak text aloud through the speakers (JARVIS voice).", { text: { type: "string" } }, ["text"]),

  T("screen_capture", "Capture the user's actual screen and SEE it. Use to observe what they're doing or verify a desktop action.", {}),
  T("type_text", "Type text into whatever window currently has focus (real keyboard emulation).", { text: { type: "string" } }, ["text"]),
  T("press_keys", "Send a key combination to the focused window (Windows SendKeys syntax e.g. '^c', '%{TAB}'; xdotool syntax on Linux e.g. 'ctrl+c').",
    { keys: { type: "string" } }, ["keys"]),

  T("system_stats", "Live machine stats: CPU load, memory, disk space, battery, uptime.", {}),
  T("volume_control", "Control system volume.", { action: { type: "string", enum: ["up", "down", "mute", "set"] }, level: { type: "number" } }, ["action"]),
  T("power_control", "Lock, sleep, shutdown or restart the machine. Shutdown/restart are delayed and cancellable.",
    { action: { type: "string", enum: ["lock", "sleep", "shutdown", "restart", "cancel"] } }, ["action"]),

  T("schedule_task", "Schedule a command to run later (Task Scheduler on Windows, cron elsewhere).",
    { name: { type: "string" }, command: { type: "string" }, when: { type: "string", description: "Windows: HH:MM. Unix: cron expression '0 9 * * *'" } }, ["name", "command", "when"]),
  T("list_scheduled", "List tasks NEXUS has scheduled.", {}),
  T("unschedule_task", "Remove a scheduled task.", { name: { type: "string" } }, ["name"]),
  T("cursor_screenshot", "See the real screen with pixel coordinates so you can decide where to click. ALWAYS call this before clicking blind. Returns a downscaled image plus the true screen size.",
    { scale: { type: "number", description: "0.4-1.0, default 0.5" } }),
  T("cursor_click", "Physically move the mouse and click, like a human. Coordinates are in REAL screen pixels (use cursor_screenshot first and scale up if needed).",
    { x: { type: "number" }, y: { type: "number" }, button: { type: "string", enum: ["left", "right", "middle"] }, clicks: { type: "number" } }),
  T("cursor_move", "Move the mouse pointer without clicking.", { x: { type: "number" }, y: { type: "number" } }, ["x", "y"]),
  T("cursor_drag", "Drag from one point to another (select text, move a window, drag a file).",
    { x1: { type: "number" }, y1: { type: "number" }, x2: { type: "number" }, y2: { type: "number" } }, ["x1", "y1", "x2", "y2"]),
  T("cursor_scroll", "Scroll the wheel. Negative scrolls down, positive up.",
    { amount: { type: "number" }, x: { type: "number" }, y: { type: "number" } }, ["amount"]),
  T("cursor_type", "Type text on the real keyboard into whatever is focused.", { text: { type: "string" } }, ["text"]),
  T("cursor_key", "Press a key or hotkey combo, e.g. 'enter', 'ctrl+c', 'alt+tab', 'win+r'.", { keys: { type: "string" } }, ["keys"]),
  T("list_windows", "List open windows with titles and screen positions.", {}),
  T("focus_window", "Bring a window to the front by (partial) title match.", { title: { type: "string" } }, ["title"]),
  T("os_control_status", "Check whether physical cursor/keyboard control is available, and get the screen size.", {}),
  T("remember", "Store a durable fact about the user or project so you still know it next session. Use for preferences, stack choices, names, recurring habits, credentials hints (never secrets).",
    { text: { type: "string" }, kind: { type: "string", enum: ["preference", "fact", "project", "person", "habit"] },
      tags: { type: "array", items: { type: "string" } }, importance: { type: "number", description: "1-5" } }, ["text"]),
  T("recall", "Search your long-term memory.", { query: { type: "string" }, limit: { type: "number" } }),
  T("forget", "Delete a remembered item by id or matching text.", { id: { type: "string" } }, ["id"]),
  T("write_project_notes", "Write/overwrite NEXUS.md — the persistent project brief you read at the start of every session.",
    { text: { type: "string" } }, ["text"]),

  T("spawn_subagents", "Run up to 8 sub-agents IN PARALLEL, each with full tools and its own model. Use `needs` to declare dependencies — independent tasks run simultaneously, dependent ones wait for their inputs and receive those findings. Set isolate:true for agents that write files, so they work in private sandboxes and cannot clobber each other. This is the fastest way to do any task with separable parts.",
    { tasks: { type: "array", items: { type: "object", properties: {
        name: { type: "string", description: "short id, e.g. 'backend'" },
        goal: { type: "string", description: "complete self-contained instructions" },
        role: { type: "string", enum: ["code", "plan", "fast", "review"] },
        needs: { type: "array", items: { type: "string" }, description: "names of tasks that must finish first" },
        isolate: { type: "boolean", description: "true if this agent writes files" },
        maxSteps: { type: "number" },
      }, required: ["name", "goal"] } },
      merge: { type: "string", enum: ["keep-both", "overwrite", "skip"], description: "how to merge isolated outputs, default keep-both" } },
    ["tasks"]),

  T("undo_last_change", "Revert the most recent edit to a file (or the most recent edit overall). Every write is checkpointed automatically.",
    { file: { type: "string" } }),
  T("list_checkpoints", "List recent file checkpoints you can restore.", { n: { type: "number" } }),
  T("restore_checkpoint", "Restore a specific checkpoint by id.", { id: { type: "string" } }, ["id"]),

  T("mcp_status", "List connected MCP servers and their tools.", {}),
  T("mcp_add", "Add an MCP server to mcp.json and connect it, adding all its tools to your toolset.",
    { name: { type: "string" }, command: { type: "string" }, args: { type: "array", items: { type: "string" } },
      env: { type: "object" } }, ["name", "command"]),

  T("publish_website", "Put a website you built on the public internet and get its live URL. Call this as the LAST step of every web build (after you have run and verified it). Uses Vercel when VERCEL_TOKEN is set, otherwise a Render deploy hook, otherwise GitHub Pages; with none configured it serves a local preview and tells you which variable to set.",
    { dir: { type: "string", description: "folder containing the site (default: the workspace)" },
      name: { type: "string", description: "project name / subdomain (default: folder name)" },
      backend: { type: "string", enum: ["vercel", "render", "github"] },
      build: { type: "boolean", description: "run npm install + npm run build first for node projects (default true)" } }),

  T("ask_user", "Ask the user ONE short question when a decision is genuinely blocking and you cannot reasonably assume. Prefer deciding yourself and noting the assumption. Never use for routine confirmation.",
    { question: { type: "string" }, options: { type: "array", items: { type: "string" } } }, ["question"]),
  T("use_skill", "Load a specialised skill (a detailed workflow playbook) before doing that kind of work. Skills teach you rigorous methodology for code review, debugging, frontend design, TDD, deep research, etc.",
    { name: { type: "string" } }, ["name"]),
  T("list_skills", "List every skill available with its description.", {}),
  T("create_skill", "Write a new reusable skill so you permanently know how to do a task the user's way. Persists to skills/<name>/SKILL.md.",
    { name: { type: "string" }, description: { type: "string" }, body: { type: "string", description: "markdown playbook" },
      triggers: { type: "array", items: { type: "string" } } }, ["name", "body"]),

  T("git_status", "Branch, changed files and recent commits.", { cwd: { type: "string" } }),
  T("git_diff", "Show the actual diff. Read this before reviewing or committing.",
    { cwd: { type: "string" }, staged: { type: "boolean" }, file: { type: "string" }, stat: { type: "boolean" } }),
  T("git_commit", "Stage and commit with a conventional-commit message (feat:/fix:/docs:...). Write a real message describing why, not just what.",
    { message: { type: "string" }, cwd: { type: "string" }, all: { type: "boolean" } }, ["message"]),
  T("git_worktree", "Create/list/remove isolated git worktrees so parallel agents work on separate branches without colliding.",
    { action: { type: "string", enum: ["add", "list", "remove"] }, name: { type: "string" },
      branch: { type: "string" }, dir: { type: "string" }, cwd: { type: "string" } }, ["action"]),

  T("create_document", "Generate a real deliverable file: Word (docx), Excel (xlsx), PowerPoint (pptx) or PDF. Installs the Python library automatically. Use markdown in content; for pptx separate slides with ---.",
    { kind: { type: "string", enum: ["docx", "xlsx", "pptx", "pdf"] }, outPath: { type: "string" },
      title: { type: "string" }, content: { type: "string" },
      rows: { type: "array", description: "xlsx only: array of row arrays", items: { type: "array", items: { type: "string" } } } },
    ["kind", "outPath"]),

  T("analyze_data", "Profile a CSV/Excel/JSON/Parquet dataset with pandas: shape, dtypes, summary stats, missing values, top categories — and optionally render a chart PNG you can then look at.",
    { file: { type: "string" }, question: { type: "string" },
      chart: { type: "object", description: "{kind:'bar'|'line'|'scatter'|'hist', x, y, title, bins}" },
      outPath: { type: "string", description: "png path for the chart" } }, ["file"]),

  T("scaffold_project", "Bootstrap a real project from a template: next, vite-react, vite-vue, express, fastapi, python.",
    { kind: { type: "string" }, name: { type: "string" }, dir: { type: "string" } }, ["kind", "name"]),

  T("install_packages", "Install language packages properly (npm/pip). Prefer this over raw run_command so failures are reported clearly.",
    { manager: { type: "string", enum: ["npm", "pip"] }, packages: { type: "array", items: { type: "string" } },
      dev: { type: "boolean" }, cwd: { type: "string" } }, ["manager", "packages"]),
  T("android_status", "Check whether the Android build toolchain (JDK 17 + SDK) is installed and ready to produce APKs.", {}),
  T("android_setup", "Install everything needed to build APKs: JDK 17, Android SDK command-line tools, platform-tools, android-34 and build-tools. Downloads ~500MB once, streams progress. Run this before the first build.", {}),
  T("android_create", "Scaffold a complete, buildable Android app project. kind 'webview' wraps a URL or bundled HTML (best for turning a web app into an APK); kind 'native' is a plain Java activity.",
    { dir: { type: "string", description: "workspace-relative project folder" }, appName: { type: "string" },
      pkg: { type: "string", description: "e.g. com.you.myapp" },
      kind: { type: "string", enum: ["webview", "native"] },
      url: { type: "string", description: "webview: remote URL to load" },
      html: { type: "string", description: "webview: bundled HTML instead of a URL" } }, ["dir"]),
  T("android_build", "Compile the project into a real .apk. Returns the file path and size. First run also fetches Gradle. The APK is debug-signed so it installs on any phone.",
    { dir: { type: "string" }, variant: { type: "string", enum: ["debug", "release"] } }, ["dir"]),
  T("android_install", "Install a built APK onto a USB-connected phone or running emulator via adb.",
    { apk: { type: "string" } }, ["apk"]),
  T("run_in", "Run a command in a SPECIFIC shell/language, cross-platform. Use this when you need bash, powershell, cmd, python, node, deno, ruby, perl, php, go or sqlite specifically — NEXUS handles the invocation and quoting for you.",
    { shell: { type: "string", enum: ["bash","sh","zsh","powershell","pwsh","cmd","python","node","deno","ruby","perl","php","go","sqlite","auto"] },
      code: { type: "string", description: "the script/command body" },
      cwd: { type: "string" }, timeout: { type: "number" } }, ["shell", "code"]),
  T("shells_available", "Detect which shells and language runtimes exist on this machine, with versions. Call this before assuming a tool is installed.", {}),
  T("run_script", "Write a multi-line script to a temp file and execute it with the right interpreter. Best for anything longer than one line — avoids all quoting/escaping problems.",
    { lang: { type: "string", enum: ["bash","powershell","python","node","ruby","perl","php"] },
      code: { type: "string" }, args: { type: "string" }, cwd: { type: "string" }, timeout: { type: "number" } }, ["lang", "code"]),
  T("read_own_code", "Read NEXUS's own source. Omit file to list all. Files: " + SELF_FILES.join(", "),
    { file: { type: "string" } }),
  T("write_own_code", "REWRITE one of your own source files. Auto-snapshots to git first, then syntax-checks; a broken change is reverted automatically. Tell the user to restart the app for server-side changes to take effect.",
    { file: { type: "string" }, content: { type: "string" }, reason: { type: "string" } }, ["file", "content"]),
  T("patch_own_code", "Targeted edit of your own source (old_text -> new_text). Same git snapshot + syntax-check + auto-revert protection.",
    { file: { type: "string" }, old_text: { type: "string" }, new_text: { type: "string" }, reason: { type: "string" } }, ["file", "old_text", "new_text"]),
  T("self_test", "Syntax-check every one of your own source files. Run after modifying yourself.", {}),
  T("self_diff", "Show uncommitted changes to your own source.", { file: { type: "string" } }),
  T("self_history", "Recent snapshots of your own code.", { n: { type: "number" } }),
  T("rollback_self", "Undo self-modifications by resetting to a previous snapshot ref (default: last).",
    { ref: { type: "string" } }),
  T("restart_app", "Restart the NEXUS server so your code changes take effect. The UI reconnects automatically.", {}),
  T("system_info", "Facts about the host machine: OS, shell, CPU, installed toolchain (node/python/git/docker/browser).", {}),
];

/* ---------------- Implementations ---------------- */
async function tree(dir, depth = 0, max = 5, acc = [], baseDir = dir) {
  if (depth > max || acc.length > 3000) return acc;
  let ents;
  try { ents = await fs.readdir(dir, { withFileTypes: true }); } catch { return acc; }
  const skip = new Set(["node_modules", ".git", "__pycache__", ".venv", "venv", "dist", "build", ".next", ".cache", "ms-playwright"]);
  for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
    if (skip.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    const r = path.relative(baseDir, abs) || e.name;
    if (e.isDirectory()) { acc.push(r + path.sep); await tree(abs, depth + 1, max, acc, baseDir); }
    else { let s = 0; try { s = (await fs.stat(abs)).size; } catch {} acc.push(`${r} (${s}b)`); }
  }
  return acc;
}

const CACHE = { read: new TTLCache(15000, 120), tree: new TTLCache(8000, 40), web: new TTLCache(300000, 60) };
export function invalidateCache() { CACHE.read.clear(); CACHE.tree.clear(); }

/**
 * The user's real request, not the scaffolding we wrap around it.
 * A slash-command run carries the whole playbook in a [SKILL …] block, and the agent injects
 * [CONTEXT]/[SUPERVISOR]/[PUBLISHER] blocks too — those must never become the job title, the
 * memory record or the trigger text for skill matching.
 */
const INJECTED_BLOCK = /^\s*\[(SKILL|CONTEXT|PUBLISHER|SUPERVISOR|SUPERVISOR —|todo\.md|REMINDER|RECITE|SELF)/;
export function taskOf(messages) {
  for (const m of messages || []) {
    if (m?.role !== "user") continue;
    const c = typeof m.content === "string" ? m.content : "";
    if (!c.trim()) continue;
    if (INJECTED_BLOCK.test(c)) {
      const t = /\[USER TASK\]\s*([\s\S]+)$/.exec(c);
      if (t) return t[1].trim();
      continue;
    }
    return c;
  }
  const last = [...(messages || [])].reverse().find((m) => m?.role === "user");
  return typeof last?.content === "string" ? last.content : "";
}

/**
 * taskOf for the CURRENT request: a chained chat carries several [SKILL …] blocks, and the
 * stage being run is identified by the LAST real user message (or the last injected block's
 * [USER TASK]) — never by the first one. The supervisor's detectors and the learn pass
 * review the stage against this text.
 */
export function lastTaskOf(messages) {
  for (const m of [...(messages || [])].reverse()) {
    if (m?.role !== "user") continue;
    const c = typeof m.content === "string" ? m.content : "";
    if (!c.trim()) continue;
    if (INJECTED_BLOCK.test(c)) {
      const t = /\[USER TASK\]\s*([\s\S]+)$/.exec(c);
      if (t) return t[1].trim();
      continue;
    }
    return c;
  }
  return taskOf(messages);
}

/** Remember a file this run produced (used to decide what may be auto-published). */
function noteCtxFile(ctx, abs) {
  if (!ctx) return;
  if (!Array.isArray(ctx.written)) ctx.written = [];
  if (ctx.written.length < 400 && !ctx.written.includes(abs)) ctx.written.push(abs);
}

/** Publish with a hard deadline so a stuck upload cannot hang the agent run forever. */
function publishWithTimeout(opts, onLog, signal) {
  const ms = PUB.autoPublishMs();
  let done = false, timer = null;
  return new Promise((resolve) => {
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); resolve(v); };
    timer = setTimeout(() => finish({ ok: false, error: `publishing took longer than ${Math.round(ms / 1000)}s`, logs: [] }), ms);
    try {
      const r = PUB.publish({ ...opts, onLog, signal: signal || undefined });
      r.then(finish, (e) => finish({ ok: false, error: e?.message || String(e), logs: [] }));
    } catch (e) { finish({ ok: false, error: e?.message || String(e), logs: [] }); }
  });
}

export function makeImpl(ctx) {
  const { send, signal, freeOnly } = ctx;
  const depth = ctx.depth || 0;
  const emit = (o) => send(o);
  const runCtx = ctx.ctx && ctx.ctx.runId === ctx.runId ? ctx.ctx : ctx;   // the run's shared bookkeeping
  const note = (abs) => noteCtxFile(runCtx, abs);

  return {
    async update_plan(a = {}) {
      // models pass this in several shapes — normalise instead of failing
      let steps = a.steps || a.plan || a.todo || a.items;
      if (typeof steps === "string") {
        steps = steps.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
          const done = /^\s*[-*]?\s*\[x\]/i.test(l);
          return { title: l.replace(/^\s*[-*]?\s*(\[[ x]\])?\s*\d*[.)]?\s*/i, "").trim(), status: done ? "done" : "pending" };
        }).filter((s) => s.title);
      }
      if (!Array.isArray(steps) || !steps.length) return "ERROR: update_plan needs steps: [{title, status}].";
      // reject no-op re-plans (41% of all tool calls in benchmarking were update_plan)
      const sig = steps.map((s) => `${s.title}|${s.status}`).join("~");
      if (ctx._planSig === sig) return "Plan unchanged — skip this call and do the actual work.";
      ctx._planSig = sig;
      steps = steps.map((s) => typeof s === "string"
        ? { title: s, status: "pending" }
        : { title: String(s.title || s.step || s.name || ""), status: s.status || "pending" })
        .filter((s) => s.title);
      if (!steps.some((s) => s.status === "active") && steps.some((s) => s.status !== "done")) {
        const i = steps.findIndex((s) => s.status !== "done");
        if (i >= 0) steps[i].status = "active";
      }
      emit({ type: "plan", steps });
      ctx.plan = steps;                       // recited at the tail of every turn
      try {
        const md = "# TODO\n\n" + steps.map((s) =>
          `- [${s.status === "done" ? "x" : " "}] ${s.title}${s.status === "active" ? "  <- CURRENT" : ""}`
        ).join("\n") + "\n";
        await fs.writeFile(path.join(ROOT, "todo.md"), md, "utf8");
      } catch {}
      return "Plan updated and written to todo.md.";
    },

    async list_files({ dir = ".", depth = 4 }) {
      const d = resolvePath(dir);
      const key = d + "|" + depth;
      const hit = CACHE.tree.get(key); if (hit) return hit;
      const f = await tree(d, 0, Math.min(depth, 7), [], d);
      const out = `${d}\n` + (f.length ? f.slice(0, 800).join("\n") : "(empty)");
      CACHE.tree.set(key, out);
      return out;
    },
    async read_file({ path: p }) {
      const f = resolvePath(p);
      const hit = CACHE.read.get(f); if (hit) return hit;
      const t = await fs.readFile(f, "utf8");
      const out = t.length > 80000 ? t.slice(0, 80000) + "\n…[truncated]" : t;
      CACHE.read.set(f, out);
      return out;
    },
    async write_file({ path: p, content }) {
      const f = resolvePath(p);
      const hb = await HOOK.fire("before_write", { tool: "write_file", file: f, args: { path: p } }, (l) => emit({ type: "hook", text: l }));
      if (hb.blocked) return `BLOCKED by a before_write hook: ${hb.reason}`;
      await HOOK.checkpoint(f, "write_file");
      await fs.mkdir(path.dirname(f), { recursive: true });
      await fs.writeFile(f, content ?? "", "utf8");
      note(f); invalidateCache(); emit({ type: "file_changed", path: rel(f) });
      await HOOK.fire("after_write", { tool: "write_file", file: f }, (l) => emit({ type: "hook", text: l }));
      return `Wrote ${rel(f)} — ${(content || "").split("\n").length} lines, ${(content || "").length} bytes`;
    },
    async edit_file({ path: p, old_text, new_text }) {
      const f = resolvePath(p);
      const src = await fs.readFile(f, "utf8");
      await HOOK.checkpoint(f, "edit_file");
      if (src.includes(old_text)) {
        await fs.writeFile(f, src.replace(old_text, new_text), "utf8");
        invalidateCache(); emit({ type: "file_changed", path: rel(f) });
        return `Edited ${rel(f)}`;
      }
      const norm = (s) => s.replace(/\s+/g, " ").trim();
      const line = src.split("\n").find((l) => norm(l) === norm(old_text));
      if (line) {
        await fs.writeFile(f, src.replace(line, new_text), "utf8");
        invalidateCache(); emit({ type: "file_changed", path: rel(f) });
        return `Edited ${rel(f)} (fuzzy match)`;
      }
      return `ERROR: old_text not found in ${rel(f)}. read_file it again and match exactly, or use write_file.`;
    },
    async delete_file({ path: p, recursive = true }) {
      const f = resolvePath(p);
      await HOOK.checkpoint(f, "delete_file");
      await fs.rm(f, { recursive, force: true });
      invalidateCache(); emit({ type: "file_changed", path: rel(f) });
      return `Deleted ${rel(f)}`;
    },
    async search_code({ query, dir = ".", ext }) {
      const base = resolvePath(dir);
      const files = (await tree(base, 0, 5, [], base)).filter((f) => !f.endsWith(path.sep)).map((f) => f.replace(/ \(\d+b\)$/, ""));
      let re; try { re = new RegExp(query, "i"); } catch { re = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); }
      const out = [];
      for (const f of files) {
        if (ext && !f.endsWith(ext)) continue;
        let txt; try { txt = await fs.readFile(path.join(base, f), "utf8"); } catch { continue; }
        txt.split("\n").forEach((l, i) => { if (out.length < 80 && re.test(l)) out.push(`${f}:${i + 1}: ${l.trim().slice(0, 180)}`); });
      }
      return out.length ? out.join("\n") : "No matches.";
    },
    async run_command({ command, cwd, timeout = 120 }) {
      const dir = cwd ? resolvePath(cwd) : ROOT;
      // Backgrounding here escapes process tracking and leaks the port forever.
      const cmdStr = String(command).trim();
      const bgTail = /(^|[^&])&$/.test(cmdStr);                  // trailing single & only
      const bgMid  = /[^&]&\s*(\n|;|disown|sleep|echo)/.test(cmdStr);
      if (bgTail || bgMid || /\bnohup\b|\bsetsid\b/.test(cmdStr)) {
        return "REFUSED: do not background a process with '&' in run_command — it leaks and " +
               "squats the port. Use start_server({command, port}) instead; it is tracked and " +
               "stopped automatically when the task ends.";
      }
      const termId = "t" + Math.random().toString(36).slice(2, 8);
      emit({ type: "term_open", id: termId, cmd: command, cwd: rel(dir) });
      const r = await runStream(command, {
        cwd: dir, timeout,
        onData: ({ stream, text }) => emit({ type: "term_data", id: termId, stream, text }),
      });
      emit({ type: "term_close", id: termId, code: r.code, timedOut: r.timedOut });
      let out = `$ ${command}\n(cwd: ${rel(dir)})\nexit code: ${r.code}${r.timedOut ? " (TIMED OUT)" : ""}`;
      if (r.stdout) out += `\n--- stdout ---\n${r.stdout.slice(0, 24000)}`;
      if (r.stderr) out += `\n--- stderr ---\n${r.stderr.slice(0, 10000)}`;
      return out;
    },
    async start_server({ command, cwd, port, wait = 4 }) {
      const dir = cwd ? resolvePath(cwd) : ROOT;
      const termId = "s" + Math.random().toString(36).slice(2, 8);
      emit({ type: "term_open", id: termId, cmd: command, cwd: rel(dir), server: true });
      const rec = startBackground(command, {
        cwd: dir, owner: ctx.runId,
        onData: ({ stream, text }) => emit({ type: "term_data", id: termId, stream, text }),
      });
      await new Promise((r) => setTimeout(r, Math.min(wait, 25) * 1000));
      let probe = "";
      if (port) {
        const p = await runStream(
          IS_WIN ? `powershell -Command "(Invoke-WebRequest -UseBasicParsing http://127.0.0.1:${port}/ -TimeoutSec 5).StatusCode"`
                 : `curl -s -o /dev/null -w "%{http_code}" -m 5 http://127.0.0.1:${port}/`,
          { cwd: dir, timeout: 15 });
        probe = `\nHTTP probe :${port} -> ${(p.stdout || p.stderr || "no response").trim()}`;
        emit({ type: "server_up", id: rec.id, port, url: `http://localhost:${port}` });
      }
      return `Started ${rec.id} (pid ${rec.pid}): ${command}${probe}\nLogs so far:\n${rec.log.slice(0, 1500) || "(none)"}`;
    },
    async list_processes() {
      if (!PROCS.size) return "No background processes.";
      return [...PROCS.values()].map((p) => `${p.id} pid=${p.pid} ${p.exited ? `exited(${p.code})` : "running"} :: ${p.cmd}`).join("\n");
    },
    async stop_server({ id, all }) {
      if (all || !id) return `Stopped ${killAll()} process(es).`;
      return killProc(id) ? `Stopped ${id}` : `No such process ${id}`;
    },

    async web_search({ query, n = 8 }) {
      const hit = CACHE.web.get(query + n); if (hit) return hit;
      const r = await webSearch(query, n);
      const out = r.length ? r.map((x, i) => `${i + 1}. ${x.title}\n   ${x.url}\n   ${x.snippet}`).join("\n\n") : "No results.";
      CACHE.web.set(query + n, out);
      return out;
    },
    async fetch_url({ url }) { return await fetchText(url); },
    async screenshot(a) {
      const r = await screenshot({ ...a, root: ROOT });
      return { __image: r.url, __text:
        `Rendered ${a.url || a.file}\nTitle: ${r.title || "(none)"}\n` +
        (r.errors.length ? `JS ERRORS:\n${r.errors.join("\n")}\n` : "No JS errors.\n") +
        (r.console.length ? `Console:\n${r.console.join("\n")}\n` : "") +
        `Visible text:\n${(r.text || "").slice(0, 1500)}` };
    },
    async browser_interact(a) {
      const r = await interact({ ...a, root: ROOT });
      return { __image: r.url, __text:
        `Actions:\n${r.actions.join("\n") || "(none)"}\n` +
        (r.errors.length ? `JS ERRORS:\n${r.errors.join("\n")}\n` : "No JS errors.\n") +
        `Text after actions:\n${(r.text || "").slice(0, 1500)}` };
    },

    async think_parallel({ question, context = "", n = 3 }) {
      const count = Math.max(2, Math.min(n, 4));
      const chains = await Promise.all(["plan", "code", "review", "fast"].slice(0, count).map((r) => chainFor(r, null, freeOnly)));
      const used = new Set();
      const jobs = chains.map((c, i) => {
        const pickId = c.find((id) => !used.has(id)) || c[0];
        used.add(pickId);
        return { id: "m" + i, chain: [pickId, ...c.filter((x) => x !== pickId)],
          body: { temperature: 0.4, messages: [
            { role: "system", content: "You are an expert engineer. Answer directly and concisely with concrete reasoning. No preamble." },
            { role: "user", content: (context ? `Context:\n${context}\n\n` : "") + question }] } };
      });
      emit({ type: "parallel_start", label: "think", models: jobs.map((j) => j.chain[0]) });
      const res = await parallel(jobs, { signal, onSwitch: (m) => emit({ type: "model_switch", model: m }) });
      emit({ type: "parallel_end", label: "think", results: res.map((r) => ({ model: r.model, ok: r.ok })) });
      return res.map((r) => r.ok
        ? `### ${r.model}\n${r.text.slice(0, 3000)}`
        : `### ${r.id} FAILED: ${r.error}`).join("\n\n---\n\n") +
        "\n\nCompare these perspectives, take the strongest reasoning, and proceed.";
    },
    async delegate_parallel({ tasks }) {
      const list = tasks.slice(0, 8);
      const jobs = await Promise.all(list.map(async (t) => ({
        id: t.id,
        chain: await chainFor(t.role || "code", null, freeOnly),
        body: { temperature: 0.25, messages: [
          { role: "system", content: "You are a senior engineer. Produce complete, correct, production-ready output. No placeholders, no commentary unless asked." },
          { role: "user", content: t.prompt }] },
      })));
      emit({ type: "parallel_start", label: "delegate", models: jobs.map((j) => j.chain[0]), ids: list.map((t) => t.id) });
      const res = await parallel(jobs, { signal, onSwitch: (m) => emit({ type: "model_switch", model: m }) });
      emit({ type: "parallel_end", label: "delegate", results: res.map((r) => ({ model: r.model, ok: r.ok, id: r.id })) });
      return res.map((r) => r.ok ? `### TASK ${r.id} (${r.model})\n${r.text.slice(0, 6000)}` : `### TASK ${r.id} FAILED: ${r.error}`).join("\n\n");
    },
    async review_code({ code, path: p, focus = "" }) {
      let src = code;
      if (!src && p) src = await fs.readFile(resolvePath(p), "utf8");
      if (!src) return "Provide code or path.";
      const chain = await chainFor("review", null, freeOnly);
      emit({ type: "parallel_start", label: "review", models: [chain[0]] });
      const { res, model } = await complete({
        temperature: 0.2,
        messages: [
          { role: "system", content: "You are a ruthless senior code reviewer. List concrete bugs, security issues, and correctness problems with line references. Be specific. If it's solid, say so briefly." },
          { role: "user", content: `${focus ? "Focus: " + focus + "\n\n" : ""}Review this code:\n\n\`\`\`\n${src.slice(0, 40000)}\n\`\`\`` }],
      }, { chain, signal, onSwitch: (m) => emit({ type: "model_switch", model: m }) });
      emit({ type: "parallel_end", label: "review", results: [{ model, ok: true }] });
      return `Review by ${model}:\n\n${res.choices[0].message.content}`;
    },

    async write_own_code({ file, content, reason }) {
      const r = await SELF.writeSelf({ file, content });
      invalidateCache();
      emit({ type: "self_edit", file, ok: r.ok, reason: reason || "" });
      if (!r.ok) return r.error;
      return `Rewrote own source ${file} (${r.lines} lines). Snapshot ${r.ref}. Syntax OK.\n` +
        `NOTE: server-side files need restart_app to take effect; public/* files only need a browser refresh.`;
    },
    async patch_own_code({ file, old_text, new_text, reason }) {
      const r = await SELF.patchSelf({ file, old_text, new_text });
      invalidateCache();
      emit({ type: "self_edit", file, ok: r.ok, reason: reason || "" });
      if (!r.ok) return r.error;
      return `Patched own source ${file}. Snapshot ${r.ref}. Syntax OK.\n` +
        `NOTE: server-side files need restart_app; public/* only needs a refresh.`;
    },
    async self_test() {
      const r = await SELF.selfTest();
      return (r.ok ? "ALL SOURCE FILES PARSE\n" : "PROBLEMS FOUND\n") + r.report;
    },
    async self_diff({ file }) { return await SELF.diff(file); },
    async self_history({ n = 10 }) { return await SELF.history(n); },
    async rollback_self({ ref }) {
      const r = await SELF.rollback(ref);
      invalidateCache();
      emit({ type: "self_edit", file: "(rollback)", ok: true, reason: ref || "HEAD~1" });
      return r + " — restart_app to load the reverted code.";
    },
    async restart_app() {
      const t = await SELF.selfTest();
      if (!t.ok) return "REFUSING to restart: source files have syntax errors.\n" + t.report;
      emit({ type: "restarting" });
      setTimeout(() => process.exit(42), 900);  // 42 = supervisor relaunch signal
      return "Syntax OK. Restarting now — the UI will reconnect in a few seconds.";
    },

    async open_app({ name, args }) { return await J.openApp(name, args || ""); },
    async close_app({ name }) { return await J.closeApp(name); },
    async list_apps() { return await J.listApps(); },
    async open_path({ target }) { return await J.openPath(target); },
    async find_files({ pattern, root, limit = 60 }) { return await J.findFiles(pattern, root, limit); },
    async known_folders() { return JSON.stringify(J.places(), null, 2); },

    async clipboard_read() { return await J.clipRead(); },
    async clipboard_write({ text }) { return await J.clipWrite(text); },
    async notify({ title = "NEXUS", message }) { return await J.notify(title, message); },
    async speak({ text }) { emit({ type: "speaking", text }); return await J.speak(text); },

    async screen_capture() {
      const r = await J.screenGrab();
      if (!r.ok) return "Screen capture failed: " + r.error;
      const name = `screen-${Date.now()}.png`;
      const dest = path.join(SHOTS_DIR, name);
      await fs.copyFile(r.file, dest);
      await fs.rm(r.file, { force: true });
      return { __image: "/shots/" + name, __text: "Captured the user's screen. Study it and describe/act on what you see." };
    },
    async type_text({ text }) { return await J.typeText(text); },
    async press_keys({ keys }) { return await J.pressKeys(keys); },

    async system_stats() { return await J.stats(); },
    async volume_control({ action, level }) { return await J.volume(action, level); },
    async power_control({ action }) {
      emit({ type: "power", action });
      return await J.power(action);
    },

    async schedule_task({ name, command, when }) { return await J.schedule(name, command, when); },
    async list_scheduled() { return await J.listScheduled(); },
    async unschedule_task({ name }) { return await J.unschedule(name); },

    async cursor_screenshot({ scale = 0.5 }) {
      const r = await OS.call("screenshot", { scale });
      const name = `desk-${Date.now()}.png`;
      await fs.writeFile(path.join(SHOTS_DIR, name), Buffer.from(r.image, "base64"));
      return { __image: "/shots/" + name,
        __text: `Real screen captured. TRUE screen size: ${r.screen[0]}x${r.screen[1]} px. ` +
          `The image you see is scaled to ${r.scale}. To click something, take its position in the image ` +
          `and DIVIDE by ${r.scale} to get real screen coordinates.` };
    },
    async cursor_click(a) { return JSON.stringify(await OS.call("click", a)); },
    async cursor_move(a) { return JSON.stringify(await OS.call("move", a)); },
    async cursor_drag(a) { return JSON.stringify(await OS.call("drag", a)); },
    async cursor_scroll(a) { return JSON.stringify(await OS.call("scroll", a)); },
    async cursor_type(a) { return JSON.stringify(await OS.call("type", a)); },
    async cursor_key(a) { return JSON.stringify(await OS.call("key", a)); },
    async list_windows() { return JSON.stringify((await OS.call("windows")).windows, null, 1); },
    async focus_window(a) { return JSON.stringify(await OS.call("focus_window", a)); },
    async os_control_status() {
      const s = await OS.status();
      return JSON.stringify(s, null, 2) + (s.available ? "" :
        "\n\nTo enable physical cursor control, run:  pip install pyautogui pillow");
    },

    async remember(a) { return await MEM.remember(a); },
    async recall({ query = "", limit = 25 }) {
      const r = await MEM.recall(query, limit);
      return r.length ? r.map((f) => `#${f.id} [${f.kind}] ${f.text}`).join("\n") : "Nothing remembered matching that.";
    },
    async forget({ id }) { return await MEM.forget(id); },
    async write_project_notes({ text }) { return await MEM.writeProjectNotes(text); },

    async spawn_subagents({ tasks, merge = "keep-both" }) {
      if (depth >= 2) return "Subagent depth limit reached — do this work directly instead of spawning more agents.";
      const list = (tasks || []).slice(0, 8).filter((t) => t && t.name && t.goal);
      if (!list.length) return "No valid tasks given. Each needs {name, goal}.";

      const waves = SWARM.planWaves(list);
      const board = new SWARM.Board();
      const all = [];
      const cells = new Map();
      const t0 = Date.now();

      emit({ type: "subagents_start", names: list.map((t) => t.name),
             waves: waves.map((w) => w.map((t) => t.name)) });

      for (let wi = 0; wi < waves.length; wi++) {
        const wave = waves[wi];
        const conc = SWARM.idealConcurrency(wave.length, os.cpus()?.length || 4);
        emit({ type: "wave_start", wave: wi + 1, of: waves.length,
               names: wave.map((t) => t.name), concurrency: conc });

        const results = await pool(wave, conc, async (t) => {
          const started = Date.now();
          let cell = null;
          if (t.isolate) {
            try { cell = await SWARM.makeCell(ROOT, t.name); cells.set(t.name, cell); } catch {}
          }
          const subSend = (o) => emit({ ...o, subagent: t.name });
          try {
            const convo = await runAgent({
              model: null, freeOnly, signal, send: subSend,
              maxSteps: Math.min(t.maxSteps || 14, 20),
              messages: [{ role: "user", content:
                `You are sub-agent "${t.name}" working in parallel with others on one larger task.\n\n` +
                `GOAL: ${t.goal}\n\n` +
                (cell ? `WRITE ALL FILES UNDER: ${path.relative(ROOT, cell)}  (your private sandbox — ` +
                        `other agents cannot see or overwrite it; it is merged back at the end)\n\n` : "") +
                board.digest() +
                `\nDo the work, verify it, then finish with a short report of what you produced.` }],
              _role: t.role || "code", _depth: depth + 1, _runId: ctx.runId,
            });
            const final = [...convo].reverse().find((m) => m.role === "assistant" && m.content)?.content || "(no summary)";
            board.add(t.name, final);
            emit({ type: "subagent_done", name: t.name, ok: true, ms: Date.now() - started });
            return { name: t.name, ok: true, report: String(final).slice(0, 4000), ms: Date.now() - started };
          } catch (e) {
            emit({ type: "subagent_done", name: t.name, ok: false, ms: Date.now() - started });
            return { name: t.name, ok: false, report: "FAILED: " + e.message, ms: Date.now() - started };
          }
        });
        all.push(...results.filter(Boolean));
      }

      // fold private sandboxes back into the workspace
      let mergeNote = "";
      if (cells.size) {
        const moved = [], skipped = [];
        for (const [, dir] of cells) {
          try {
            const r = await SWARM.mergeCell(dir, ROOT, merge);
            moved.push(...r.moved); skipped.push(...r.skipped);
            for (const rel of r.moved) {                     // merged files count as written this run
              note(path.isAbsolute(rel) ? rel : path.join(ROOT, rel));
            }
            await fs.rm(dir, { recursive: true, force: true });
          } catch {}
        }
        try { await fs.rm(path.join(ROOT, ".swarm"), { recursive: true, force: true }); } catch {}
        invalidateCache();
        mergeNote = `\n\nMERGED ${moved.length} file(s) into the workspace` +
          (moved.length ? `:\n${moved.slice(0, 25).join("\n")}` : "") +
          (skipped.length ? `\nSkipped (already existed): ${skipped.slice(0, 10).join(", ")}` : "");
        emit({ type: "swarm_merge", moved: moved.length, skipped: skipped.length });
      }

      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      const serial = (all.reduce((n, r) => n + (r.ms || 0), 0) / 1000).toFixed(1);
      emit({ type: "subagents_end", results: all.map((r) => ({ name: r.name, ok: r.ok })),
             ms: Date.now() - t0, speedup: +(serial / Math.max(+secs, 0.1)).toFixed(1) });

      return `${all.length} agents across ${waves.length} wave(s) in ${secs}s ` +
        `(${serial}s of work — ~${(serial / Math.max(+secs, 0.1)).toFixed(1)}x speedup)\n\n` +
        all.map((r) => `### ${r.name} ${r.ok ? "✓" : "✗ FAILED"} (${((r.ms || 0) / 1000).toFixed(1)}s)\n${r.report}`)
           .join("\n\n---\n\n") + mergeNote;
    },

    async undo_last_change({ file }) { invalidateCache(); return await HOOK.undoLast(file ? resolvePath(file) : undefined); },
    async list_checkpoints({ n = 30 }) {
      const l = await HOOK.listCheckpoints(n);
      return l.length ? l.map((c) => `${c.id}  ${new Date(c.at).toLocaleString()}  ${c.file} (${c.bytes}b)`).join("\n") : "No checkpoints yet.";
    },
    async restore_checkpoint({ id }) { invalidateCache(); return await HOOK.restore(id); },

    async mcp_status() {
      const s = MCP.status();
      return s.length ? s.map((x) => `${x.name}: ${x.ready ? "ready" : "down"} — ${x.tools.join(", ") || "no tools"}`).join("\n")
        : "No MCP servers connected. Add one with mcp_add, or edit mcp.json.";
    },
    async mcp_add({ name, command, args = [], env = {} }) {
      const cfg = await MCP.loadConfig();
      cfg.mcpServers = cfg.mcpServers || {};
      cfg.mcpServers[name] = { command, args, env };
      await MCP.saveConfig(cfg);
      try {
        const srv = await MCP.connect(name, cfg.mcpServers[name]);
        emit({ type: "mcp", name, tools: srv.tools.length });
        return `Connected MCP "${name}" — ${srv.tools.length} new tools now available: ${srv.tools.map((t) => t.name).join(", ")}`;
      } catch (e) { return "Saved to mcp.json but connection failed: " + e.message; }
    },

    async ask_user({ question, options = [] }) {
      emit({ type: "ask", question, options });
      return `Asked the user: "${question}". They will answer in their next message — stop and wait; do not guess.`;
    },

    async publish_website({ dir = ".", name, backend, build = true }) {
      const target = resolvePath(dir);
      const site = await PUB.detectSite(target);
      if (!site) {
        return `No website found in ${rel(target)} — I look for an index.html, or a package.json with a build ` +
               `script. Point me at the folder that holds the built site (or call scaffold_project first).`;
      }
      const host = PUB.backends().find((b) => b.id === backend) || PUB.primary();

      // Nothing configured: still make the work visible locally, and say exactly what to set.
      if (!host || !host.ready) {
        const port = 4400 + Math.floor(Math.random() * 400);
        const py = IS_WIN ? "python" : "python3";
        const serveDir = site.outDir || site.dir;
        try {
          startBackground(`${py} -m http.server ${port} --bind 0.0.0.0`,
            { cwd: serveDir, name: "site-preview", owner: ctx.runId,
              onData: ({ text }) => emit({ type: "term_data", id: "publish", stream: "stdout", text }) });
        } catch {}
        const url = `http://localhost:${port}/`;
        emit({ type: "publish", ok: false, local: true, url, dir: rel(serveDir), backend: "local" });
        return `NOT published publicly — no host is configured — but the site is served locally at ${url}\n` +
          `(from ${rel(serveDir)}).\nTo publish for real, set ONE of these in .env and ask me again:\n` +
          `  • VERCEL_TOKEN=…            (vercel.com/account/tokens — simplest, deploys straight from the API)\n` +
          `  • RENDER_DEPLOY_HOOK_URL=…  (Render dashboard → your static site → Settings → Deploy Hook)\n` +
          `  • PUBLISH_GITHUB_REPO=owner/repo  (needs an authenticated gh CLI)\n` +
          `Tell the user the site is only on localhost and needs one of those to go public.`;
      }

      emit({ type: "publish_start", dir: rel(site.dir), backend: host.id });
      const r = await publishWithTimeout({ dir: site.dir, name, backend },
        (txt) => emit({ type: "publish_log", text: String(txt).slice(0, 400) }), signal)
        .catch((e) => ({ ok: false, error: e?.message || String(e), logs: [] }));
      ctx.published = true;
      ctx.publishedUrl = r?.url || null;
      emit({ type: "publish", ok: !!r?.ok, url: r?.url || null, backend: r?.backend || host.id,
             files: r?.files, bytes: r?.bytes, error: r?.error || null, dir: rel(site.dir) });
      if (r?.ok && r.url) {
        return `Published to ${host.label}: ${r.url}\n(${r.files} files, ${(r.bytes / 1024).toFixed(0)} KB from ` +
          `${rel(r.dir || site.dir)}${r.note ? "; " + r.note : ""})\nReport this URL to the user as a markdown link.`;
      }
      return `Publishing to ${host.label} failed: ${r?.error || "unknown error"}\n` +
        `Fix the cause and call publish_website again, or tell the user what is missing. ` +
        `Full log:\n${(r?.logs || []).join("").slice(0, 1500)}`;
    },

    async use_skill({ name }) {
      const sk = await SKILL.get(name);
      if (!sk) {
        const all = await SKILL.list();
        return `No skill "${name}". Available: ${all.map((x) => x.name).join(", ") || "(none)"}`;
      }
      emit({ type: "skill", name: sk.name });
      return `=== SKILL: ${sk.name} ===\n${sk.body}\n=== END SKILL ===\nFollow this methodology for the current task.`;
    },
    async list_skills() {
      const all = await SKILL.list();
      return all.length ? all.map((s) => `${s.name} — ${s.description}${s.triggers.length ? ` (triggers: ${s.triggers.join(", ")})` : ""}`).join("\n") : "No skills installed.";
    },
    async create_skill({ name, description, body, triggers = [] }) {
      return await SKILL.install({ name, description, body, triggers });
    },

    async git_status({ cwd }) { return await DEV.gitStatus(cwd ? resolvePath(cwd) : ROOT); },
    async git_diff({ cwd, staged, file, stat }) { return await DEV.gitDiff(cwd ? resolvePath(cwd) : ROOT, { staged, file, stat }); },
    async git_commit({ message, cwd, all = true }) { return await DEV.gitCommit(cwd ? resolvePath(cwd) : ROOT, { message, all }); },
    async git_worktree({ action, name, branch, dir, cwd }) {
      const c = cwd ? resolvePath(cwd) : ROOT;
      if (action === "add") return await DEV.worktreeAdd(c, { name: name || "agent", branch });
      if (action === "remove") return await DEV.worktreeRemove(c, dir);
      return await DEV.worktreeList(c);
    },

    async create_document(a) {
      if (a?.outPath) { try { note(resolvePath(a.outPath)); } catch {} }
      const out = resolvePath(a.outPath);
      await fs.mkdir(path.dirname(out), { recursive: true });
      const r = await DEV.makeDocument({ ...a, outPath: out }, ROOT, (t) => emit({ type: "term_data", id: "setup", stream: "stdout", text: t }));
      invalidateCache();
      emit({ type: "file_changed", path: rel(out) });
      return r;
    },
    async analyze_data(a) {
      if (a?.outPath) { try { note(resolvePath(a.outPath)); } catch {} }
      const f = resolvePath(a.file);
      const out = a.outPath ? resolvePath(a.outPath) : "";
      if (out) await fs.mkdir(path.dirname(out), { recursive: true }).catch(() => {});
      try { await fs.access(f); }
      catch { return `ERROR: ${rel(f)} does not exist. Create it first (write_file), then analyze it.`; }
      const r = await DEV.analyzeData({ ...a, file: f, outPath: out }, ROOT, (t) => emit({ type: "term_data", id: "setup", stream: "stdout", text: t }));
      if (out) {
        try {
          const name = `chart-${Date.now()}.png`;
          await fs.copyFile(out, path.join(SHOTS_DIR, name));
          return { __image: "/shots/" + name, __text: r + "\n\nThe chart is shown to you — read it and describe what it reveals." };
        } catch {}
      }
      return r;
    },
    async scaffold_project(a) {
      const d = a.dir ? resolvePath(a.dir) : ROOT;
      invalidateCache();
      return await DEV.scaffold({ ...a, dir: d }, ROOT, (t) => emit({ type: "term_data", id: "setup", stream: "stdout", text: t }));
    },
    async install_packages({ manager, packages, dev, cwd }) {
      const d = cwd ? resolvePath(cwd) : ROOT;
      const cmd = manager === "pip"
        ? `${IS_WIN ? "python" : "python3"} -m pip install --user ${packages.join(" ")}`
        : `npm install ${dev ? "--save-dev " : ""}${packages.join(" ")}`;
      const termId = "i" + Math.random().toString(36).slice(2, 7);
      emit({ type: "term_open", id: termId, cmd, cwd: rel(d) });
      const r = await runStream(cmd, { cwd: d, timeout: 600, onData: ({ stream, text }) => emit({ type: "term_data", id: termId, stream, text }) });
      emit({ type: "term_close", id: termId, code: r.code });
      return r.code === 0 ? `Installed: ${packages.join(", ")}` : `Install failed (exit ${r.code}):\n${(r.stderr || r.stdout).slice(-1500)}`;
    },

    async android_status() { return JSON.stringify(await ANDROID.status(), null, 2); },
    async android_setup() {
      const termId = "and" + Math.random().toString(36).slice(2, 6);
      emit({ type: "term_open", id: termId, cmd: "android toolchain setup", cwd: "." });
      const r = await ANDROID.installSdk((t) => emit({ type: "term_data", id: termId, stream: "stdout", text: t }));
      emit({ type: "term_close", id: termId, code: r.ok ? 0 : 1 });
      return r.ok ? "Android toolchain ready — JDK 17, SDK, platform 34, build-tools 34."
                  : "Setup failed: " + (r.error || "unknown");
    },
    async android_create(a) {
      const dir = resolvePath(a.dir);
      await fs.mkdir(dir, { recursive: true });
      const r = await ANDROID.scaffold({ ...a, dir });
      invalidateCache();
      emit({ type: "file_changed", path: rel(dir) });
      return r + "\nNext: android_build with the same dir.";
    },
    async android_build(a) {
      const dir = resolvePath(a.dir);
      const termId = "gr" + Math.random().toString(36).slice(2, 6);
      emit({ type: "term_open", id: termId, cmd: `gradlew assemble${(a.variant || "debug") === "release" ? "Release" : "Debug"}`, cwd: rel(dir) });
      const r = await ANDROID.build({ dir, variant: a.variant || "debug" },
        (t) => emit({ type: "term_data", id: termId, stream: "stdout", text: t }));
      emit({ type: "term_close", id: termId, code: r.ok ? 0 : 1 });
      invalidateCache();
      if (!r.ok) return "APK BUILD FAILED:\n" + r.error + "\n\nRead the error, fix the project, and rebuild.";
      emit({ type: "artifact", kind: "apk", path: r.apk, sizeMB: r.sizeMB });
      return `APK BUILT: ${r.apk} (${r.sizeMB} MB)\nDebug-signed — installable on any phone with 'unknown sources' enabled.`;
    },
    async android_install({ apk }) {
      return await ANDROID.install(resolvePath(apk), (t) => emit({ type: "term_data", id: "setup", stream: "stdout", text: t }));
    },

    async shells_available() { return JSON.stringify(await DEV.detectShells(), null, 2); },
    async run_in({ shell, code, command, script, cwd, timeout = 180 }) {
      code = code || command || script;
      if (!code || !String(code).trim())
        return "ERROR: run_in needs `code` (the command/script text). Example: {shell:'bash', code:'ls -la'}";
      shell = shell || (IS_WIN ? "powershell" : "bash");
      const dir = cwd ? resolvePath(cwd) : ROOT;
      const id = "r" + Math.random().toString(36).slice(2, 7);
      const cmd = DEV.buildShellCmd(shell, code);
      emit({ type: "term_open", id, cmd: `[${shell}] ${code.split("\n")[0].slice(0, 70)}`, cwd: rel(dir) });
      const r = await runStream(cmd, { cwd: dir, timeout,
        onData: ({ stream, text }) => emit({ type: "term_data", id, stream, text }) });
      emit({ type: "term_close", id, code: r.code, timedOut: r.timedOut });
      let out = `[${shell}] exit ${r.code}${r.timedOut ? " (TIMED OUT)" : ""}`;
      if (r.stdout) out += `\n--- stdout ---\n${r.stdout.slice(0, 24000)}`;
      if (r.stderr) out += `\n--- stderr ---\n${r.stderr.slice(0, 10000)}`;
      return out;
    },
    async run_script({ lang, code, script, args = "", cwd, timeout = 300 }) {
      code = code || script;
      if (!code) return "ERROR: run_script needs a 'code' string containing the script body.";
      const dir = cwd ? resolvePath(cwd) : ROOT;
      const id = "s" + Math.random().toString(36).slice(2, 7);
      emit({ type: "term_open", id, cmd: `[${lang} script] ${code.split("\n")[0].slice(0, 60)}`, cwd: rel(dir) });
      const r = await DEV.runScript({ lang, code, args, cwd: dir, timeout },
        (d) => emit({ type: "term_data", id, ...d }));
      emit({ type: "term_close", id, code: r.code, timedOut: r.timedOut });
      invalidateCache();
      let out = `[${lang}] exit ${r.code}`;
      if (r.stdout) out += `\n--- stdout ---\n${r.stdout.slice(0, 24000)}`;
      if (r.stderr) out += `\n--- stderr ---\n${r.stderr.slice(0, 10000)}`;
      return out;
    },

    async read_own_code({ file }) {
      if (!file) return "NEXUS source files:\n" + SELF_FILES.join("\n") + `\n\nApp dir: ${APP_DIR}`;
      const t = await selfSource(file);
      return `--- ${file} ---\n` + (t.length > 60000 ? t.slice(0, 60000) + "\n…[truncated]" : t);
    },
    async system_info() {
      const info = sysInfo(ROOT);
      const tc = await detectToolchain();
      return JSON.stringify({ ...info, toolchain: tc, appDir: APP_DIR, workspace: ROOT }, null, 2);
    },
  };
}

/* ---------------- System prompt ---------------- */
export function systemPrompt(env) {
  return `You are NEXUS — the user's personal JARVIS. You run directly on their computer and you
operate it on their behalf: launching apps, managing files anywhere on disk, reading the
clipboard, seeing their actual screen, speaking aloud, controlling volume and power,
scheduling tasks, and writing/running any code. You are an autopilot, not a chatbot.

HOST: ${env.platform} (${env.osRelease}) · shell: ${env.shell} · ${env.cpus} cores · ${env.memGB}GB RAM · node ${env.node}
WORKSPACE: ${env.cwd}
FULL-PC ACCESS: ${isFull() ? "ENABLED — the whole machine is yours: read/write anywhere the user can, run any command, control the desktop." : "OFF — file tools are confined to the workspace. Tell the user to set AGENT_FULL_ACCESS=true in .env and restart to unlock full JARVIS mode."}
USER: ${env.user || "unknown"} · home: ${env.home}
SHELL SYNTAX: ${env.platform === "win32" ? "PowerShell (use Windows paths, ; separators, Remove-Item etc.)" : "POSIX sh/bash"}

You are this user's PERSONAL agent. Nothing is hidden from you.

=== JARVIS / MACHINE CONTROL ===
Their computer is yours to drive:
  open_app / close_app / list_apps / open_path   -> run and manage software
  find_files / known_folders                      -> locate anything on disk (Desktop, Downloads...)
  screen_capture                                  -> SEE their real screen; use it to observe or verify
  clipboard_read / clipboard_write                -> read and set the clipboard
  type_text / press_keys                          -> real keyboard control of the focused window
  speak / notify                                  -> talk to them out loud, or pop a notification
  system_stats / volume_control / power_control   -> machine state
  schedule_task / list_scheduled / unschedule_task-> make things happen later
PHYSICAL CONTROL (like a human at the keyboard):
  cursor_screenshot -> SEE the screen with real pixel coordinates (do this BEFORE any click)
  cursor_click / cursor_move / cursor_drag / cursor_scroll -> drive the mouse
  cursor_type / cursor_key -> drive the keyboard ('ctrl+c', 'alt+tab', 'win+r')
  list_windows / focus_window -> manage windows
  Golden rule: screenshot -> locate the target -> convert image coords to real coords
  (divide by the scale factor) -> click -> screenshot again to VERIFY it worked.
  Prefer keyboard shortcuts and CLI over clicking when they achieve the same thing: far more reliable.

Use native paths and idioms for THIS OS. Prefer known_folders over guessing paths.
When you finish a long task and the user isn't watching, notify (and speak, if it suits) so they know.

SAFETY — the only things you pause for:
  Confirm FIRST, in one short sentence, before: deleting anything outside the workspace,
  power_control shutdown/restart, mass file moves/renames, or modifying system/OS files.
  Shutdown and restart are delayed and cancellable with power_control cancel.
  Everything else — opening apps, reading files, writing to their folders, installing packages,
  scheduling, clipboard, screenshots — just do it. Don't ask permission for routine work.

=== SELF-MODIFICATION ===
You can read AND rewrite your own source code:
  read_own_code -> see any of your files      write_own_code / patch_own_code -> change them
  self_test -> syntax-check everything        self_diff / self_history -> review changes
  rollback_self -> undo                       restart_app -> apply server-side changes
Every self-edit is git-snapshotted and syntax-checked; a broken change auto-reverts.
Procedure when asked to change yourself or the app:
  1. read_own_code the target file(s) first — never guess your own code.
  2. patch_own_code for small changes, write_own_code for rewrites. Say why.
  3. self_test.  4. restart_app if you touched a server-side file (public/* only needs a refresh).
  5. Verify the change actually worked (screenshot the UI / hit the endpoint).
The same tools serve the user's OWN projects in the workspace — treat both as first-class.

=== SKILLS (methodology playbooks) ===
Before code review, debugging, frontend work, TDD or research, call use_skill to load the
rigorous playbook for it. create_skill to teach yourself the user's way of working permanently.

=== TERMINAL MASTERY ===
You are an expert in every shell and scripting language on this machine.
  shells_available -> what actually exists here (check before assuming)
  run_command      -> quick one-liners in the native shell
  run_in           -> pick the shell explicitly: bash / powershell / cmd / python / node / ruby / perl / php / go / sqlite
  run_script       -> multi-line scripts written to a temp file and executed (NO quoting/escaping problems)
Rules that prevent most terminal failures:
  - Anything longer than one line -> use run_script, never a giant quoted one-liner.
  - On Windows prefer PowerShell idioms (Get-ChildItem, Remove-Item, $env:VAR, ;) not bash.
  - Never assume a tool exists - run shells_available or a version probe first, then install it.
  - Read the exit code AND stderr. Non-zero means it failed even if stdout looks fine.
  - Quote paths that may contain spaces. Use forward slashes in PowerShell; they work.

=== ANDROID APKs ===
  android_status -> is the toolchain ready?      android_setup -> install JDK 17 + SDK (~500MB, once)
  android_create -> scaffold a buildable project  android_build -> produce a real .apk
  android_install -> push it to a connected phone
For "make me an app": prefer kind 'webview' with bundled html — you can build the UI as a web page
(and screenshot it to verify) then wrap it. Always android_build and report the real .apk path.
If the build fails, READ the gradle error and fix it; dependency conflicts are common and fixable.

=== DELIVERABLES & DATA ===
  create_document -> real .docx / .xlsx / .pptx / .pdf files (deps auto-install)
  analyze_data    -> pandas profiling of CSV/Excel/JSON + a chart PNG you can SEE
  scaffold_project-> next / vite-react / vite-vue / express / fastapi / python
  install_packages-> npm & pip, with clear failure reporting
When the user wants a report, deck or spreadsheet, produce the actual FILE, not markdown in chat.

=== GIT ===
  git_status / git_diff / git_commit / git_worktree
Read git_diff before reviewing or committing. Write conventional-commit messages that explain WHY.
Use git_worktree so parallel subagents work on isolated branches instead of fighting over files.

=== MEMORY (you persist across sessions) ===
  remember / recall / forget      -> durable facts about the user and their projects
  write_project_notes             -> NEXUS.md, the brief you read every session
Call remember() whenever you learn something durable: their stack, preferences, project layout,
naming conventions, what they hate. Recall before asking them to repeat themselves.

=== PARALLEL SWARM (use this by default on anything non-trivial) ===
spawn_subagents runs up to 8 agents AT ONCE, each with full tools and its own model.

DEFAULT TO PARALLEL. Before starting any task with more than one part, ask:
"can these pieces be done at the same time?" Usually yes. Examples:
  web app   -> [backend api] [frontend ui] [styles] [tests]      all at once
  research  -> one agent per topic, then one to synthesise
  refactor  -> one agent per module or per file
  bug hunt  -> [reproduce] [read the code] [check git history]   simultaneously

How to use it well:
  needs: ["schema"]  -> waits for that agent and RECEIVES its findings
  isolate: true      -> for any agent that WRITES FILES; it gets a private sandbox,
                        so parallel writers cannot overwrite each other. Merged automatically.
  role: code|plan|fast|review -> picks an appropriate model per agent

Rules:
  - Give each agent a COMPLETE, self-contained goal. They cannot ask you questions.
  - 2-4 well-scoped agents beat 8 vague ones.
  - Keep one thing for yourself: integrating and verifying the merged result.
  - Do NOT parallelise steps that must happen in order — use needs instead.

=== SAFETY NET ===
Every write is auto-checkpointed. undo_last_change / list_checkpoints / restore_checkpoint
let you (and the user) roll back any edit instantly. Say so when you make risky changes.

=== EXTENSIBILITY ===
  mcp_status / mcp_add -> connect Model Context Protocol servers (GitHub, Postgres, Slack, ...)
Their tools appear as mcp__<server>__<tool> and you can call them like any other tool.

=== SPEED ===
Issue MULTIPLE read-only tool calls in ONE turn (read_file, list_files, search_code, web_search,
fetch_url) — they execute concurrently. Don't read five files across five turns; ask for all five at once.
Use delegate_parallel (up to 8) for independent build tasks and think_parallel for hard decisions.

=== WORKFLOW (mandatory) ===
1. PLAN — call update_plan with 4-8 concrete steps BEFORE anything else. Re-call it as steps complete.
2. ORIENT — system_info / list_files when the environment matters. Never assume a tool is installed; check.
3. RESEARCH — web_search + fetch_url for anything you're not certain about. Never invent APIs or versions.
4. THINK HARD — for architecture calls, tricky bugs, or genuine uncertainty, use think_parallel to get
   2-4 independent models' reasoning and synthesize. Don't guess when you can consult.
5. BUILD — write complete, production-quality code. No placeholders, no TODO, no "...". Real error handling.
   For several INDEPENDENT pieces, use delegate_parallel to build them simultaneously — it's much faster.
6. VERIFY — this is non-negotiable:
   • run_command to actually execute it; write and run tests
   • UI work: screenshot to SEE it, then browser_interact to click/type and prove it functions
   • servers: start_server then probe/screenshot; stop_server when done
   • review_code on anything important before you call it finished
7. RECOVER — if something fails, DO NOT stop. Read the error, form a new hypothesis, try a different
   approach. Missing dependency → install it. Command not found → find the alternative. Blocked path →
   route around it. Exhaust real options before ever reporting failure.
8. DELIVER — final markdown: what you built, decisions/assumptions, file tree, how to run, what you tested.
   BUILT A WEBSITE? Publishing is part of finishing: publish_website puts it online (Vercel, Render or
   GitHub Pages — whichever is configured) and returns a live URL. The run auto-publishes a site you just
   created, so if that already happened, simply report the link. Never say "deployed" without a URL.

=== RULES ===
- One prompt in, finished verified result out. Decide and act; note assumptions rather than asking.
  Only use ask_user when a choice is genuinely blocking AND unguessable (e.g. which of their 3 real
  databases to drop). It halts you until they reply, so it is expensive — prefer a sensible default.
- Every tool call must include ALL required fields (edit_file needs path + old_text + new_text together).
- Prefer the platform's native commands. On Windows use PowerShell idioms, not bash.
- Install what you need (npm/pip) rather than complaining it's absent.
- Keep prose short. Working code, real terminal output and screenshots are the proof.`;
}

/* ---------------- Agent loop ---------------- */
const CTX_BUDGET = Number(process.env.AGENT_CTX_BUDGET || 120000);

let ACTIVE_CTX = null;
const tagCtx = (o) => { ACTIVE_CTX = o; return o; };

export async function runAgent(opts) {
  // Always reap background servers this run started — including on timeout, abort
  // or fatal error, not just on the clean completion path.
  const runId = opts?._runId || `run-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const ctx = tagCtx({ runId });
  try { return await _runAgent(ctx, { ...opts, _runId: runId }); }
  finally { if (ACTIVE_CTX === ctx) ACTIVE_CTX = null; if ((opts?._depth || 0) === 0) { try { killAll(runId); } catch {} } }
}

async function _runAgent(ctx, { model, messages, send, maxSteps = 40, signal, freeOnly = true, _role = "main", _depth = 0, _runId = null }) {
  ctx = ctx || {};
  try { const { setMaxListeners } = await import("node:events"); setMaxListeners(0, signal); } catch {}
  setSetupLogger((text) => send({ type: "term_data", id: "setup", stream: "stdout", text }));

  const env = sysInfo(ROOT);
  try { env.toolchain = await detectToolchain(); } catch {}
  const toolchainNote = env.toolchain
    ? "\nTOOLCHAIN ON THIS MACHINE: " + JSON.stringify(env.toolchain) + "\n" : "";
  send({ type: "env", env });

  const impCtx = { send, signal, freeOnly, depth: _depth, runId: _runId, written: [], ctx };
  const IMPL = makeImpl(impCtx);

  // long-term memory + MCP tools (top-level runs only)
  let memBlock = "";
  let mcpTools = [];
  if (_depth === 0) {
    memBlock += toolchainNote;
    try { memBlock += await MEM.contextBlock(); } catch {}
    try { await SKILL.ensureBuiltins(); memBlock += await SKILL.catalogue(); } catch {}
    try {
      const hits = await SKILL.match(taskOf(messages));
      if (hits.length) memBlock += `\nRELEVANT SKILLS for this task: ${hits.map((h) => h.name).join(", ")} — load them with use_skill first.\n`;
    } catch {}
    try { await MCP.ensureConfig(); await HOOK.ensureHooks(); } catch {}
    try { await HOOK.fire("session_start", {}, (l) => send({ type: "hook", text: l })); } catch {}
  }
  try { mcpTools = MCP.toolSchemas(); } catch {}

  // Specialist groups: omitted unless the task mentions them. The CORE set is always
  // present in the same order, so the cached prefix stays intact.
  const SPECIALIST = {
    android:  { re: /\b(apk|android|app store|play store|mobile app)\b/i,
                names: /^android_/ },
    desktop:  { re: /\b(cursor|mouse|click|keyboard|screen|desktop|window|clipboard|volume|speak|notify|shutdown|app)\b/i,
                names: /^(cursor_|list_windows|focus_window|os_control_status|open_app|close_app|list_apps|open_path|clipboard_|notify|speak|screen_capture|volume_control|power_control|type_text|press_keys)/ },
    selfmod:  { re: /\b(your own code|modify yourself|self.?test|rollback|restart app|your source)\b/i,
                names: /^(write_own_code|patch_own_code|self_test|self_diff|self_history|rollback_self|restart_app|read_own_code)/ },
    schedule: { re: /\b(schedule|cron|later|every day|reminder|task scheduler)\b/i,
                names: /^(schedule_task|list_scheduled|unschedule_task)/ },
  };
  const firstMsg = String(messages.find((m) => m.role === "user")?.content || "");
  const hay = typeof firstMsg === "string" ? firstMsg : JSON.stringify(firstMsg);
  const dropped = [];
  const activeTools = TOOLS.filter((t) => {
    const n = t.function.name;
    for (const g of Object.values(SPECIALIST)) {
      if (g.names.test(n) && !g.re.test(hay)) { dropped.push(n); return false; }
    }
    return true;
  });
  const ALL_TOOLS = mcpTools.length ? [...activeTools, ...mcpTools] : activeTools;
  if (_depth === 0 && dropped.length)
    send({ type: "tools_scoped", active: ALL_TOOLS.length, hidden: dropped.length });
  if (mcpTools.length) send({ type: "mcp_tools", n: mcpTools.length });

  // KV-CACHE: the system prompt is a byte-stable prefix. Everything volatile
  // (toolchain probe, memory, skills) goes AFTER it so the cache survives.
  const convo = [{ role: "system", content: systemPrompt(env) }];
  if (memBlock.trim()) convo.push({ role: "user", content: "[CONTEXT]\n" + memBlock });
  convo.push(...messages);
  const chain = await chainFor(_role, model, freeOnly);
  send({ type: "chain", chain });

  let activeModel = chain[0];
  let modelFailures = 0;
  let stepFailures = 0;
  let proseRetries = 0;
  const runStart = Date.now();
  let warnedSlow = false;
  const MAX_RUN_MS = Number(process.env.AGENT_MAX_RUN_MS || 600000);   // 10 min default
  const track = _depth === 0 ? SUP.makeTracker() : null;
  const userTask = lastTaskOf(messages);
  const taskText = typeof userTask === "string" ? userTask : JSON.stringify(userTask || "").slice(0, 500);
  if (track) send({ type: "critic_on" });

  for (let step = 1; step <= maxSteps; step++) {
    if (signal?.aborted) { send({ type: "agent_stopped" }); return convo; }

    const elapsed = Date.now() - runStart;
    if (elapsed > MAX_RUN_MS) {
      send({ type: "critic", level: "high", kind: "timeout", auto: true,
             issue: `Run exceeded ${Math.round(MAX_RUN_MS / 60000)} minutes — wrapping up.` });
      convo.push({ role: "user", content:
        "[SUPERVISOR] Time budget reached. STOP exploring. Summarise what you built, what works, " +
        "and exactly what is left — in your next message. Do not call any more tools." });
      const fin = await complete({ messages: convo, temperature: 0.3 },
        { chain, signal, timeoutMs: 60000 }).catch(() => null);
      if (fin) send({ type: "delta", text: fin.res.choices?.[0]?.message?.content || "" });
      send({ type: "done", steps: step, timedOut: true });
      return convo;
    }
    if (elapsed > MAX_RUN_MS * 0.75 && !warnedSlow) {
      warnedSlow = true;
      convo.push({ role: "user", content:
        "[SUPERVISOR] You are at 75% of the time budget. Prioritise finishing and verifying what " +
        "exists over adding anything new." });
    }
    try {

    if (track) {
      // deterministic checks — instant, free, EVERY step
      send({ type: "critic_check", step, watching: track.toolLog.at(-1)?.name || "start",
             checks: 7, tools: track.toolLog.length });
      const flags = SUP.detect(track);
      for (const f of flags) {
        send({ type: "critic", level: f.severity, kind: f.kind, issue: f.msg, auto: true });
        track.interventions.push({ issue: f.msg, guidance: "" });
      }
      if (flags.length) {
        convo.push({ role: "user", content:
          "[SUPERVISOR — automatic check]\n" + flags.map((f) => "• " + f.msg).join("\n") +
          "\n\nChange approach NOW. Do not repeat the same call. State your new hypothesis in one line, then act on it." });
      } else {
        send({ type: "critic_clear", step });
      }

      // apply the async critic verdict if one is ready
      if (track.pending) {
        const verdict = await Promise.race([track.pending, Promise.resolve(null)]).catch(() => null);
        if (verdict && verdict.verdict && verdict.verdict !== "ok") {
          track.pending = null;
          send({ type: "critic", level: verdict.verdict === "intervene" ? "high" : "low",
                 kind: "review", issue: verdict.issue, guidance: verdict.guidance,
                 model: verdict.model, autofix: verdict.autofix?.tool || null });
          track.interventions.push({ issue: verdict.issue, guidance: verdict.guidance });

          // AUTO-FIX: run the corrective tool ourselves and hand the agent the result
          let fixed = "";
          if (verdict.autofix && IMPL[verdict.autofix.tool]) {
            try {
              send({ type: "autofix_start", tool: verdict.autofix.tool, args: verdict.autofix.args });
              const out = await IMPL[verdict.autofix.tool](verdict.autofix.args || {});
              const txt = typeof out === "object" && out?.__text ? out.__text : String(out);
              fixed = `\n\n[SUPERVISOR ran \`${verdict.autofix.tool}\` for you. Result:]\n${txt.slice(0, 6000)}`;
              send({ type: "autofix_done", tool: verdict.autofix.tool, ok: !SUP.isFailure(txt) });
            } catch (e) {
              send({ type: "autofix_done", tool: verdict.autofix.tool, ok: false });
            }
          }

          convo.push({ role: "user", content:
            `[SUPERVISOR — senior review]\nProblem: ${verdict.issue}\nDo this instead: ${verdict.guidance}${fixed}\n\nAcknowledge in one line, then follow it.` });
        } else if (verdict) { track.pending = null; send({ type: "critic", level: "ok" }); }
      }

      // kick off a fresh review every 3 steps (non-blocking)
      if (!track.pending && step - track.lastCriticStep >= 2 && track.toolLog.length) {
        track.lastCriticStep = step;
        track.pending = SUP.review({ convo, toolLog: track.toolLog, task: taskText, freeOnly, signal,
          workerModel: activeModel, onEvent: (e) => send(e) });
      }
    }

    // RECITATION: keep the goal in the high-attention zone at the end of the prompt.
    if (impCtx.plan?.length) {
      const done = impCtx.plan.filter((p) => p.status === "done").length;
      const recite = `[todo.md — ${done}/${impCtx.plan.length} done]\n` +
        impCtx.plan.map((p) => `${p.status === "done" ? "[x]" : p.status === "active" ? "[>]" : "[ ]"} ${p.title}`).join("\n");
      const last = convo[convo.length - 1];
      if (last?.role === "user" && typeof last.content === "string" && last.content.startsWith("[todo.md")) convo.pop();
      convo.push({ role: "user", content: recite });
    }

    const c = compact(convo, { budget: CTX_BUDGET });
    if (c.compacted) { convo.length = 0; convo.push(...c.convo); send({ type: "compacted", tokens: c.tokens }); }
    send({ type: "step", step, tokens: convoTokens(convo) });

    let res, used;
    try {
      // Speed: after the plan exists and things are going well, use the fast tier.
      // Fall back to the strong tier for step 1, after any failure, or after a critic catch.
      let stepChain = chain;
      try {
        const routine = step > 1 && modelFailures === 0 && stepFailures === 0 &&
          !(track && track.interventions.length && step - track.lastCriticStep <= 1);
        if (routine) {
          const fast = await chainFor("fast", null, freeOnly);
          if (fast.length) stepChain = [...fast.slice(0, 3), ...chain];
        }
      } catch {}

      const waitStart = Date.now();
      const hb = setInterval(() => send({
        type: "thinking", step, ms: Date.now() - waitStart, model: activeModel,
      }), 3000);
      let r;
      try {
        r = await complete(
          { messages: convo, tools: ALL_TOOLS, tool_choice: "auto", temperature: 0.25 },
          { chain: stepChain, signal, onSwitch: () => {},
            onAttempt: (a) => send({ type: "trying_model", model: a.model, n: a.index + 1, of: a.total }) });
      } finally { clearInterval(hb); }
      res = r.res; used = r.model;
      modelFailures = 0;
      if (used !== activeModel) { activeModel = used; send({ type: "model_switch", model: used }); }
    } catch (e) {
      if (signal?.aborted) { send({ type: "agent_stopped" }); return convo; }

      // Do NOT kill the run on a model-level failure — bench the model and retry.
      modelFailures++;
      const msg = e?.message || String(e);
      send({ type: "model_error", error: msg, attempt: modelFailures, recovering: modelFailures < 4 });

      if (modelFailures < 4) {
        try { const { markDead } = await import("./models.js"); markDead(activeModel); } catch {}
        const fresh = await chainFor(_role, null, freeOnly);
        chain.length = 0; chain.push(...fresh.filter((m) => m !== activeModel), ...fresh);
        activeModel = chain[0];
        send({ type: "model_switch", model: activeModel });
        convo.push({ role: "user", content:
          `[SYSTEM] The previous model call failed (${msg.slice(0, 200)}). Switched to ${activeModel}. Continue from where you left off.` });
        step--;                       // this step did not count
        continue;
      }
      send({ type: "error", error: `Model calls failed ${modelFailures}x — last error: ${msg}` });
      return convo;
    }

    const msg = res.choices?.[0]?.message || {};
    const calls = msg.tool_calls || [];
    if (msg.reasoning_content) send({ type: "reasoning", text: msg.reasoning_content });
    if (msg.content) {
      // strip provider filler that some models repeat before the real answer
      let clean = String(msg.content)
        .replace(/(Allocation payload sent successfully\.)+/gi, "")
        .replace(/^(\s*undefined\s*)+/i, "")
        .replace(/(.{15,}?)\1{3,}/g, "$1");     // collapse any phrase repeated 4+ times
      if (clean.trim()) send({ type: "delta", text: clean });
    }
    convo.push({ role: "assistant", content: msg.content || "", ...(calls.length ? { tool_calls: calls } : {}) });

    if (!calls.length) {
      // Some providers emulate tool calling and sometimes reply with prose that
      // merely DESCRIBES the action. Detect that and retry on another model.
      const txt = msg.content || "";
      // Two failure modes: (a) it narrates the work, (b) it flatly claims it cannot act.
      const narrates = /\b(I('| wi)ll|Let me|I'm going to|Next,? I|首先|Here'?s the (code|script|plan))\b/i.test(txt)
        && /\b(create|write|run|execute|install|build|save|file|script)\b/i.test(txt);
      const refuses = /\b(don'?t|do not|cannot|can'?t|unable to|no)\b[^.]{0,40}\b(have|access|execute|run|perform|create|write)\b/i.test(txt)
        || /\b(I am|I'm) (a |an )?(text|language)[- ]based\b/i.test(txt)
        || /\byou (can|should|could|would need to) (run|execute|type|open|install|save)\b/i.test(txt);
      // Pasting code into chat instead of writing a file
      const pastesCode = /```/.test(txt) && txt.length > 200;
      // Answering a "compute/inspect it" request from memory instead of executing
      const answeredFromMemory = !track?.toolLog.length && txt.length < 600 &&
        /\b(md5|sha\d*|hash|factorial|reverse|timestamp|version|uptime|sum)\b/i.test(taskText);
      const describesWork = narrates || refuses || pastesCode || answeredFromMemory;
      const noWorkYet = track && !track.toolLog.some((t) => /write_file|run_command|edit_file|create_document/.test(t.name));
      if (describesWork && noWorkYet && step < maxSteps - 1 && proseRetries < 2) {
        proseRetries++;
        try { const { markDead } = await import("./models.js"); markDead(used); } catch {}
        const alt = await chainFor(_role, null, freeOnly);
        chain.length = 0; chain.push(...alt.filter((m) => m !== used), ...alt);
        activeModel = chain[0];
        send({ type: "model_switch", model: activeModel });
        send({ type: "critic", level: "medium", kind: "no_tool_call", auto: true,
               issue: "Model described the work instead of calling a tool — switching model and retrying." });
        convo.push({ role: "user", content:
          "[SYSTEM] Your reply did not do the work. Rules:\n" +
          "- Code belongs in a FILE, not in chat. Call write_file, then run it.\n" +
          "- Facts about this machine or any computation must be OBTAINED by running a command, " +
          "never recalled from memory — the user wants the real value from their own system.\n" +
          "- You have run_command, write_file, run_script and 80+ live tools attached right now.\n" +
          "Call the tool immediately. Do not explain, do not apologise." });
        continue;
      }
      const malformed = /Could not execute tool|required field .* is missing|invalid tool call/i.test(msg.content || "");
      if (malformed && step < maxSteps) {
        convo.push({ role: "user", content: "Your last tool call was malformed. Re-issue it with ALL required fields present. If an edit is hard to match, use write_file to rewrite the whole file." });
        continue;
      }
      if (track && !track.finishing) {
        track.finishing = true;
        // never "finish" a build request having produced nothing
        const produced = track.toolLog.some((t) => !t.failed &&
          /write_file|edit_file|run_command|run_script|run_in|create_document|android_build|scaffold_project|start_server|spawn_subagents|delete_file/.test(t.name));
        const asked = /\b(create|build|write|make|generate|run|execute|fix|install|add)\b/i.test(taskText);
        if (asked && !produced && step < maxSteps - 1) {
          send({ type: "critic", level: "high", kind: "nothing_done", auto: true,
                 issue: "You are finishing without having created or run anything." });
          convo.push({ role: "user", content:
            "[SUPERVISOR] You have not actually done the work — no file was written and nothing was run. " +
            "Call the real tool now (write_file / run_command / run_script). Do not reply with prose." });
          track.finishing = false;
          continue;
        }
        const gate = SUP.detect(track).filter((f) => f.kind === "unverified");
        if (gate.length && step < maxSteps - 2) {
          send({ type: "critic", level: "high", kind: "gate", issue: gate[0].msg, auto: true });
          track.interventions.push({ issue: gate[0].msg, guidance: "verify before finishing" });
          convo.push({ role: "user", content:
            "[SUPERVISOR — completion blocked]\n" + gate[0].msg +
            "\nRun it, test it, or screenshot it now. Then summarise." });
          track.finishing = false;
          continue;
        }
      }
      // Auto-publish: if this run BUILT a website, put it online before we call it done.
      if (_depth === 0 && !ctx.published && PUB.autoEnabled()) {
        try {
          const site = await PUB.siteFromWritten(ctx.written, ROOT);
          if (site) {
            send({ type: "publish_start", dir: rel(site.dir), backend: PUB.primary()?.id || "auto", auto: true });
            const r = await publishWithTimeout({ dir: site.dir, build: true },
              (txt) => send({ type: "publish_log", text: String(txt).slice(0, 400) }), signal);
            ctx.published = true; ctx.publishedUrl = r?.url || null;
            send({ type: "publish", ok: !!r?.ok, url: r?.url || null, backend: r?.backend || null,
                   files: r?.files, bytes: r?.bytes, error: r?.error || null, dir: rel(site.dir), auto: true });
            if (r?.ok && r.url) {
              convo.push({ role: "user", content:
                `[PUBLISHER] The site you just built is live at ${r.url} ` +
                `(${r.files} files). Include that URL as a markdown link in your final answer.` });
            } else if (r && r.ok === false && r.error) {
              convo.push({ role: "user", content:
                `[PUBLISHER] Auto-publish failed: ${r.error}. Tell the user, and note that ` +
                `publish_website can retry it after the problem is fixed.` });
            }
          }
        } catch (e) { console.error("[publish] auto-publish failed: " + (e?.message || e)); }
      }
      send({ type: "done", usage: res.usage || null, steps: step, model: used });
      if (_depth === 0) {
        try { const n = killAll(_runId); if (n) send({ type: "cleanup", servers: n }); } catch {}
        const task = taskOf(messages);
        MEM.logSession({ task: typeof task === "string" ? task : "task",
          outcome: (msg.content || "").slice(0, 400), ms: 0 }).catch(() => {});
        if (track) {
          SUP.learn({ task: taskText, convo, toolLog: track.toolLog,
            interventions: track.interventions, freeOnly, signal, workerModel: activeModel,
            userMsgs: messages.filter((m) => m.role === "user")
              .map((m) => typeof m.content === "string" ? m.content
                : (m.content?.find?.((p) => p.type === "text")?.text || ""))
              .filter(Boolean) })
            .then((lessons) => { if (lessons) send({ type: "learned", lessons }); })
            .catch(() => {});
        }
        HOOK.fire("session_end", {}, () => {}).catch(() => {});
      }
      return convo;
    }

    // Execute a tool call and stream its result.
    let askedUser = false;
    const execCall = async (call) => {
      if (signal?.aborted) return null;
      const name = call.function?.name;
      let args = {};
      try { args = JSON.parse(call.function?.arguments || "{}"); } catch {}
      send({ type: "tool_start", id: call.id, name, args });

      let result, image = null;
      const t0 = Date.now();
      try {
        if (MCP.isMcpTool(name)) result = await MCP.callTool(name, args);
        else if (IMPL[name]) {
          const hb = await HOOK.fire("before_tool", { tool: name, args }, (l) => send({ type: "hook", text: l }));
          result = hb.blocked ? `BLOCKED by a before_tool hook: ${hb.reason}` : await IMPL[name](args);
          if (!hb.blocked) HOOK.fire("after_tool", { tool: name, args }, () => {}).catch(() => {});
        } else {
          const known = Object.keys(IMPL);
          const near = known.filter((k) => {
            const s = String(name).replace(/^mcp__[^_]+__/, "");
            return k === s || k.includes(s) || s.includes(k);
          }).slice(0, 4);
          result = `ERROR: there is no tool called "${name}".` +
            (near.length ? ` Did you mean: ${near.join(", ")}?` : "") +
            ` Never invent mcp__ names — call mcp_status to see which MCP servers are actually connected.`;
        }
      } catch (e) { result = "ERROR: " + e.message; }

      if (result && typeof result === "object" && result.__text !== undefined) {
        image = result.__image; result = result.__text;
      }
      // Manus principle: offload, don't truncate. Big outputs go to disk with a path
      // the agent can re-read, instead of being silently cut off.
      let resultStr = String(result);
      if (resultStr.length > 12000) {
        try {
          const dir = path.join(ROOT, ".observations");
          await fs.mkdir(dir, { recursive: true });
          // keep only the 40 most recent spills so the workspace cannot bloat
          try {
            const files = (await fs.readdir(dir)).filter((f) => f.endsWith(".txt"));
            if (files.length > 40) {
              const stats = await Promise.all(files.map(async (f) => ({
                f, t: (await fs.stat(path.join(dir, f))).mtimeMs })));
              stats.sort((x, y) => x.t - y.t);
              for (const s of stats.slice(0, stats.length - 40))
                await fs.rm(path.join(dir, s.f), { force: true });
            }
          } catch {}
          const f = path.join(dir, `${name}-${Date.now()}.txt`);
          await fs.writeFile(f, resultStr, "utf8");
          resultStr = resultStr.slice(0, 4000) +
            `\n\n…[${resultStr.length - 4000} more chars OFFLOADED, not lost]` +
            `\nFull output saved to: ${path.relative(ROOT, f)}` +
            `\nRead it with read_file or search it with search_code if you need the rest.`;
          emit({ type: "offload", tool: name, path: path.relative(ROOT, f), bytes: String(result).length });
        } catch {}
      }
      result = resultStr;

      const failed = SUP.isFailure(result);
      track?.record(name, args, result, failed);
      send({ type: "tool_end", id: call.id, name, result: String(result).slice(0, 8000), ms: Date.now() - t0, image, failed });
      if (name === "ask_user") askedUser = true;
      return { call, name, result: String(result), image };
    };

    // Read-only calls run concurrently; mutating calls run alone, in order.
    const groups = scheduleCalls(calls);
    for (const group of groups) {
      if (signal?.aborted) { send({ type: "agent_stopped" }); return convo; }
      let done;
      if (group.length > 1) {
        send({ type: "batch", n: group.length, names: group.map((c) => c.function?.name) });
        done = await pool(group, Math.min(group.length, 6), execCall);
      } else {
        done = [await execCall(group[0])];
      }
      for (const d of done) {
        if (!d || d.__error) continue;
        convo.push({ role: "tool", tool_call_id: d.call.id, name: d.name, content: d.result.slice(0, 30000) });
        if (d.image) {
          try {
            const buf = await fs.readFile(path.join(SHOTS_DIR, path.basename(d.image)));
            convo.push({ role: "user", content: [
              { type: "text", text: "This is the screenshot you just took. Inspect it critically as a designer: layout, readability, spacing, whether expected content is present. If anything is broken or ugly, fix it and re-verify. Otherwise continue your plan." },
              { type: "image_url", image_url: { url: "data:image/png;base64," + buf.toString("base64") } }] });
          } catch {}
        }
      }
      if (askedUser) {
        send({ type: "done", steps: step, awaiting: true });
        return convo;
      }
    }
    } catch (stepErr) {
      // Never let an unexpected error end the run — report, recover, continue.
      if (signal?.aborted) { send({ type: "agent_stopped" }); return convo; }
      stepFailures++;
      const em = stepErr?.message || String(stepErr);
      console.error("[agent] step " + step + " failed: " + em);
      send({ type: "step_error", error: em, attempt: stepFailures, recovering: stepFailures < 5 });
      if (stepFailures >= 5) {
        send({ type: "error", error: `Agent hit ${stepFailures} internal errors. Last: ${em}` });
        return convo;
      }
      convo.push({ role: "user", content:
        `[SYSTEM] An internal error occurred (${em.slice(0, 250)}). It has been logged. ` +
        `Do not repeat whatever caused it — try a different approach and continue the task.` });
    }
  }
  send({ type: "delta", text: "\n\n⚠️ Hit the step limit. Send another message to continue." });
  send({ type: "done", steps: maxSteps });
  return convo;
}

export { killAll, PROCS, loadModels };
