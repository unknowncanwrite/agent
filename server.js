import "./env.js";
import express from "express";
import path from "node:path";
import fsp from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runAgent, makeImpl, ROOT, APP_DIR, killAll, PROCS, resolvePath, invalidateCache } from "./agent.js";
import { client, loadModels, complete, chainFor, streamWithFailover, isQuota, needsBalance } from "./models.js";
import { runStream, sysInfo, isFull, setFullAccess } from "./shell.js";
import { detectToolchain, ensureBrowser } from "./setup.js";
import { route as routeMsg, roleFor } from "./router.js";
import * as OS from "./oscontrol.js";
import * as MEM from "./memory.js";
import * as MCP from "./mcp.js";
import * as HOOK from "./hooks.js";
import * as JOBS from "./jobs.js";
import * as PUB from "./publish.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ---- log bus: mirror all server output to connected UIs ---- */
const LOG = { buf: [], subs: new Set() };
function pushLog(level, text) {
  const line = { t: Date.now(), level, text: String(text) };
  LOG.buf.push(line);
  if (LOG.buf.length > 500) LOG.buf.shift();
  for (const fn of LOG.subs) { try { fn(line); } catch {} }
}
for (const [level, orig] of [["info", console.log], ["error", console.error], ["warn", console.warn]]) {
  console[level === "info" ? "log" : level] = (...a) => {
    orig.apply(console, a);
    pushLog(level, a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" "));
  };
}
process.on("uncaughtException", (e) => { console.error("UNCAUGHT: " + (e?.stack || e?.message || e)); });
process.on("unhandledRejection", (e) => { console.error("UNHANDLED REJECTION: " + (e?.stack || e?.message || e)); });

const app = express();
app.use(express.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, "public")));

const CACHE_BUST = () => { loadModels(true).catch(() => {}); };

const sse = (res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
  return (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
};

/* ---- live server log stream ---- */
app.get("/api/logs", (req, res) => {
  const send = sse(res);
  LOG.buf.slice(-120).forEach((l) => send({ type: "log", ...l }));
  const fn = (l) => send({ type: "log", ...l });
  LOG.subs.add(fn);
  const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 20000);
  req.on("close", () => { LOG.subs.delete(fn); clearInterval(ping); });
});

/* ---- health: actually test the upstream API ---- */
app.get("/api/health", async (_req, res) => {
  const out = { server: "ok", key: false, upstream: false, models: 0, error: null, baseURL: process.env.XKIRO_BASE_URL || "https://api.xkiro.com/v1" };
  const k = (process.env.XKIRO_API_KEY || "").trim();
  out.key = !!k && !/your-key-here/i.test(k);
  out.keyPreview = k ? k.slice(0, 8) + "…" + k.slice(-4) : "(none)";
  if (!out.key) { out.error = "No API key set in .env (XKIRO_API_KEY)."; return res.json(out); }
  try {
    const list = await loadModels(true);
    out.upstream = true;
    out.models = list.length;
    out.free = list.filter((m) => m.tier === "free").length;
  } catch (e) {
    out.error = e?.status === 401 ? "API key rejected (401). Check the key in .env."
      : e?.message?.includes("fetch") ? "Cannot reach the API. Check internet/proxy/firewall."
      : (e?.message || "Unknown upstream error");
    console.error("[health] upstream failed: " + out.error);
  }
  res.json(out);
});

/* ---- models (free first) ---- */
app.get("/api/models", async (_req, res) => {
  try { res.json(await loadModels()); }
  catch (e) {
    const msg = e?.status === 401 ? "API key rejected (401) — check XKIRO_API_KEY in .env"
      : /fetch|ENOTFOUND|ECONN/i.test(e?.message || "") ? "Cannot reach the model API — check internet/firewall"
      : e?.message || "Failed to load models";
    console.error("[/api/models] " + msg);
    res.status(500).json({ error: msg });
  }
});

/* ---- plain chat ---- */
app.post("/api/chat", async (req, res) => {
  const { messages = [], model, temperature = 0.7, system, max_tokens, freeOnly = true } = req.body || {};
  const send = sse(res);
  const controller = new AbortController();
  res.on("close", () => controller.abort());
  try {
    const chain = await chainFor("main", model, freeOnly);
    const body = {
      temperature,
      messages: system ? [{ role: "system", content: system }, ...messages] : messages,
      ...(max_tokens ? { max_tokens } : {}),
    };
    const { model: used, first, it } = await streamWithFailover(body,
      { chain, signal: controller.signal, onSwitch: (m) => send({ type: "model_switch", model: m }) });
    let usage = null;
    const emit = (chunk) => {
      if (chunk?.usage) usage = chunk.usage;
      const d = chunk?.choices?.[0]?.delta || {};
      if (d.reasoning_content || d.reasoning) send({ type: "reasoning", text: d.reasoning_content || d.reasoning });
      if (d.content) send({ type: "delta", text: d.content });
    };
    if (!first.done) emit(first.value);
    while (true) { const n = await it.next(); if (n.done) break; emit(n.value); }
    send({ type: "done", usage, model: used });
  } catch (e) {
    const msg = isQuota(e) ? "Daily FREE-model quota used up — disable 'Free models only' or wait for reset"
      : e?.status === 401 ? "API key rejected (401) — check XKIRO_API_KEY in .env"
      : /fetch|ENOTFOUND|ECONN/i.test(e?.message || "") ? "Cannot reach the model API — check internet/firewall"
      : e?.message || "Request failed";
    console.error("[/api/chat] " + msg);
    send({ type: "error", error: msg });
  }
  finally { res.end(); }
});

app.post("/api/title", async (req, res) => {
  try {
    const chain = await chainFor("fast", null, true);
    const { res: r } = await complete({
      temperature: 0.3,
      messages: [
        { role: "system", content: "Return a 2-5 word title. No quotes, no trailing punctuation." },
        { role: "user", content: String(req.body?.text || "").slice(0, 1200) }],
    }, { chain });
    res.json({ title: (r.choices[0].message.content || "New chat").trim().slice(0, 60) });
  } catch { res.json({ title: "New chat" }); }
});

/* ---- agent ---- */
app.post("/api/agent", async (req, res) => {
  const { messages = [], model, maxSteps = 40, freeOnly = true } = req.body || {};
  const send = sse(res);
  const controller = new AbortController();
  res.on("close", () => controller.abort());
  try { await runAgent({ model, messages, send, maxSteps, signal: controller.signal, freeOnly }); }
  catch (e) { send({ type: "error", error: e?.message || "agent failed" }); }
  finally { res.end(); }
});

/* ---- SMART endpoint: detached background jobs, reattachable ---- */
async function runSmart(send, signal, { messages, model, maxSteps, freeOnly, forceAgent }) {
  const last = [...messages].reverse().find((m) => m.role === "user")?.content || "";
  send({ type: "routing" });
  const decision = await routeMsg(typeof last === "string" ? last : JSON.stringify(last),
    { freeOnly, signal, forceAgent });
  send({ type: "route", ...decision });

  if (decision.route === "agent") {
    await runAgent({ model, messages, send, maxSteps, signal, freeOnly });
    return;
  }
  const chain = await chainFor(roleFor(decision), model, freeOnly);
  const { model: used, first, it } = await streamWithFailover(
    { messages, temperature: 0.7 },
    { chain, signal, onSwitch: (m) => send({ type: "model_switch", model: m }) });
  send({ type: "model", model: used });
  const emit = (c) => {
    const d = c?.choices?.[0]?.delta || {};
    if (d.reasoning_content || d.reasoning) send({ type: "reasoning", text: d.reasoning_content || d.reasoning });
    if (d.content) send({ type: "delta", text: d.content });
  };
  if (!first.done) emit(first.value);
  while (true) { const n = await it.next(); if (n.done) break; emit(n.value); }
  send({ type: "done", model: used });
}

app.post("/api/smart", async (req, res) => {
  const { messages = [], model, maxSteps = 40, freeOnly = true, forceAgent = false,
          chatId = "default", title = "" } = req.body || {};
  const send = sse(res);

  if (JOBS.isRunning(chatId)) {
    send({ type: "error", error: "This chat already has a task running. Open it to watch, or stop it first." });
    return res.end();
  }

  // Attach FIRST so no event can be missed, then start the job.
  let sub = null;
  let ended = false;
  const finish = () => { if (!ended) { ended = true; sub?.detach(); try { res.end(); } catch {} } };
  res.on("close", () => { ended = true; sub?.detach(); });

  const r = JOBS.start({
    chatId, title: title || String(messages.at(-1)?.content || "").slice(0, 60),
    fn: (s, signal) => runSmart(s, signal, { messages, model, maxSteps, freeOnly, forceAgent })
      .catch((e) => {
        const msg = isQuota(e) ? "Daily FREE-model quota is used up. It resets tomorrow — or add credit to use paid models."
          : needsBalance(e) ? "Free quota spent and paid models need account credit."
          : e?.status === 401 ? "API key rejected (401) — check your key in .env"
          : e?.message || "Request failed";
        console.error("[/api/smart] " + msg);
        s({ type: "error", error: msg });
      }),
  });
  if (!r.ok) { send({ type: "error", error: r.error }); return res.end(); }

  // replay from the very beginning; disconnecting does NOT stop the job
  sub = JOBS.attach(chatId, (ev) => {
    if (ended) return;
    try { send(ev); } catch { ended = true; return; }
    if (ev.type === "job_end") finish();
  }, -1);
});

/* ---- reattach to a running job (after tab switch / reload) ---- */
app.get("/api/jobs", (_req, res) => res.json(JOBS.list()));
app.get("/api/jobs/:chatId/stream", (req, res) => {
  const since = Number(req.query.since ?? -1);
  const send = sse(res);
  const sub = JOBS.attach(req.params.chatId, (ev) => {
    try { send(ev); if (ev.type === "job_end") res.end(); } catch {}
  }, since);
  if (!sub) { send({ type: "no_job" }); return res.end(); }
  const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 20000);
  res.on("close", () => { sub.detach(); clearInterval(ping); });
});
app.post("/api/jobs/:chatId/stop", (req, res) => res.json({ stopped: JOBS.stop(req.params.chatId) }));
app.post("/api/jobs/stopall", (_req, res) => res.json({ stopped: JOBS.stopAll() }));

/* ---- OS control (cursor/keyboard) ---- */
app.get("/api/os/status", async (_req, res) => res.json(await OS.status()));
app.post("/api/os/install", async (_req, res) => {
  const send = sse(res);
  try { const r = await OS.install((t) => send({ type: "data", text: t })); send({ type: "done", ...r }); }
  catch (e) { send({ type: "done", ok: false, error: e.message }); }
  finally { res.end(); }
});

/* ---- file upload (binary attachments land in the workspace) ---- */
app.post("/api/upload", express.raw({ type: "multipart/form-data", limit: "60mb" }), async (req, res) => {
  try {
    const ct = req.headers["content-type"] || "";
    const b = /boundary=(?:"([^"]+)"|([^;]+))/.exec(ct);
    if (!b) return res.status(400).json({ error: "no boundary" });
    const boundary = "--" + (b[1] || b[2]).trim();
    const buf = req.body;
    const parts = [];
    let start = buf.indexOf(boundary);
    while (start !== -1) {
      const next = buf.indexOf(boundary, start + boundary.length);
      if (next === -1) break;
      parts.push(buf.slice(start + boundary.length, next));
      start = next;
    }
    const up = path.join(ROOT, "uploads");
    await fsp.mkdir(up, { recursive: true });
    let saved = null;
    for (const p of parts) {
      const hEnd = p.indexOf("\r\n\r\n");
      if (hEnd === -1) continue;
      const head = p.slice(0, hEnd).toString();
      const m = /filename="([^"]*)"/.exec(head);
      if (!m || !m[1]) continue;
      let body = p.slice(hEnd + 4);
      if (body.slice(-2).toString() === "\r\n") body = body.slice(0, -2);
      const safe = path.basename(m[1]).replace(/[^\w.\-]/g, "_");
      const dest = path.join(up, safe);
      await fsp.writeFile(dest, body);
      saved = { name: safe, path: path.relative(ROOT, dest), bytes: body.length };
    }
    if (!saved) return res.status(400).json({ error: "no file found" });
    console.log(`[upload] ${saved.name} (${saved.bytes}b)`);
    res.json(saved);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ---- connect an MCP server on demand ---- */
app.post("/api/mcp/add", async (req, res) => {
  const { name, command, args = [], env = {} } = req.body || {};
  try {
    const cfg = await MCP.loadConfig();
    cfg.mcpServers = cfg.mcpServers || {};
    cfg.mcpServers[name] = { command, args, env };
    await MCP.saveConfig(cfg);
    const srv = await MCP.connect(name, cfg.mcpServers[name]);
    console.log(`[mcp] ${name} connected (${srv.tools.length} tools)`);
    res.json({ ok: true, tools: srv.tools.length, names: srv.tools.map((t) => t.name) });
  } catch (e) {
    console.error(`[mcp] ${name} failed: ${e.message}`);
    res.json({ ok: false, error: e.message });
  }
});

/* ---- providers (local + cloud) ---- */
app.get("/api/providers", async (_req, res) => {
  const P = await import("./providers.js");
  const list = P.all().map((p) => ({ id: p.id, label: p.label, local: p.local, baseURL: p.baseURL, enabled: p.enabled !== false }));
  // live-probe the local presets so the UI shows reality, not boot-time state
  const presets = await Promise.all(P.LOCAL_PRESETS.map(async (p) => {
    const r = await P.ping(p.baseURL, 1200);
    return { ...p, up: r.up, models: (r.models || []).length };
  }));
  res.json({ providers: list, presets, cloud: P.CLOUD_PRESETS.map((c) => ({ ...c, enabled: P.isEnabled(c.id) })) });
});

/* turn a provider on/off */
app.post("/api/providers/toggle", async (req, res) => {
  try {
    const P = await import("./providers.js");
    const { id, enabled } = req.body || {};
    const on = P.setEnabled(id, !!enabled);
    await P.init();
    await loadModels(true);
    console.log(`[provider] ${id} ${on ? "ENABLED" : "disabled"}`);
    res.json({ ok: true, id, enabled: on });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/* start the bundled Gemini bridge on demand, streaming progress */
app.post("/api/gemini/start", async (_req, res) => {
  const send = sse(res);
  try {
    const S = await import("./setup.js");
    const r = await S.startGemini((t) => send({ type: "data", text: t }));
    if (r.ok) {
      const P = await import("./providers.js");
      await P.init();
      await loadModels(true);
    }
    send({ type: "done", ...r });
  } catch (e) { send({ type: "done", ok: false, error: e.message }); }
  finally { res.end(); }
});
app.get("/api/gemini/status", async (_req, res) => {
  const S = await import("./setup.js");
  res.json({ up: await S.geminiUp(), python: await S.findPython() });
});
app.post("/api/providers/detect", async (_req, res) => {
  const P = await import("./providers.js");
  const found = await P.detectLocal();
  if (found.length) { await P.init(); CACHE_BUST(); }
  res.json({ found });
});
app.post("/api/providers/add", async (req, res) => {
  try {
    const P = await import("./providers.js");
    const r = await P.add(req.body);
    CACHE_BUST();
    console.log(`[provider] ${req.body.id} added (reachable=${r.reachable})`);
    res.json(r);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

/* ---- hosting: what can a built site be published to? ---- */
app.get("/api/publish", async (_req, res) => {
  res.json({
    backends: PUB.backends(),
    ready: PUB.ready(),
    autoPublish: String(process.env.NEXUS_AUTO_PUBLISH ?? "true") !== "false",
    primary: PUB.primary()?.id || null,
  });
});

/* ---- artifact download ---- */
app.get("/api/download", (req, res) => {
  try {
    const p = resolvePath(String(req.query.path || ""));
    res.download(p);
  } catch (e) { res.status(400).send(e.message); }
});

/* ---- android ---- */
app.get("/api/android/status", async (_req, res) => {
  const A = await import("./android.js");
  res.json(await A.status());
});
app.post("/api/android/setup", async (_req, res) => {
  const send = sse(res);
  try {
    const A = await import("./android.js");
    const r = await A.installSdk((t) => send({ type: "data", text: t }));
    send({ type: "done", ...r });
  } catch (e) { send({ type: "done", ok: false, error: e.message }); }
  finally { res.end(); }
});

/* ---- memory ---- */
app.get("/api/memory", async (req, res) => {
  res.json({ facts: await MEM.recall(req.query.q || "", 200), stats: await MEM.stats(),
             sessions: await MEM.recentSessions(15), notes: await MEM.projectNotes() });
});
app.post("/api/memory", async (req, res) => res.json({ ok: await MEM.remember(req.body) }));
app.delete("/api/memory/:id", async (req, res) => res.json({ ok: await MEM.forget(req.params.id) }));

/* ---- mcp ---- */
app.get("/api/mcp", async (_req, res) => res.json({ servers: MCP.status(), config: await MCP.loadConfig() }));
app.post("/api/mcp/reload", async (_req, res) => {
  MCP.disconnectAll();
  const r = await MCP.connectAll((t) => console.log("[mcp] " + t.trim()));
  res.json({ servers: r });
});

/* ---- hooks + checkpoints ---- */
app.get("/api/hooks", async (_req, res) => res.json(await HOOK.loadHooks()));
app.post("/api/hooks", async (req, res) => { await HOOK.saveHooks(req.body); res.json({ ok: true }); });
app.get("/api/checkpoints", async (_req, res) => res.json(await HOOK.listCheckpoints(60)));
app.post("/api/checkpoints/:id/restore", async (req, res) => {
  try { res.json({ ok: await HOOK.restore(req.params.id) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

/* ---- workspace / filesystem ---- */
const IMPL = makeImpl({ send: () => {}, freeOnly: true });
app.get("/api/ws/tree", async (req, res) => {
  try { res.json({ tree: await IMPL.list_files({ dir: req.query.dir || ".", depth: 4 }) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.get("/api/ws/file", async (req, res) => {
  try { res.json({ content: await IMPL.read_file({ path: req.query.path }) }); }
  catch (e) { res.status(404).json({ error: e.message }); }
});
app.post("/api/ws/file", async (req, res) => {
  try { res.json({ ok: await IMPL.write_file(req.body) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post("/api/ws/reset", async (_req, res) => {
  killAll();
  await fsp.rm(ROOT, { recursive: true, force: true });
  await fsp.mkdir(ROOT, { recursive: true });
  invalidateCache();                     // otherwise /api/ws/tree + read_file serve the deleted files
  res.json({ ok: true });
});

/* ---- interactive terminal (streams live) ---- */
app.post("/api/term", async (req, res) => {
  const send = sse(res);
  const controller = new AbortController();
  res.on("close", () => controller.abort());
  const { command, cwd } = req.body || {};
  try {
    const dir = cwd ? resolvePath(cwd) : ROOT;
    send({ type: "open", cmd: command, cwd: dir });
    const r = await runStream(command, { cwd: dir, timeout: 300, onData: ({ stream, text }) => send({ type: "data", stream, text }) });
    send({ type: "close", code: r.code, timedOut: r.timedOut });
  } catch (e) { send({ type: "data", stream: "stderr", text: e.message }); send({ type: "close", code: 1 }); }
  finally { res.end(); }
});

/* ---- system / setup ---- */
app.get("/api/system", async (_req, res) => {
  res.json({ ...sysInfo(ROOT), appDir: APP_DIR, toolchain: await detectToolchain(), fullAccess: isFull() });
});
app.post("/api/setup/browser", async (_req, res) => {
  const send = sse(res);
  try { const r = await ensureBrowser((t) => send({ type: "data", text: t })); send({ type: "done", ...r }); }
  catch (e) { send({ type: "done", ok: false, error: e.message }); }
  finally { res.end(); }
});
app.post("/api/fullaccess", (req, res) => {
  const on = setFullAccess(!!req.body?.enabled);
  console.log(`  [full-PC access ${on ? "ENABLED" : "disabled"}]`);
  res.json({ fullAccess: on });
});
app.get("/api/procs", (_req, res) => {
  res.json([...PROCS.values()].map((p) => ({ id: p.id, pid: p.pid, cmd: p.cmd, exited: !!p.exited, code: p.code })));
});
app.post("/api/procs/kill", (req, res) => { res.json({ stopped: killAll() }); });

const BASE_PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || "0.0.0.0";
let PORT = BASE_PORT;
let attempts = 0;

function listen() {
  const srv = app.listen(PORT, HOST, async () => {
    if (srv.address()?.port && srv.address().port !== PORT) PORT = srv.address().port;
    const s = sysInfo(ROOT);
    const url = `http://localhost:${PORT}`;
    const line = "═".repeat(56);
    console.log("\n" + line);
    if (PORT !== BASE_PORT) {
      console.log(`  ⚠  Port ${BASE_PORT} was busy — moved to ${PORT}`);
      console.log(`  ⚠  OPEN THIS URL INSTEAD:`);
    } else {
      console.log(`  NEXUS is running. Open:`);
    }
    console.log(`\n      ${url}\n`);
    console.log(line);
    console.log(`  platform: ${s.platform} · shell: ${s.shell}`);
    console.log(`  workspace: ${ROOT}`);
    console.log(`  full-PC access: ${isFull() ? "ENABLED (JARVIS mode)" : "off (workspace only)"}\n`);
    const k = (process.env.XKIRO_API_KEY || "").trim();
    console.log(`  api key: ${k ? k.slice(0, 8) + "…" + k.slice(-4) : "MISSING"}`);
    try {
      const list = await loadModels(true);
      console.log(`  models: ${list.length} available (${list.filter((m) => m.tier === "free").length} free)`);
      // free Gemini supervisor LLM — auto-start unless disabled
      if (String(process.env.NEXUS_GEMINI ?? "true").toLowerCase() !== "false") {
        try {
          const g = await (await import("./setup.js")).startGemini((t) => process.stdout.write("  [gemini] " + t));
          if (g.ok) {
            console.log(`  gemini bridge: ${g.already ? "already running" : "started"} on :8081  (free Gemini models)`);
          } else {
            const S2 = await import("./setup.js");
            const py = await S2.findPython();
            console.log("\n  ⚠  Gemini bridge did not start: " + g.error);
            if (!py) {
              console.log("     Cause: Python 3 was not found on PATH.");
              console.log("     Fix:   install from https://python.org and TICK 'Add python.exe to PATH',");
              console.log("            then restart NEXUS. Or click 'start it' in the model menu.");
            } else {
              console.log(`     Python found (${py}) — open the model menu and click 'start it' to retry and see the log.`);
            }
            console.log("     Everything else works without it.\n");
          }
          if (g.ok) { const P = await import("./providers.js"); await P.init(); await loadModels(true); }
        } catch (e) { console.log("  gemini bridge: " + e.message); }
      }
      await MCP.ensureConfig(); await HOOK.ensureHooks();
      const mc = await MCP.connectAll((t) => console.log("  [mcp] " + t.trim()));
      const okc = mc.filter((m) => m.ok).length;
      if (mc.length) console.log(`  mcp: ${okc}/${mc.length} servers connected`);
      if (String(process.env.NEXUS_OPEN ?? "true").toLowerCase() !== "false") {
        const opener = process.platform === "win32" ? `start "" "${url}"`
          : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
        runStream(opener, { timeout: 10 }).catch(() => {});
      }
      const ms = await MEM.stats();
      console.log(`  memory: ${ms.facts} facts, ${ms.sessions} sessions${ms.hasNotes ? ", NEXUS.md loaded" : ""}`);
      console.log(`\n  →  ${url}\n`);
      try { await fsp.writeFile(path.join(__dirname, ".port"), String(PORT), "utf8"); } catch {}
    } catch (e) {
      console.error(`  MODELS FAILED TO LOAD: ${e?.message || e}`);
      console.error(`  The UI will show an error banner with details.\n`);
    }
  });

  srv.on("error", (e) => {
    if (e.code === "EADDRINUSE" && attempts < 20) {
      attempts++; PORT++;
      setTimeout(listen, 100);     // stay quiet; the real banner prints once bound
      return;
    }
    if (e.code === "EADDRINUSE") {
      console.error(`\n  Could not find a free port between ${BASE_PORT} and ${PORT}.\n`);
      process.exit(2);
    }
    console.error("server error: " + e.message);
    process.exit(2);
  });
}
listen();

process.on("SIGINT", async () => { killAll(); MCP.disconnectAll();
  try { (await import("./setup.js")).stopGemini(); } catch {} process.exit(0); });
process.on("SIGTERM", () => { killAll(); MCP.disconnectAll(); process.exit(0); });
