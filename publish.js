/* publish.js — put a finished website on the internet.
 *
 * Backends (first configured one wins, or pick explicitly with `backend`):
 *   vercel  VERCEL_TOKEN                     → deploy straight from the API, no CLI needed
 *   render  RENDER_DEPLOY_HOOK_URL           → trigger the deploy of a Render service
 *           or RENDER_API_KEY+RENDER_SERVICE_ID
 *   github  PUBLISH_GITHUB_REPO=owner/repo   → push the built files to a gh-pages branch
 *                                              through the GitHub API (uses your `gh` login)
 * Nothing configured → the caller gets ok:false plus exactly what to set; the agent tool
 * then falls back to serving the site locally so the user can still see it.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { runStream } from "./shell.js";

const SKIP_DIRS = new Set([
  "node_modules", ".git", ".next", ".nuxt", ".cache", ".vscode", ".idea", "__pycache__",
  ".venv", "venv", "dist", "build", "out", "target", "coverage", ".observations", ".memory",
  "uploads", "ms-playwright", ".pytest_cache", ".arena",
]);
const SITE_DIR_HINT = /^(site|web|website|www|public|dist|build|out|app|client|frontend|front-end|static|docs?)$/i;
const ENTRY = /^index\.html?$/i;
const MAX_FILES = 800;
const MAX_FILE_BYTES = 5 * 1024 * 1024;   // Vercel inline limit; bigger files are skipped with a warning

/* ---------------- backends ---------------- */

export function backends() {
  const e = process.env;
  return [
    { id: "vercel", label: "Vercel", rank: 1, ready: !!(e.VERCEL_TOKEN || "").trim(),
      env: "VERCEL_TOKEN", console: "https://vercel.com/account/tokens",
      hint: "Create a token, add it as VERCEL_TOKEN — deploys straight from the API" },
    { id: "render", label: "Render", rank: 2,
      ready: !!(e.RENDER_DEPLOY_HOOK_URL || "").trim() || !!(e.RENDER_API_KEY || "").trim() && !!(e.RENDER_SERVICE_ID || "").trim(),
      env: "RENDER_DEPLOY_HOOK_URL (or RENDER_API_KEY + RENDER_SERVICE_ID)",
      console: "https://dashboard.render.com",
      hint: "Your service → Settings → Deploy Hook → copy, add as RENDER_DEPLOY_HOOK_URL" },
    { id: "github", label: "GitHub Pages", rank: 3, ready: !!(e.PUBLISH_GITHUB_REPO || "").trim(),
      env: "PUBLISH_GITHUB_REPO=owner/repo", console: "https://github.com/settings/tokens",
      hint: "Needs the `gh` CLI signed in; set PUBLISH_GITHUB_REPO to the repo to publish into" },
  ];
}

export const ready = () => backends().filter((b) => b.ready);
export const primary = () => ready()[0] || null;
/** Auto-publish after a run: on by default as soon as a backend is configured. */
export const autoEnabled = () =>
  String(process.env.NEXUS_AUTO_PUBLISH ?? "true") !== "false" && ready().length > 0;
export const autoPublishMs = () => Number(process.env.NEXUS_PUBLISH_TIMEOUT_MS || 150000);

export const sanitizeName = (s) => {
  const n = String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return n || "nexus-site";
};

/* ---------------- site detection ---------------- */

async function isDir(p) { try { return (await fs.stat(p)).isDirectory(); } catch { return false; } }
async function hasFile(p) { try { return (await fs.stat(p)).isFile(); } catch { return false; } }

/** Describe a publishable site rooted at `dir`, or null if there is none. */
export async function detectSite(dir) {
  if (!(await isDir(dir))) return null;

  // 1. the directory itself is the site
  for (const entry of ["index.html", "index.htm"]) {
    if (await hasFile(path.join(dir, entry))) {
      return { dir, kind: "static", entry, name: sanitizeName(path.basename(path.resolve(dir))) };
    }
  }

  // 2. a node project with a build step
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(dir, "package.json"), "utf8"));
    const script = pkg.scripts?.build;
    if (script) {
      const out = (pkg.build?.outDir || "").replace(/^\.\//, "");
      let outDir = null;
      for (const cand of [out, "dist", "build", "out", "_site", "public"].filter(Boolean)) {
        if (await hasFile(path.join(dir, cand, "index.html"))) { outDir = path.join(dir, cand); break; }
      }
      return { dir, kind: "node", build: script, outDir, name: sanitizeName(pkg.name || path.basename(dir)),
               framework: pkg.dependencies?.next ? "next" : undefined,
               deps: !!(pkg.dependencies || pkg.devDependencies) };
    }
  } catch { /* not a node project */ }

  // 3. one small site somewhere below
  const found = await findSites(dir, 3);
  return found[0] || null;
}

/** Every publishable site under `root`, best candidate first. */
export async function sites(root) {
  const direct = await detectSite(root);
  const deeper = await findSites(root, 2);
  const all = [];
  if (direct) all.push(direct);
  for (const s of deeper) if (!all.some((x) => path.resolve(x.dir) === path.resolve(s.dir))) all.push(s);
  return all;
}

async function findSites(root, maxDepth) {
  const out = [];
  const walk = async (d, depth) => {
    if (out.length >= 12) return;
    let ents;
    try { ents = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    const dirs = [];
    for (const e of ents) {
      if (!e.isDirectory() || e.name.startsWith(".") || SKIP_DIRS.has(e.name)) continue;
      const p = path.join(d, e.name);
      if (await hasFile(path.join(p, "index.html"))) {
        let mtime = 0;
        try { mtime = (await fs.stat(path.join(p, "index.html"))).mtimeMs; } catch {}
        out.push({ dir: p, kind: "static", entry: "index.html", name: sanitizeName(e.name),
                   hint: SITE_DIR_HINT.test(e.name) ? 2 : 1, mtime });
      } else if (depth < maxDepth) {
        dirs.push(p);
      }
    }
    for (const p of dirs) await walk(p, depth + 1);
  };
  await walk(root, 0);
  out.sort((a, b) => (b.hint - a.hint) || (b.mtime - a.mtime));
  return out.map(({ hint, mtime, ...s }) => s);
}

/**
 * Which site (if any) did THIS run create? Only files written during the run count,
 * so a site left in the workspace by an earlier run is never re-published by accident.
 */
export async function siteFromWritten(written, root) {
  for (const abs of written || []) {
    if (!ENTRY.test(path.basename(abs))) continue;
    const dir = path.dirname(abs);
    if (!(await hasFile(abs))) continue;
    const rel = path.relative(root, dir);
    if (rel.split(path.sep).length > 4) continue;               // too deep to be the site root
    const site = await detectSite(dir);
    if (site) return { ...site, fresh: true };
  }
  // a build that only produced dist/ still counts
  for (const abs of written || []) {
    const dir = path.dirname(abs);
    const site = await detectSite(dir);
    if (site && site.outDir && path.resolve(abs).startsWith(path.resolve(site.outDir))) return { ...site, fresh: true };
  }
  return null;
}

/* ---------------- file collection ---------------- */

async function collect(dir, { onLog = () => {} } = {}) {
  const files = [];
  const skipped = [];
  let bytes = 0;
  const walk = async (d) => {
    let ents;
    try { ents = await fs.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      if (e.name.startsWith(".") && e.name !== ".well-known") continue;
      if (SKIP_DIRS.has(e.name)) continue;
      const abs = path.join(d, e.name);
      const rel = path.relative(dir, abs).split(path.sep).join("/");
      if (e.isDirectory()) { await walk(abs); continue; }
      if (!e.isFile()) continue;
      if (/\.(map|ts|tsx|md|lock|log)$/i.test(e.name)) { skipped.push(rel + " (not needed)"); continue; }
      if (files.length >= MAX_FILES) { skipped.push(rel + " (over the file cap)"); continue; }
      let st; try { st = await fs.stat(abs); } catch { continue; }
      if (st.size > MAX_FILE_BYTES) { skipped.push(`${rel} (${(st.size / 1048576).toFixed(1)}MB — too big for an inline deploy)`); continue; }
      if (/\.(png|jpe?g|gif|webp|ico|woff2?|ttf|otf|mp4|webm|mp3|pdf|zip)$/i.test(e.name)) {
        const buf = await fs.readFile(abs);
        files.push({ file: rel, size: st.size, data: buf.toString("base64"), encoding: "base64" });
      } else {
        const txt = await fs.readFile(abs, "utf8");
        files.push({ file: rel, size: st.size, data: txt, encoding: "utf-8" });
      }
      bytes += st.size;
    }
  };
  await walk(dir);
  if (skipped.length) onLog(`skipped: ${skipped.slice(0, 6).join(", ")}${skipped.length > 6 ? ` … +${skipped.length - 6}` : ""}\n`);
  onLog(`${files.length} files, ${(bytes / 1024).toFixed(0)} KB to upload\n`);
  return { files, bytes, skipped };
}

/* ---------------- build ---------------- */

async function buildSite(site, { onLog, signal }) {
  if (site.kind !== "node") return site;
  if (site.outDir && !process.env.NEXUS_FORCE_BUILD) {
    onLog(`reusing the existing build in ${path.relative(site.dir, site.outDir)}/\n`);
    return site;
  }
  const hasModules = await isDir(path.join(site.dir, "node_modules"));
  if (!hasModules && site.deps) {
    onLog("npm install …\n");
    const i = await runStream("npm install --no-audit --no-fund", { cwd: site.dir, timeout: 600, onData: (d) => onLog(d.text) });
    if (i.code !== 0) throw new Error(`npm install failed (exit ${i.code}): ${(i.stderr || i.stdout || "").slice(-600)}`);
  }
  onLog(`npm run build …\n`);
  const b = await runStream("npm run build", { cwd: site.dir, timeout: 900, onData: (d) => onLog(d.text) });
  if (b.code !== 0) throw new Error(`build failed (exit ${b.code}): ${(b.stderr || b.stdout || "").slice(-600)}`);

  for (const cand of ["dist", "build", "out", "_site", "public", ".next/static"]) {
    if (await hasFile(path.join(site.dir, cand, "index.html"))) {
      onLog(`build output: ${cand}/\n`);
      return { ...site, outDir: path.join(site.dir, cand) };
    }
  }
  if (await hasFile(path.join(site.dir, "index.html"))) return site;
  throw new Error("the build finished but no index.html was found in dist/, build/, out/ or the project root");
}

/* ---------------- backends ---------------- */

const jsonPost = (url, headers, body, signal) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body), signal });

async function publishVercel({ site, name, files, onLog, signal }) {
  const token = (process.env.VERCEL_TOKEN || "").trim();
  const api = (process.env.VERCEL_API_BASE || "https://api.vercel.com").replace(/\/+$/, "");
  const q = new URLSearchParams({ forceNew: "1", skipAutoDetectionConfirmation: "1" });
  if (process.env.VERCEL_TEAM_ID) q.set("teamId", process.env.VERCEL_TEAM_ID.trim());
  if (process.env.VERCEL_SLUG) q.set("slug", process.env.VERCEL_SLUG.trim());

  onLog(`vercel: creating production deployment "${name}" (${files.length} files)…\n`);
  const r = await jsonPost(`${api}/v13/deployments?${q}`,
    { authorization: `Bearer ${token}` },
    { name, project: name, target: "production",
      files: files.map((f) => ({ file: f.file, data: f.data, encoding: f.encoding })),
      projectSettings: { framework: null, buildCommand: null, outputDirectory: null, installCommand: null, devCommand: null } },
    signal);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Vercel rejected the deployment (${r.status}): ${j?.error?.message || JSON.stringify(j).slice(0, 300)}`);
  const alias = (process.env.VERCEL_SLUG || name).trim();
  onLog(`vercel: deployment ${j.id || "?"} ready\n`);
  return { url: `https://${alias}.vercel.app`, deployment: j.url ? `https://${j.url}` : null, id: j.id || null };
}

async function publishRender({ name, onLog, signal }) {
  const hook = (process.env.RENDER_DEPLOY_HOOK_URL || "").trim();
  const key = (process.env.RENDER_API_KEY || "").trim();
  const sid = (process.env.RENDER_SERVICE_ID || "").trim();
  const api = (process.env.RENDER_API_BASE || "https://api.render.com").replace(/\/+$/, "");

  if (hook) {
    onLog("render: triggering the deploy hook…\n");
    const r = await jsonPost(hook, {}, { ref: process.env.RENDER_BRANCH || undefined }, signal);
    const text = (await r.text().catch(() => "")).slice(0, 200);
    if (!r.ok) throw new Error(`Render deploy hook failed (${r.status}): ${text}`);
    onLog(`render: ${text.trim() || "deploy queued"}\n`);
    return { url: (process.env.RENDER_SITE_URL || "").trim() || null,
             note: "Render is building the service that owns this hook" };
  }
  if (!key || !sid) throw new Error("set RENDER_DEPLOY_HOOK_URL, or RENDER_API_KEY + RENDER_SERVICE_ID");

  onLog(`render: looking up service ${sid}…\n`);
  const res = await fetch(`${api}/v1/services/${sid}`, { headers: { authorization: `Bearer ${key}`, accept: "application/json" }, signal });
  const info = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Render service lookup failed (${res.status}): ${JSON.stringify(info).slice(0, 200)}`);
  const url = info?.serviceDetails?.url || info?.service?.serviceDetails?.url || null;

  onLog("render: starting a deploy…\n");
  const dep = await jsonPost(`${api}/v1/services/${sid}/deploys`, { authorization: `Bearer ${key}`, accept: "application/json" },
    { clearCache: false }, signal);
  const dj = await dep.json().catch(() => ({}));
  if (!dep.ok) throw new Error(`Render deploy failed (${dep.status}): ${JSON.stringify(dj).slice(0, 200)}`);
  onLog(`render: deploy ${dj.id || dj.deploy?.id || "?"} started\n`);
  return { url: url ? (url.startsWith("http") ? url : "https://" + url) : null, id: dj.id || dj.deploy?.id || null,
           note: `Render service "${info?.name || name}"` };
}

async function publishGithub({ files, onLog, signal }) {
  const repo = (process.env.PUBLISH_GITHUB_REPO || "").trim();
  const branch = (process.env.PUBLISH_GITHUB_BRANCH || "gh-pages").trim();
  const gh = (process.env.GH_BIN || "gh").trim();
  const [owner, name] = repo.split("/");
  if (!owner || !name) throw new Error('PUBLISH_GITHUB_REPO must look like "owner/repo"');

  const tmp = path.join((await fs.mkdtemp("/tmp/nexus-publish-")), "payload.json");
  for (const f of files) {
    if (f.size > 900 * 1024) { onLog(`github: skipping ${f.file} (over the 900KB contents-API limit)\n`); continue; }
    onLog(`github: uploading ${f.file}\n`);
    await fs.writeFile(tmp, JSON.stringify({
      message: `publish ${f.file}`, branch,
      content: Buffer.from(f.data, f.encoding === "base64" ? "base64" : "utf8").toString("base64"),
    }), "utf8");
    const r = await runStream(`${gh} api --method PUT "repos/${owner}/${name}/contents/${f.file}" --input ${tmp}`,
      { cwd: "/tmp", timeout: 120, onData: (d) => { if (d.stream === "stderr") onLog(d.text); } });
    if (r.code !== 0) throw new Error(`gh api failed for ${f.file}: ${(r.stderr || r.stdout || "").slice(-400)}`);
  }
  onLog("github: enabling Pages…\n");
  const enable = await runStream(`${gh} api --method POST "repos/${owner}/${name}/pages" -f "source[branch]=${branch}" -f "source[path]=/"`,
    { cwd: "/tmp", timeout: 120 });
  if (enable.code !== 0 && !/already exists|409/i.test(enable.stderr || "")) {
    await runStream(`${gh} api --method PUT "repos/${owner}/${name}/pages" -f "source[branch]=${branch}" -f "source[path]=/"`,
      { cwd: "/tmp", timeout: 120 });
  }
  return { url: `https://${owner}.github.io/${name}/`, note: `branch ${branch} of ${repo}` };
}

async function publishLocal({ site, onLog }) {
  onLog("no Vercel/Render/GitHub credentials configured — serving the site locally instead\n");
  return { url: null, local: true, dir: site.dir,
           note: "set VERCEL_TOKEN (or RENDER_DEPLOY_HOOK_URL, or PUBLISH_GITHUB_REPO) for a public URL" };
}

/* ---------------- public API ---------------- */

/**
 * Publish a site. Returns { ok, url, backend, dir, files, bytes, logs, error? }.
 * Never throws for configuration problems — the caller decides what to tell the user.
 */
export async function publish({ dir, name, backend, build = true, onLog = () => {}, signal } = {}) {
  const logs = [];
  const log = (t) => { const s = String(t); logs.push(s); try { onLog(s); } catch {} };

  const target = backend ? backends().find((b) => b.id === backend) : primary();
  if (backend && !target) return { ok: false, error: `unknown publish backend "${backend}"`, backends: backends(), logs };
  if (!target || !target.ready) return { ok: false, error: "no publish backend configured", backends: backends(), logs };

  let site = await detectSite(dir);
  if (!site) return { ok: false, error: `no website found in ${dir} (looked for index.html or a package.json build)`, logs };

  const projectName = sanitizeName(name || site.name || path.basename(site.dir));
  log(`site: ${site.dir} (${site.kind})\n`);

  try {
    if (build) site = await buildSite(site, { onLog: log, signal });
    const publishDir = site.outDir || site.dir;
    const { files, bytes } = await collect(publishDir, { onLog: log });
    if (!files.length) throw new Error("nothing to upload — the site directory is empty");

    let out;
    if (target.id === "vercel") out = await publishVercel({ site, name: projectName, files, onLog: log, signal });
    else if (target.id === "render") out = await publishRender({ name: projectName, onLog: log, signal });
    else if (target.id === "github") out = await publishGithub({ files, onLog: log, signal });
    else out = await publishLocal({ site, onLog: log });

    if (out.url) log(`live: ${out.url}\n`);
    return { ok: true, backend: target.id, backendLabel: target.label, dir: publishDir, name: projectName,
             files: files.length, bytes, logs, ...out };
  } catch (e) {
    log(`FAILED: ${e.message}\n`);
    return { ok: false, backend: target.id, error: e.message, dir, logs };
  }
}
