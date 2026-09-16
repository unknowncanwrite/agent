/* Test helpers: temp app sandbox, HTTP/SSE client, tiny assertion framework. */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
export { startMock } from "./mock-upstream.mjs";

export const TESTS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const APP_DIR = path.resolve(TESTS_DIR, "..");

/* ---------------- assertions / reporting ---------------- */
const state = { suite: null, pass: 0, fail: 0, failures: [], notes: [], findings: [] };

export function suite(name) { state.suite = name; console.log(`\n\x1b[1m${name}\x1b[0m`); }
export function note(msg) { state.notes.push(`[${state.suite}] ${msg}`); console.log(`  \x1b[36mnote\x1b[0m ${msg}`); }

/** A defect that is reported but does not fail the suite (documented finding). */
export function finding(name, detail, severity = "medium") {
  state.findings.push({ suite: state.suite, name, detail, severity });
  console.log(`  \x1b[33m▲ [${severity}] ${name}\x1b[0m${detail ? "\n      " + String(detail).split("\n").join("\n      ") : ""}`);
}

/** Assert a defect exists (so a fix shows up as a passing "fixed" line instead). */
export async function expectDefect(name, condFn, detail, severity = "medium") {
  let present = false;
  try { present = !!(await condFn()); } catch { present = true; }
  if (present) finding(name, detail, severity);
  else { state.pass++; console.log(`  \x1b[32m✓\x1b[0m ${name} \x1b[90m(fixed)\x1b[0m`); }
  return present;
}

export async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    state.pass++;
    console.log(`  \x1b[32m✓\x1b[0m ${name} \x1b[90m(${Date.now() - t0}ms)\x1b[0m`);
  } catch (e) {
    state.fail++;
    state.failures.push({ suite: state.suite, name, error: e?.message || String(e) });
    console.log(`  \x1b[31m✗ ${name}\x1b[0m\n      \x1b[31m${(e?.message || e).toString().split("\n").join("\n      ")}\x1b[0m`);
  }
}

export function ok(cond, msg = "expected truthy") { if (!cond) throw new Error(msg); }
export function eq(actual, expected, msg = "") {
  const a = JSON.stringify(actual), b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${msg}\n      expected: ${b}\n      actual:   ${a}`);
}
export function has(hay, needle, msg = "") {
  if (!String(hay).includes(needle)) throw new Error(`${msg}\n      expected to contain: ${JSON.stringify(needle)}\n      actual: ${JSON.stringify(String(hay).slice(0, 600))}`);
}
export function hasNot(hay, needle, msg = "") {
  if (String(hay).includes(needle)) throw new Error(`${msg}\n      expected NOT to contain: ${JSON.stringify(needle)}\n      actual: ${JSON.stringify(String(hay).slice(0, 600))}`);
}
export function truthy(v, msg = "expected truthy") { if (!v) throw new Error(msg); }
export function rejects(fn, pattern, msg = "") {
  return Promise.resolve().then(fn).then(
    () => { throw new Error(`${msg || "expected a rejection"}, but it resolved`); },
    (e) => { if (pattern && !pattern.test(e.message)) throw new Error(`${msg || "rejection message mismatch"}: got "${e.message}"`); return e; });
}

let LAST = null;
export function lastSummary() { return LAST; }

export function summary() {
  console.log("\n" + "─".repeat(64));
  console.log(`  \x1b[1mTOTAL\x1b[0m  ${state.pass} passed, ${state.fail} failed`);
  if (state.notes.length) { console.log("\n  notes:"); state.notes.forEach((n) => console.log("   • " + n)); }
  if (state.failures.length) {
    console.log("\n  failures:");
    state.failures.forEach((f) => console.log(`   ✗ [${f.suite}] ${f.name}\n     ${f.error.split("\n")[0]}`));
  }
  if (state.findings.length) {
    console.log(`\n  findings (\x1b[33m${state.findings.length}\x1b[0m):`);
    state.findings.forEach((f) => console.log(`   ▲ [${f.severity}] ${f.name}`));
  }
  console.log("─".repeat(64));
  LAST = { pass: state.pass, fail: state.fail, failures: state.failures, notes: state.notes, findings: state.findings };
  return LAST;
}

/* ---------------- app sandbox ---------------- */

/** Copy the app source (no node_modules) into a temp dir and symlink deps. */
export async function makeSandbox({ name = "nexus-test", providersOff = [] } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), name + "-"));
  const keep = ["public", "skills", "vendor", "tests"];
  for (const ent of await fsp.readdir(APP_DIR, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === "workspace" || ent.name === ".git") continue;
    if (ent.isFile() && /\.(js|json|py|md|sh|bat)$/.test(ent.name) && ent.name !== "package-lock.json") {
      await fsp.copyFile(path.join(APP_DIR, ent.name), path.join(dir, ent.name));
    } else if (ent.isDirectory() && keep.includes(ent.name)) {
      await fsp.cp(path.join(APP_DIR, ent.name), path.join(dir, ent.name), { recursive: true });
    }
  }
  await fsp.symlink(path.join(APP_DIR, "node_modules"), path.join(dir, "node_modules"), "dir");
  await fsp.mkdir(path.join(dir, "workspace"), { recursive: true });
  await fsp.writeFile(path.join(dir, ".providers-off.json"), JSON.stringify(providersOff), "utf8");
  return dir;
}

/** Boot the real server.js inside a sandbox against the mock upstream. */
export async function startServer(dir, { env = {}, upstream, port = 0, fullAccess = false } = {}) {
  const chosen = port || (30000 + Math.floor(Math.random() * 20000));
  const child = spawn(process.execPath, ["server.js"], {
    cwd: dir,
    env: {
      ...process.env,
      PORT: String(chosen),
      HOST: "127.0.0.1",
      AGENT_WORKSPACE: path.join(dir, "workspace"),
      AGENT_FULL_ACCESS: String(fullAccess),
      XKIRO_API_KEY: "sk-mock-test-key",
      XKIRO_BASE_URL: upstream,
      NEXUS_OPEN: "false",
      NEXUS_GEMINI: "false",
      NEXUS_TIMEOUT_MS: "15000",
      AGENT_MAX_RUN_MS: "60000",
      ...env,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs = [];
  child.stdout.on("data", (d) => logs.push(d.toString()));
  child.stderr.on("data", (d) => logs.push(d.toString()));
  const base = `http://127.0.0.1:${chosen}`;

  const t0 = Date.now();
  while (Date.now() - t0 < 25000) {
    try {
      const r = await fetch(base + "/api/health", { signal: AbortSignal.timeout(1500) });
      if (r.status === 200) return { child, base, port: chosen, logs, get output() { return logs.join(""); },
        stop: () => new Promise((res) => { child.once("exit", res); try { child.kill("SIGKILL"); } catch {} setTimeout(res, 1500); }) };
    } catch {}
    await sleep(200);
  }
  try { child.kill("SIGKILL"); } catch {}
  throw new Error("server did not come up.\n" + logs.join("").slice(-2000));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- HTTP ---------------- */
export async function get(base, p, opts = {}) {
  const r = await fetch(base + p, { signal: AbortSignal.timeout(opts.timeout || 20000), ...opts });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, text, json, headers: r.headers };
}
export async function post(base, p, body, opts = {}) {
  const r = await fetch(base + p, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}), signal: AbortSignal.timeout(opts.timeout || 60000), ...opts,
  });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, text, json };
}

/** Read an SSE stream fully (or until predicate) and return the parsed events. */
export async function sse(base, p, body, { until = null, timeout = 60000, onEvent = null } = {}) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  const events = [];
  try {
    const r = await fetch(base + p, {
      method: body === undefined ? "GET" : "POST",
      headers: body === undefined ? {} : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ac.signal,
    });
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf("\n\n")) !== -1) {
        const raw = buf.slice(0, i); buf = buf.slice(i + 2);
        const line = raw.split("\n").find((l) => l.startsWith("data: "));
        if (!line) continue;
        let ev; try { ev = JSON.parse(line.slice(6)); } catch { continue; }
        events.push(ev);
        onEvent?.(ev);
        if (until && until(ev)) { ac.abort(); clearTimeout(timer); return { events, status: r.status }; }
      }
    }
    return { events, status: r.status };
  } finally { clearTimeout(timer); }
}

export const evs = (events, type) => events.filter((e) => e.type === type);
