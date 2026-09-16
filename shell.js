/* Cross-platform shell with LIVE streaming output (Windows / macOS / Linux) */
import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";

export const IS_WIN = process.platform === "win32";
export const HOME = os.homedir();

/** Full-PC mode: agent may touch anything the OS user can. */
let _full = String(process.env.AGENT_FULL_ACCESS || "").toLowerCase() === "true";
export const FULL_ACCESS = { get value() { return _full; } };
export function setFullAccess(v) { _full = !!v; return _full; }
export function isFull() { return _full; }

export function shellFor() {
  if (IS_WIN) {
    const ps = process.env.ComSpec?.includes("cmd")
      ? "powershell.exe" : "powershell.exe";
    return { file: ps, args: ["-NoLogo", "-NonInteractive", "-Command"] };
  }
  return { file: process.env.SHELL || "/bin/bash", args: ["-lc"] };
}

const BLOCKED = [
  /\brm\s+-rf\s+\/(?:\s|$)/, /\bmkfs\b/, /\bdd\s+if=.*of=\/dev\//,
  /:\(\)\{.*\};:/, /\bshutdown\b/, /\breboot\b/, /\bhalt\b/,
  /Format-Volume/i, /Remove-Item\s+-Recurse\s+-Force\s+[A-Za-z]:\\(\s|$)/i,
  /\bdel\s+\/s\s+\/q\s+[A-Za-z]:\\/i,
];
export function isBlocked(cmd) {
  return BLOCKED.some((r) => r.test(cmd));
}

/**
 * Run a command, streaming stdout/stderr chunks live via onData.
 * Returns { code, stdout, stderr, timedOut, cmd, cwd }.
 */
export function runStream(cmd, { cwd, timeout = 120, onData, env } = {}) {
  return new Promise((resolve) => {
    if (isBlocked(cmd)) {
      const msg = "BLOCKED: command matches a destructive-pattern guard.";
      onData?.({ stream: "stderr", text: msg });
      return resolve({ code: 126, stdout: "", stderr: msg, blocked: true, cmd, cwd });
    }
    const sh = shellFor();
    const child = IS_WIN
      ? spawn(cmd, { cwd: cwd || process.cwd(), shell: true, windowsHide: true,
          env: { ...process.env, ...env, FORCE_COLOR: "0", TERM: "dumb" } })
      : spawn(sh.file, [...sh.args, cmd], { cwd: cwd || process.cwd(), windowsHide: true,
          env: { ...process.env, ...env, FORCE_COLOR: "0", TERM: "dumb" } });

    let stdout = "", stderr = "", timedOut = false;
    const cap = 400_000;
    const t = setTimeout(() => {
      timedOut = true;
      try { IS_WIN ? spawn("taskkill", ["/pid", child.pid, "/f", "/t"]) : process.kill(-child.pid, "SIGKILL"); }
      catch { try { child.kill("SIGKILL"); } catch {} }
    }, Math.min(timeout, 900) * 1000);

    child.stdout.on("data", (d) => {
      const s = d.toString();
      if (stdout.length < cap) stdout += s;
      onData?.({ stream: "stdout", text: s });
    });
    child.stderr.on("data", (d) => {
      const s = d.toString();
      if (stderr.length < cap) stderr += s;
      onData?.({ stream: "stderr", text: s });
    });
    let settled = false;
    const done = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      resolve({ code: code ?? -1, stdout, stderr, timedOut, cmd, cwd });
    };
    child.on("error", (e) => {
      // spawn itself failed (EINVAL/ENOENT on Windows) — 'close' will never fire
      stderr += "\n" + e.message;
      onData?.({ stream: "stderr", text: e.message });
      done(127);
    });
    child.on("close", done);
  });
}

/** Background process registry (dev servers etc.) */
export const PROCS = new Map();
export function startBackground(cmd, { cwd, name, onData, owner = null } = {}) {
  const sh = shellFor();
  const child = IS_WIN
    ? spawn(cmd, { cwd: cwd || process.cwd(), shell: true, windowsHide: true,
        env: { ...process.env, FORCE_COLOR: "0" } })
    : spawn(sh.file, [...sh.args, cmd], { cwd: cwd || process.cwd(), detached: true,
        windowsHide: true, env: { ...process.env, FORCE_COLOR: "0" } });
  const id = `p${child.pid}`;
  const rec = { id, pid: child.pid, cmd, owner, name: name || cmd.slice(0, 40), log: "", child, started: Date.now() };
  // declared before the handler: referencing rec earlier was a temporal-dead-zone throw
  child.on("error", (e) => { rec.exited = true; rec.code = 127; rec.log += "\nspawn failed: " + e.message; });
  const push = (stream) => (d) => {
    const s = d.toString();
    rec.log = (rec.log + s).slice(-40000);
    onData?.({ stream, text: s, id });
  };
  child.stdout?.on("data", push("stdout"));
  child.stderr?.on("data", push("stderr"));
  child.on("close", (c) => { rec.exited = true; rec.code = c; });
  PROCS.set(id, rec);
  return rec;
}
export function killProc(id) {
  const r = PROCS.get(id);
  if (!r) return false;
  try {
    if (IS_WIN) spawn("taskkill", ["/pid", r.pid, "/f", "/t"], { windowsHide: true });
    else process.kill(-r.pid, "SIGKILL");
  } catch { try { r.child.kill("SIGKILL"); } catch {} }
  PROCS.delete(id);
  return true;
}
/** Kill background processes. With an owner, only that run's processes die —
 *  parallel chats must never reap each other. */
export function killAll(owner) {
  let n = 0;
  for (const [id, rec] of [...PROCS.entries()]) {
    if (owner != null && rec.owner !== owner) continue;
    if (killProc(id)) n++;
  }
  return n;
}

/** Machine facts the agent should know about its host. */
export function sysInfo(root) {
  return {
    platform: process.platform,
    osRelease: os.release(),
    arch: os.arch(),
    shell: shellFor().file,
    node: process.version,
    cpus: os.cpus()?.length || 0,
    memGB: Math.round(os.totalmem() / 1e9),
    home: HOME,
    user: os.userInfo().username,
    hostname: os.hostname(),
    cwd: root,
    fullAccess: _full,
    pathSep: path.sep,
  };
}
