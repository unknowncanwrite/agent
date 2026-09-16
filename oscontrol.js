/* Bridge to the Python OS-control sidecar (cursor, keyboard, screen vision) */
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runStream, IS_WIN } from "./shell.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(__dirname, "os_control.py");

let proc = null, ready = false, seq = 0;
const pending = new Map();
let bootErr = null;

const PY = () => process.env.NEXUS_PYTHON || (IS_WIN ? "python" : "python3");

function handleLine(line) {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.ready !== undefined) {
    ready = !!msg.available;
    bootErr = msg.error || null;
    return;
  }
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  msg.error ? p.reject(new Error(msg.error)) : p.resolve(msg.result);
}

export function isRunning() { return !!proc && !proc.killed; }

export async function start() {
  if (isRunning()) return { ok: ready, error: bootErr };
  return await new Promise((resolve) => {
    try {
      proc = spawn(PY(), ["-u", SCRIPT], { cwd: __dirname, stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      bootErr = e.message; return resolve({ ok: false, error: e.message });
    }
    let buf = "";
    proc.stdout.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        if (line.trim()) handleLine(line);
      }
    });
    proc.stderr.on("data", (d) => { bootErr = d.toString().slice(0, 500); });
    proc.on("exit", () => { proc = null; ready = false; for (const p of pending.values()) p.reject(new Error("sidecar exited")); pending.clear(); });
    proc.on("error", (e) => { bootErr = e.message; proc = null; });
    setTimeout(() => resolve({ ok: ready, error: bootErr }), 2500);
  });
}

export async function call(action, args = {}, timeout = 30000) {
  if (!isRunning()) {
    const s = await start();
    if (!s.ok) throw new Error(s.error || "OS control unavailable. Run: pip install pyautogui pillow");
  }
  const id = ++seq;
  return await new Promise((resolve, reject) => {
    const t = setTimeout(() => { pending.delete(id); reject(new Error(`${action} timed out`)); }, timeout);
    pending.set(id, {
      resolve: (v) => { clearTimeout(t); resolve(v); },
      reject: (e) => { clearTimeout(t); reject(e); },
    });
    try { proc.stdin.write(JSON.stringify({ id, action, args }) + "\n"); }
    catch (e) { clearTimeout(t); pending.delete(id); reject(e); }
  });
}

export function stop() { try { proc?.kill(); } catch {} proc = null; ready = false; }

/** Install the Python deps needed for cursor control. */
export async function install(onLog = () => {}) {
  onLog("Installing OS-control dependencies (pyautogui, pillow, opencv)...\n");
  const cmd = `${PY()} -m pip install --user pyautogui pillow opencv-python`;
  const r = await runStream(cmd, { cwd: __dirname, timeout: 600, onData: ({ text }) => onLog(text) });
  stop();
  const s = await start();
  onLog(s.ok ? "\nOS control ready.\n" : `\nStill unavailable: ${s.error}\n`);
  return { ok: s.ok, error: s.error, code: r.code };
}

export async function status() {
  if (!isRunning()) {
    const probe = await runStream(`${PY()} -c "import pyautogui, PIL; print('ok')"`, { timeout: 25 });
    if (probe.code !== 0) {
      return { available: false, error: "pyautogui not installed", hint: `${PY()} -m pip install pyautogui pillow`, raw: (probe.stderr || "").slice(0, 300) };
    }
  }
  try {
    const p = await call("ping", {}, 12000);
    return { available: !!p.ok, screen: p.size, cv: p.cv, python: p.python, error: p.error };
  } catch (e) {
    return { available: false, error: e.message, hint: `${PY()} -m pip install pyautogui pillow` };
  }
}
