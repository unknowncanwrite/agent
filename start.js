#!/usr/bin/env node
/* Supervisor: keeps NEXUS running and relaunches it after restart_app / crashes. */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const RESTART_CODE = 42;          // server exits with this to request a relaunch
const MAX_CRASHES = 3;            // consecutive crashes before we give up

let current = null, shuttingDown = false;
let crashes = 0, restarts = 0, last = Date.now();

/* ---- preflight: catch the common setup mistakes before we even boot ---- */
function preflight() {
  const problems = [];

  if (!fs.existsSync(path.join(dir, "node_modules"))) {
    problems.push({
      what: "Dependencies are not installed.",
      fix: "npm install",
    });
  }

  const envPath = path.join(dir, ".env");
  if (!fs.existsSync(envPath)) {
    const example = path.join(dir, ".env.example");
    if (fs.existsSync(example)) {
      fs.copyFileSync(example, envPath);
      console.log("\n  Created .env from .env.example — add your API key to it.\n");
    }
    problems.push({
      what: "No .env file (it is never shipped, for security).",
      fix: `Open ${path.join(dir, ".env")} and set XKIRO_API_KEY=sk-...`,
    });
  } else {
    const txt = fs.readFileSync(envPath, "utf8");
    const m = /^\s*XKIRO_API_KEY\s*=\s*(.*)$/m.exec(txt);
    const key = (m?.[1] || "").trim();
    if (!key || /your-key-here|sk-xt-your/.test(key)) {
      problems.push({
        what: "XKIRO_API_KEY is missing or still the placeholder.",
        fix: `Edit ${envPath} and set a real key: XKIRO_API_KEY=sk-...`,
      });
    }
  }

  if (problems.length) {
    console.error("\n" + "─".repeat(62));
    console.error("  NEXUS cannot start yet — please fix the following:\n");
    problems.forEach((p, i) => {
      console.error(`  ${i + 1}. ${p.what}`);
      console.error(`     → ${p.fix}\n`);
    });
    console.error("─".repeat(62) + "\n");
    process.exit(2);
  }
}

function boot() {
  const child = spawn(process.execPath, ["server.js"], { cwd: dir, stdio: "inherit", env: process.env });
  current = child;

  child.on("exit", (code, sig) => {
    if (shuttingDown) return;

    if (code === 2) {                       // fatal config error (port in use, bad env)
      console.error("[supervisor] fatal startup error — not restarting.");
      process.exit(2);
    }

    if (code === RESTART_CODE) {            // requested by restart_app
      crashes = 0;
      const fast = Date.now() - last < 1500;
      last = Date.now();
      if (fast && ++restarts > 5) {
        console.error("\n[supervisor] too many rapid restarts — stopping.");
        process.exit(1);
      }
      console.log("\n[supervisor] restarting NEXUS...\n");
      setTimeout(boot, 500);
      return;
    }

    if (code === 0 || sig === "SIGTERM") { process.exit(0); }   // clean shutdown

    // real crash
    crashes++;
    if (crashes >= MAX_CRASHES) {
      console.error("\n" + "─".repeat(62));
      console.error(`  NEXUS crashed ${crashes} times in a row — giving up.`);
      console.error("  Read the error above; it is the actual cause.\n");
      console.error("  Common fixes:");
      console.error("    • Missing credentials  → set XKIRO_API_KEY in .env");
      console.error("    • Cannot find package  → run: npm install");
      console.error("    • Port already in use  → run: set PORT=3001 && npm start");
      console.error("─".repeat(62) + "\n");
      process.exit(1);
    }
    console.error(`\n[supervisor] server crashed (code ${code}) — retry ${crashes}/${MAX_CRASHES} in 2s\n`);
    setTimeout(boot, 2000);
  });
}

const stop = () => { shuttingDown = true; try { current?.kill("SIGTERM"); } catch {} process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);

preflight();
console.log("[supervisor] starting NEXUS (auto-restart enabled)");
boot();
