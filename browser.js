/* Headless Chromium + web access for the agent */
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Vendored libs (no-root Linux installs). Harmless elsewhere.
if (process.platform === "linux") {
  process.env.LD_LIBRARY_PATH = [path.join(__dirname, ".pwlibs"), process.env.LD_LIBRARY_PATH || ""].join(":");
}

let _pw = null, _browser = null, _execPath = null;
export const SHOTS = path.join(__dirname, "public", "shots");
await fs.mkdir(SHOTS, { recursive: true });

export let onSetupLog = () => {};
export function setSetupLogger(fn) { onSetupLog = fn || (() => {}); }

async function browser() {
  if (_browser && _browser.isConnected()) return _browser;
  const { ensureBrowser } = await import("./setup.js");
  const info = await ensureBrowser((t) => onSetupLog(t));
  if (!info.ok) throw new Error("No browser available: " + (info.error || "install failed"));
  _execPath = info.path;
  if (!_pw) _pw = await import("playwright-core");
  _browser = await _pw.chromium.launch({
    executablePath: _execPath,
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });
  return _browser;
}
export async function closeBrowser() { try { await _browser?.close(); } catch {} _browser = null; }

const stamp = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/** Screenshot a URL or a local file; returns {file, url, title, console, errors} */
export async function screenshot({ url, file, width = 1280, height = 800, fullPage = true, wait = 1200, root }) {
  const b = await browser();
  const ctx = await b.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const logs = [], errors = [];
  page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`.slice(0, 300)));
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 300)));

  let target = url;
  if (!target && file) target = "file://" + path.resolve(root, file);
  try {
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(wait);
  } catch (e) {
    errors.push("navigation: " + e.message.slice(0, 200));
  }
  const name = `shot-${stamp()}.png`;
  await page.screenshot({ path: path.join(SHOTS, name), fullPage });
  const title = await page.title().catch(() => "");
  const text = (await page.evaluate(() => document.body?.innerText || "").catch(() => "")).slice(0, 4000);
  await ctx.close();
  return { file: name, url: "/shots/" + name, title, text, console: logs.slice(0, 25), errors };
}

/** Drive a page: click / type / press, then screenshot */
export async function interact({ url, file, actions = [], root, width = 1280, height = 800 }) {
  const b = await browser();
  const ctx = await b.newContext({ viewport: { width, height } });
  const page = await ctx.newPage();
  const logs = [], errors = [], done = [];
  page.on("console", (m) => logs.push(`[${m.type()}] ${m.text()}`.slice(0, 250)));
  page.on("pageerror", (e) => errors.push(String(e).slice(0, 250)));
  let target = url || ("file://" + path.resolve(root, file));
  try { await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30000 }); await page.waitForTimeout(700); }
  catch (e) { errors.push("navigation: " + e.message.slice(0, 200)); }

  for (const a of actions) {
    try {
      if (a.type === "click") { await page.click(a.selector, { timeout: 6000 }); done.push(`clicked ${a.selector}`); }
      else if (a.type === "fill") { await page.fill(a.selector, String(a.value ?? ""), { timeout: 6000 }); done.push(`filled ${a.selector}`); }
      else if (a.type === "press") { await page.keyboard.press(a.key); done.push(`pressed ${a.key}`); }
      else if (a.type === "wait") { await page.waitForTimeout(Math.min(a.ms || 500, 8000)); done.push(`waited ${a.ms}ms`); }
      else if (a.type === "eval") { const r = await page.evaluate(a.script); done.push(`eval → ${JSON.stringify(r)?.slice(0, 200)}`); }
      await page.waitForTimeout(250);
    } catch (e) { done.push(`FAILED ${a.type} ${a.selector || ""}: ${e.message.slice(0, 140)}`); }
  }
  const name = `shot-${stamp()}.png`;
  await page.screenshot({ path: path.join(SHOTS, name), fullPage: true });
  const text = (await page.evaluate(() => document.body?.innerText || "").catch(() => "")).slice(0, 3000);
  await ctx.close();
  return { file: name, url: "/shots/" + name, actions: done, text, console: logs.slice(0, 25), errors };
}

/** Fetch a page and return readable text (agent's "read the internet") */
/** A browser we already have — never triggers a download. */
async function existingBrowser() {
  const setup = await import("./setup.js");
  if (!setup.chromiumPath() && !setup.systemBrowser()) return null;
  return await browser();
}

/** Readable text of a page without any browser: plain HTTP + a crude HTML strip. */
export async function httpText(url, max = 12000) {
  try {
    const r = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(30000),
      headers: { "user-agent": "Mozilla/5.0 (compatible; NEXUS/1.0)" } });
    if (!r.ok) return `ERROR fetching page: HTTP ${r.status} ${r.statusText}`;
    const raw = await r.text();
    const txt = raw
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article|br)>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/ /g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
      .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    return txt.slice(0, max);
  } catch (e) { return "ERROR fetching page: " + (e?.message || e); }
}

export async function fetchText(url, max = 12000) {
  const b = await existingBrowser().catch(() => null);
  if (!b) return await httpText(url, max);   // no Chromium: plain HTTP still gets the page
  const ctx = await b.newContext();
  const page = await ctx.newPage();
  let out = "";
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForTimeout(800);
    out = await page.evaluate(() => {
      document.querySelectorAll("script,style,nav,footer,svg,noscript").forEach(e => e.remove());
      return (document.body?.innerText || "").replace(/\n{3,}/g, "\n\n");
    });
  } catch (e) { out = "ERROR fetching page: " + e.message; }
  await ctx.close();
  return out.slice(0, max);
}

/** Web search via Bing (DuckDuckGo blocks datacenter IPs) */
function unwrapBing(u) {
  try {
    const m = /[?&]u=a1([^&]+)/.exec(u || "");
    if (m) return Buffer.from(m[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
  } catch {}
  return u;
}
export async function webSearch(query, n = 8) {
  const b = await browser();
  const ctx = await b.newContext({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36" });
  const page = await ctx.newPage();
  let results = [];
  try {
    await page.goto("https://www.bing.com/search?q=" + encodeURIComponent(query), { waitUntil: "domcontentloaded", timeout: 30000 });
    await page.waitForSelector("#b_results li.b_algo", { timeout: 12000 }).catch(() => {});
    results = await page.evaluate(() => Array.from(document.querySelectorAll("#b_results li.b_algo")).slice(0, 12).map(r => ({
      title: r.querySelector("h2 a")?.innerText?.trim() || "",
      url: r.querySelector("h2 a")?.href || "",
      snippet: (r.querySelector(".b_caption p, .b_algoSlug, .b_lineclamp2")?.innerText || "").trim().slice(0, 320),
    })).filter(x => x.title));
    results = results.map(r => ({ ...r, url: r.url }));
  } catch (e) { results = [{ title: "search error", url: "", snippet: e.message }]; }
  await ctx.close();
  return results.slice(0, n).map(r => ({ ...r, url: unwrapBing(r.url) }));
}
