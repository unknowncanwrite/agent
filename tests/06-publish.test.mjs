/* 06 — auto-publish: the site detector, the build step, and the Vercel / Render /
   GitHub backends, all verified against the mock's fake hosting APIs. */
import path from "node:path";
import fsp from "node:fs/promises";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { suite, test, ok, eq, has, hasNot, truthy, rejects, summary, makeSandbox, startMock, sleep } from "./lib.mjs";

suite("06 publish");

const mock = await startMock();
const ORIGIN = mock.url.replace(/\/v1$/, "");
const dir = await makeSandbox({ name: "nexus-publish", providersOff: [] });
const WS = path.join(dir, "workspace");
process.env.AGENT_WORKSPACE = WS;
process.env.AGENT_FULL_ACCESS = "false";
process.env.XKIRO_API_KEY = "sk-mock-test-key";
process.env.XKIRO_BASE_URL = mock.url;

const U = (f) => pathToFileURL(path.join(dir, f)).href;
const PUB = await import(U("publish.js"));
const agent = await import(U("agent.js"));

const writeSite = async (where, { title = "Mock Site", size = 40 } = {}) => {
  await fsp.mkdir(where, { recursive: true });
  await fsp.writeFile(path.join(where, "index.html"),
    `<!doctype html><html><head><title>${title}</title></head><body><h1>${title}</h1></body></html>\n`, "utf8");
  await fsp.writeFile(path.join(where, "style.css"), "body{font-family:sans-serif}\n", "utf8");
  await fsp.writeFile(path.join(where, "app.js"), "console.log('hi');\n", "utf8");
  await fsp.writeFile(path.join(where, "app.js.map"), "{}\n", "utf8");
  // a small binary asset to prove base64 encoding
  await fsp.writeFile(path.join(where, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, ...Array.from({ length: size }, (_, i) => i % 256)]));
  await fsp.mkdir(path.join(where, "node_modules", "junk"), { recursive: true });
  await fsp.writeFile(path.join(where, "node_modules", "junk", "x.js"), "module.exports=1;\n", "utf8");
};

/* ---------------- configuration ---------------- */
await test("with nothing configured, publish() explains what to set", async () => {
  for (const k of ["VERCEL_TOKEN", "RENDER_DEPLOY_HOOK_URL", "RENDER_API_KEY", "PUBLISH_GITHUB_REPO"]) delete process.env[k];
  eq(PUB.ready().length, 0, "a backend is ready without any credentials");
  eq(PUB.autoEnabled(), false, "auto-publish is on with no host configured");
  await writeSite(WS);
  const r = await PUB.publish({ dir: WS });
  eq(r.ok, false);
  has(r.error, "no publish backend configured");
  eq(r.backends.length, 3, "the three backends should always be listed");
  ok(r.backends.every((b) => b.env && b.hint), "each backend must say which variable to set");
  ok(r.backends.every((b) => b.console && b.console.startsWith("https://")), "each backend should link to where the credential comes from");
});

await test("backends() reports readiness from the environment", async () => {
  process.env.VERCEL_TOKEN = "vc-test-token";
  process.env.VERCEL_API_BASE = ORIGIN;
  const ready = PUB.ready();
  eq(ready.length, 1);
  eq(ready[0].id, "vercel");
  eq(PUB.autoEnabled(), true, "auto-publish should switch on as soon as a host is configured");
  eq(PUB.primary().id, "vercel");
});

/* ---------------- site detection ---------------- */
await test("detectSite() finds a static site in the folder itself", async () => {
  const s = await PUB.detectSite(WS);
  ok(s, "no site detected");
  eq(s.kind, "static");
  eq(s.entry, "index.html");
  eq(s.dir, WS);
});

await test("detectSite() returns null for a folder with no website", async () => {
  const empty = path.join(WS, "not-a-site");
  await fsp.mkdir(empty, { recursive: true });
  await fsp.writeFile(path.join(empty, "notes.txt"), "hello", "utf8");
  eq(await PUB.detectSite(empty), null);
});

await test("detectSite() recognises a node project with a build script", async () => {
  const proj = path.join(WS, "node-project");
  await fsp.mkdir(proj, { recursive: true });
  await fsp.writeFile(path.join(proj, "package.json"), JSON.stringify({
    name: "My Fancy Site!", private: true, scripts: { build: "node build.js" },
  }), "utf8");
  await fsp.writeFile(path.join(proj, "build.js"),
    'const fs=require("fs");fs.mkdirSync("dist",{recursive:true});fs.writeFileSync("dist/index.html","<h1>built</h1>");\n', "utf8");
  const s = await PUB.detectSite(proj);
  eq(s.kind, "node");
  eq(s.build, "node build.js");
  eq(s.outDir, null, "there is no build output yet");
  eq(s.name, "my-fancy-site", "project names must be DNS-safe: " + s.name);
});

await test("sites() lists the root site and nested ones", async () => {
  await writeSite(path.join(WS, "landing"));
  const found = await PUB.sites(WS);
  const dirs = found.map((s) => s.dir);
  eq(dirs[0], WS, "the folder you point at should win: " + dirs.join(", "));
  has(dirs.join("\n"), "landing", "the nested site was not found: " + dirs.join(", "));
});

/* ---------------- what counts as 'produced by this run' ---------------- */
await test("siteFromWritten() only publishes pages written during the run", async () => {
  const fresh = path.join(WS, "fresh-site");
  await writeSite(fresh);
  eq(await PUB.siteFromWritten([], WS), null, "an empty run must not publish an old site");
  const s = await PUB.siteFromWritten([path.join(fresh, "index.html")], WS);
  ok(s, "the freshly written site was not found");
  eq(s.dir, fresh);
  eq(s.fresh, true);
});

await test("siteFromWritten() ignores a page buried too deep to be a site root", async () => {
  const deep = path.join(WS, "a", "b", "c", "d", "site");
  await writeSite(deep);
  eq(await PUB.siteFromWritten([path.join(deep, "index.html")], WS), null);
});

/* ---------------- the Vercel backend ---------------- */
await test("publish() uploads the site to Vercel and returns the live URL", async () => {
  await fetch(ORIGIN + "/__reset", { method: "POST" });
  const r = await PUB.publish({ dir: WS, name: "my-landing-page" });
  eq(r.ok, true, JSON.stringify(r.error || r.logs));
  eq(r.backend, "vercel");
  eq(r.url, "https://my-landing-page.vercel.app");
  eq(r.deployment, "https://my-landing-page-mock.vercel.app");
  ok(r.files >= 4, "too few files uploaded: " + r.files);

  const deps = await (await fetch(ORIGIN + "/__deployments")).json();
  eq(deps.length, 1, "exactly one deployment should have been created");
  const d = deps[0];
  eq(d.name, "my-landing-page");
  eq(d.target, "production");
  const files = d.files.map((f) => f.file);
  for (const want of ["index.html", "style.css", "app.js"]) ok(files.includes(want), `missing ${want} in the upload`);
  hasNot(files.join(","), "app.js.map", "source maps should be skipped");
  hasNot(files.join(","), "node_modules", "dependencies must never be uploaded");
  eq(d.files.find((f) => f.file === "logo.png").encoding, "base64", "binary assets must be base64-encoded");
  eq(d.files.find((f) => f.file === "index.html").encoding, "utf-8");
});

await test("publish() builds a node project before deploying it", async () => {
  const proj = path.join(WS, "node-project");
  const r = await PUB.publish({ dir: proj, build: true });
  eq(r.ok, true, JSON.stringify(r.error || r.logs));
  has(await fsp.readFile(path.join(proj, "dist", "index.html"), "utf8"), "built", "the build never ran");
  has(r.dir, "dist", "publish() should deploy the build output, not the source folder");
  const deps = await (await fetch(ORIGIN + "/__deployments")).json();
  const last = deps.at(-1);
  has(last.files.map((f) => f.file).join(","), "index.html");
  has(r.logs.join(""), "npm run build", "the build step should be visible in the log");
});

await test("publish() reports a broken build instead of deploying stale output", async () => {
  const bad = path.join(WS, "broken-project");
  await fsp.mkdir(bad, { recursive: true });
  await fsp.writeFile(path.join(bad, "package.json"), JSON.stringify({
    name: "broken", scripts: { build: "node -e \"process.exit(3)\"" },
  }), "utf8");
  const r = await PUB.publish({ dir: bad });
  eq(r.ok, false);
  has(r.error, "build failed");
  has(r.logs.join(""), "npm run build");
});

await test("publish() refuses a folder with no website", async () => {
  const r = await PUB.publish({ dir: path.join(WS, "not-a-site") });
  eq(r.ok, false);
  has(r.error, "no website found");
});

await test("a rejected deployment surfaces the API error", async () => {
  const saved = process.env.VERCEL_API_BASE;
  process.env.VERCEL_API_BASE = ORIGIN + "/nope";
  const r = await PUB.publish({ dir: WS });
  eq(r.ok, false);
  has(String(r.error), "rejected the deployment");
  process.env.VERCEL_API_BASE = saved;
});

/* ---------------- the Render backend ---------------- */
await test("publish({backend:'render'}) triggers a deploy hook", async () => {
  const before = (await (await fetch(ORIGIN + "/__deployments")).json()).length;
  process.env.RENDER_DEPLOY_HOOK_URL = ORIGIN + "/hook";
  process.env.RENDER_SITE_URL = "https://demo-site.onrender.com";
  const r = await PUB.publish({ dir: WS, backend: "render" });
  eq(r.ok, true, JSON.stringify(r.error || r.logs));
  eq(r.backend, "render");
  eq(r.url, "https://demo-site.onrender.com");
  eq((await (await fetch(ORIGIN + "/__deployments")).json()).length, before, "render must not call the Vercel API");
  has(r.logs.join(""), "deploy hook", "the hook should be logged");
  delete process.env.RENDER_SITE_URL;
});

await test("publish({backend:'github'}) without a repo explains what is missing", async () => {
  const r = await PUB.publish({ dir: WS, backend: "github" });
  eq(r.ok, false);
  ok(/no publish backend configured|PUBLISH_GITHUB_REPO/.test(r.error), "unhelpful error: " + r.error);
});

/* ---------------- the agent tool ---------------- */
await test("publish_website tool deploys a built site and reports the URL", async () => {
  delete process.env.RENDER_DEPLOY_HOOK_URL;
  const events = [];
  const impl = agent.makeImpl({ send: (e) => events.push(e), freeOnly: true, runId: "pub-unit", written: [] });
  const out = await impl.publish_website({ dir: "fresh-site", name: "fresh-site" });
  has(out, "https://fresh-site.vercel.app", "the tool did not report the live URL");
  const ev = events.find((e) => e.type === "publish");
  ok(ev, "no publish event was emitted: " + JSON.stringify(events.map((e) => e.type)));
  eq(ev.ok, true);
  eq(ev.url, "https://fresh-site.vercel.app");
  truthy(events.some((e) => e.type === "publish_log"), "publish progress was not streamed");
});

await test("publish_website says exactly what to configure when no host exists", async () => {
  const saved = process.env.VERCEL_TOKEN;
  delete process.env.VERCEL_TOKEN;
  const events = [];
  const impl = agent.makeImpl({ send: (e) => events.push(e), freeOnly: true, runId: "pub-unit-2", written: [] });
  const out = await impl.publish_website({ dir: "fresh-site" });
  has(out, "NOT published publicly");
  has(out, "VERCEL_TOKEN");
  has(out, "RENDER_DEPLOY_HOOK_URL");
  const ev = events.find((e) => e.type === "publish");
  eq(ev.ok, false);
  eq(ev.local, true);
  truthy(ev.url?.startsWith("http://localhost:"), "a local preview URL should be offered: " + ev.url);
  const { killAll } = await import(U("shell.js"));
  killAll("pub-unit-2");
  process.env.VERCEL_TOKEN = saved;
});

await test("publish_website explains an empty folder instead of failing silently", async () => {
  const impl = agent.makeImpl({ send: () => {}, freeOnly: true, runId: "pub-unit-3", written: [] });
  const out = await impl.publish_website({ dir: "not-a-site" });
  has(out, "No website found");
});

summary();
