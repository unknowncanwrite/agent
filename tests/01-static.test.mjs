/* 01 — static checks: does the repository actually contain a runnable, sane app? */
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { suite, test, ok, eq, has, hasNot, summary, APP_DIR, expectDefect } from "./lib.mjs";
import { execFileSync } from "node:child_process";

suite("01 static");

const read = (p) => fsp.readFile(path.join(APP_DIR, p), "utf8");
const exists = (p) => fs.existsSync(path.join(APP_DIR, p));

let pkg = null;

await test("package.json parses and declares start/main", async () => {
  pkg = JSON.parse(await read("package.json"));
  ok(pkg.scripts?.start, "package.json has no start script");
  ok(pkg.type === "module", "package.json should be type:module (sources use ESM)");
  ok(pkg.dependencies?.express, "express missing from dependencies");
  ok(pkg.dependencies?.openai, "openai missing from dependencies");
});

await test("every .js source parses (node --check)", async () => {
  const files = (await fsp.readdir(APP_DIR)).filter((f) => f.endsWith(".js"));
  ok(files.length >= 15, `expected the full source tree, found ${files.length} js files`);
  const bad = [];
  for (const f of files) {
    try { execFileSync(process.execPath, ["--check", path.join(APP_DIR, f)], { stdio: "pipe" }); }
    catch (e) { bad.push(`${f}: ${String(e.stderr || e).split("\n").slice(0, 3).join(" ")}`); }
  }
  ok(!bad.length, "syntax errors:\n      " + bad.join("\n      "));
});

await test("public/ sources parse too", async () => {
  for (const f of ["public/app.js"]) {
    try { execFileSync(process.execPath, ["--check", path.join(APP_DIR, f)], { stdio: "pipe" }); }
    catch (e) { ok(false, `${f} has a syntax error: ${e.message}`); }
  }
});

await test("core files exist", async () => {
  const need = ["server.js", "agent.js", "start.js", "models.js", "providers.js", "router.js",
    "supervisor.js", "memory.js", "shell.js", "jobs.js", "hooks.js", "mcp.js", "skills.js",
    "public/index.html", "public/app.js", "public/style.css", "README.md", "ARCHITECTURE.md"];
  const missing = need.filter((f) => !exists(f));
  ok(!missing.length, "missing files: " + missing.join(", "));
});

await test("launcher scripts exist and are usable", async () => {
  ok(exists("START-MAC-LINUX.sh"), "START-MAC-LINUX.sh missing");
  const sh = await read("START-MAC-LINUX.sh");
  ok(sh.startsWith("#!"), "START-MAC-LINUX.sh has no shebang");
  has(sh, "npm", "the launcher never runs npm");
  ok(exists("START-WINDOWS.bat"), "START-WINDOWS.bat missing");
  has(await read("START-WINDOWS.bat"), "node", "the Windows launcher never runs node");
});

await expectDefect(
  "START-MAC-LINUX.sh is documented as runnable but is not executable in git",
  () => (fs.statSync(path.join(APP_DIR, "START-MAC-LINUX.sh")).mode & 0o111) === 0,
  "README.md line 20 tells macOS/Linux users to run `START-MAC-LINUX.sh`, but the file is committed with\n" +
  "mode 100644, so `./START-MAC-LINUX.sh` fails with 'permission denied'. It only works as\n" +
  "`bash START-MAC-LINUX.sh`, which is not what the docs say.",
  "low");

await test("no real credentials are committed", async () => {
  const files = (await fsp.readdir(APP_DIR)).filter((f) => /\.(js|json|md|sh|bat|py)$/.test(f));
  const hits = [];
  for (const f of files) {
    if (f === "package-lock.json") continue;
    const txt = await read(f);
    for (const m of txt.matchAll(/\b(sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{30,})\b/g)) {
      if (!/x{4,}|your-key|example|mock|test/i.test(txt.slice(Math.max(0, m.index - 40), m.index + 40))) hits.push(`${f}: ${m[0].slice(0, 12)}…`);
    }
  }
  ok(!hits.length, "possible live keys committed:\n      " + hits.join("\n      "));
});

await test("hooks.json and mcp.json are valid JSON", async () => {
  const h = JSON.parse(await read("hooks.json"));
  ok(Array.isArray(h.hooks), "hooks.json has no hooks array");
  const m = JSON.parse(await read("mcp.json"));
  ok(m && typeof m === "object", "mcp.json is not an object");
});

await test("every shipped skill has a SKILL.md with a description", async () => {
  const dir = path.join(APP_DIR, "skills");
  const skills = (await fsp.readdir(dir, { withFileTypes: true })).filter((d) => d.isDirectory()).map((d) => d.name);
  ok(skills.length >= 5, `expected the built-in skills, found ${skills.length}`);
  for (const s of skills) {
    const p = path.join(dir, s, "SKILL.md");
    ok(fs.existsSync(p), `${s} has no SKILL.md`);
    ok((await fsp.readFile(p, "utf8")).trim().length > 20, `${s}/SKILL.md is empty`);
  }
});

await test("public/index.html references assets that exist", async () => {
  const html = await read("public/index.html");
  for (const m of html.matchAll(/(?:src|href)="\.?\/?([\w./-]+\.(?:js|css|png|ico|svg))"/g)) {
    ok(exists("public/" + m[1].replace(/^public\//, "")), `index.html references missing public/${m[1]}`);
  }
  has(html, "app.js", "index.html does not load app.js");
  for (const id of ["shell", "stage", "feed", "rail"]) has(html, `id="${id}"`, `index.html lost its #${id} container`);
});

await test("VERSION agrees with package.json", async () => {
  const v = (await read("VERSION")).trim();
  ok(/^\d+(\.\d+)*$/.test(v), `VERSION looks wrong: ${JSON.stringify(v)}`);
  const pv = String(pkg.version || "");
  eq(pv.split(".")[0], v.split(".")[0], `package.json version ${pv} does not match VERSION ${v}`);
});

await test("runtime docs mention the security-relevant switches", async () => {
  const env = await read("env.js").catch(() => "");
  const doc = (await read("README.md")) + env;
  for (const k of ["AGENT_FULL_ACCESS", "AGENT_WORKSPACE", "XKIRO_API_KEY"]) has(doc, k, `${k} is not documented`);
});

/* ---- repo hygiene: findings, not failures ---- */

await expectDefect(
  "no .gitignore — runtime state and secrets can be committed",
  () => !exists(".gitignore"),
  "The repo has no .gitignore. .env, .memory/, workspace/, uploads/, .providers-off.json, providers.json and node_modules can all be committed by accident.\nLive consequences: any key you put in .env is one `git add .` away from a public repo.",
  "high");

await expectDefect(
  "no .env.example — setup instructions point at a file that does not exist",
  () => !exists(".env.example"),
  "models.js tells the user to `copy .env.example to .env`, and README documents env vars, but the repo ships no .env.example. A new user has to guess every variable name.",
  "medium");

summary();
