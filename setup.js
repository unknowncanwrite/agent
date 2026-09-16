/* Auto-provisioning: install Chromium on demand, detect toolchain */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runStream, IS_WIN } from "./shell.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

import { createRequire } from "node:module";
const require2 = createRequire(import.meta.url);

export function chromiumPath() {
  try {
    const { chromium } = require2("playwright-core");
    const p = chromium.executablePath();
    return fs.existsSync(p) ? p : null;
  } catch { return null; }
}

/** Look for a system Chrome/Edge we can borrow instead of downloading. */
export function systemBrowser() {
  const cands = IS_WIN
    ? [
        "C:/Program Files/Google/Chrome/Application/chrome.exe",
        "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
        "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
        "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
        path.join(process.env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe"),
      ]
    : process.platform === "darwin"
    ? [
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Applications/Chromium.app/Contents/MacOS/Chromium",
        "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      ]
    : [
        "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable",
        "/usr/bin/chromium", "/usr/bin/chromium-browser", "/snap/bin/chromium",
      ];
  return cands.find((p) => p && fs.existsSync(p)) || null;
}

let installing = null;

/**
 * Ensure a usable browser exists. Downloads Playwright's Chromium if needed.
 * onLog receives live progress lines so the UI can show the install streaming.
 */
export async function ensureBrowser(onLog = () => {}) {
  const have = chromiumPath();
  if (have) return { ok: true, path: have, source: "playwright" };

  const sys = systemBrowser();
  if (sys) {
    onLog(`Found an installed browser: ${sys}\nUsing it instead of downloading.\n`);
    return { ok: true, path: sys, source: "system" };
  }

  if (installing) return installing;
  installing = (async () => {
    onLog("No browser found. Downloading Chromium via Playwright (~150 MB, one time)...\n");
    const r = await runStream("npx --yes playwright install chromium", {
      cwd: __dirname,
      timeout: 900,
      onData: ({ text }) => onLog(text),
    });
    const p = chromiumPath();
    if (p) { onLog("\nChromium ready.\n"); return { ok: true, path: p, source: "downloaded" }; }

    if (process.platform === "linux") {
      onLog("\nTrying to install system dependencies (may need sudo)...\n");
      await runStream("npx --yes playwright install-deps chromium", {
        cwd: __dirname, timeout: 900, onData: ({ text }) => onLog(text),
      });
      const p2 = chromiumPath();
      if (p2) return { ok: true, path: p2, source: "downloaded" };
    }
    onLog("\nChromium install failed. Visual tools will be unavailable.\n" + (r.stderr || "").slice(-800));
    return { ok: false, error: "chromium install failed" };
  })().finally(() => { installing = null; });

  return installing;
}

/** Detect what's available on this machine so the agent plans realistically. */
export async function detectToolchain() {
  const probes = {
    node: "node --version",
    npm: "npm --version",
    python: IS_WIN ? "python --version" : "python3 --version",
    pip: IS_WIN ? "pip --version" : "pip3 --version",
    git: "git --version",
    docker: "docker --version",
  };
  const out = {};
  await Promise.all(Object.entries(probes).map(async ([k, cmd]) => {
    const r = await runStream(cmd, { timeout: 15 });
    out[k] = r.code === 0 ? (r.stdout || r.stderr).trim().split("\n")[0] : null;
  }));
  out.browser = chromiumPath() || systemBrowser() || null;
  return out;
}


/* ---------------- Gemini Web bridge (free supervisor LLM) ---------------- */
import { spawn } from "node:child_process";

const GEM_DIR = path.join(__dirname, "vendor");
const GEM_PY = path.join(GEM_DIR, "gemini_web2api.py");
let gemProc = null;

export function geminiRunning() { return !!gemProc && !gemProc.killed; }

/** Is something already serving on :8081? */
export async function geminiUp(ms = 1500) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch("http://127.0.0.1:8081/v1/models", { signal: ac.signal });
    clearTimeout(t);
    return r.ok;
  } catch { clearTimeout(t); return false; }
}

/** Find a working Python on this machine (Windows has several aliases). */
export async function findPython(onLog = () => {}) {
  const cands = [
    process.env.NEXUS_PYTHON,
    IS_WIN ? "py -3" : null, IS_WIN ? "python" : null,
    "python3", "python",
  ].filter(Boolean);
  for (const c of cands) {
    const r = await runStream(`${c} -c "import sys;print(sys.version_info[0])"`, { timeout: 20 });
    if (r.code === 0 && (r.stdout || "").trim().startsWith("3")) return c;
  }
  return null;
}

/** Launch the bundled gemini-web2api bridge. Free Gemini, no API key. */
export async function startGemini(onLog = () => {}) {
  if (await geminiUp()) return { ok: true, already: true };
  if (!fs.existsSync(GEM_PY)) return { ok: false, error: "vendor/gemini_web2api.py missing" };

  const py = await findPython(onLog);
  if (!py) {
    return { ok: false, error: "Python 3 not found. Install it from python.org (tick 'Add to PATH'), then restart." };
  }

  // httpx gives real streaming. MUST finish before we launch, or the bridge races the install.
  const probe = await runStream(`${py} -c "import httpx"`, { timeout: 25 });
  if (probe.code !== 0) {
    onLog("installing httpx (one time)...\n");
    const inst = await runStream(`${py} -m pip install --quiet --disable-pip-version-check httpx`,
      { timeout: 420, onData: ({ text }) => onLog(text.slice(0, 200)) });
    if (inst.code !== 0) {
      onLog("pip install failed; continuing without streaming\n");
    }
  }

  let lastErr = "";
  try {
    const parts = py.split(" ");
    gemProc = spawn(parts[0], [...parts.slice(1), GEM_PY], {
      cwd: GEM_DIR, detached: !IS_WIN, windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    gemProc.stdout?.on("data", (d) => onLog(String(d).slice(0, 300)));
    gemProc.stderr?.on("data", (d) => { lastErr = String(d).slice(-400); onLog(String(d).slice(0, 300)); });
    gemProc.on("error", (e) => { lastErr = e.message; gemProc = null; });
    gemProc.on("exit", (c) => { if (c) lastErr = lastErr || `bridge exited with code ${c}`; gemProc = null; });
  } catch (e) { return { ok: false, error: e.message }; }

  // generous, and bail early if the process already died
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 600));
    if (await geminiUp()) { onLog("Gemini Web bridge ready on :8081\n"); return { ok: true }; }
    if (!gemProc) break;
  }
  return { ok: false, error: lastErr || "bridge did not respond on :8081 within 30s" };
}

export function stopGemini() { try { gemProc?.kill(); } catch {} gemProc = null; }
