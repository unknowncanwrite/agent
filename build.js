#!/usr/bin/env node
/* Build a versioned release zip. Auto-increments the version number.
   Usage:  node build.js          -> next version
           node build.js 7        -> force version 7            */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const dir = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(dir, "..");
const vFile = path.join(dir, "VERSION");

const forced = process.argv[2] && /^\d+$/.test(process.argv[2]) ? Number(process.argv[2]) : null;
const current = fs.existsSync(vFile) ? Number(fs.readFileSync(vFile, "utf8").trim()) || 0 : 0;
const version = forced ?? current + 1;

fs.writeFileSync(vFile, String(version));

// keep package.json in step
const pkgPath = path.join(dir, "package.json");
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
pkg.version = `${version}.0.0`;
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n");

const name = `nexus-agent-v${version}`;
const zip = path.join(out, `${name}.zip`);
const bundle = path.join(out, `${name}.bundle`);
for (const f of [zip, bundle]) if (fs.existsSync(f)) fs.unlinkSync(f);

// Personal build: ship EVERYTHING except caches and build junk.
// .env, keys, memory, connectors and skills are all included on purpose.
const EXCLUDE = [
  "ai-chat/node_modules/*", "ai-chat/.git/*", "ai-chat/.pwlibs/*",
  "ai-chat/public/shots/*",
  "ai-chat/workspace/.pytest_cache/*", "ai-chat/workspace/__pycache__/*",
  "ai-chat/**/__pycache__/*", "ai-chat/**/.pytest_cache/*",
  "ai-chat/mcp.json",
  "ai-chat/.port",
  "ai-chat/vendor/__pycache__/*", "ai-chat/vendor/config.json",
].map((p) => `-x "${p}"`).join(" ");

// -y keeps symlinks, no -x on dotfiles so .env is included
execSync(`cd "${out}" && zip -r "${zip}" ai-chat ${EXCLUDE}`, { stdio: "ignore" });
try { execSync(`cd "${dir}" && git bundle create "${bundle}" --all`, { stdio: "ignore" }); } catch {}

const kb = (f) => (fs.existsSync(f) ? Math.round(fs.statSync(f).size / 1024) + " KB" : "—");
const hasEnv = fs.existsSync(path.join(dir, ".env"));
console.log(`\n  Built v${version}${hasEnv ? "  (includes .env with your API keys)" : ""}`);
console.log(`  ${name}.zip     ${kb(zip)}`);
console.log(`  ${name}.bundle  ${kb(bundle)}\n`);
