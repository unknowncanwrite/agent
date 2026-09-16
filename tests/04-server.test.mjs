/* 04 — the real HTTP server: boots server.js in a sandbox against a mock upstream
   and drives the actual endpoints (SSE chat, the autonomous agent loop, jobs,
   terminals, upload, workspace, memory, discovery endpoints). */
import path from "node:path";
import fsp from "node:fs/promises";
import fs from "node:fs";
import { suite, test, ok, eq, has, hasNot, truthy, summary, expectDefect, makeSandbox, startMock, startServer, get, post, sse, evs, sleep } from "./lib.mjs";

suite("04 server");

const mock = await startMock();
const setMode = async (mode, extra = {}) =>
  (await fetch(mock.url.replace(/\/v1$/, "") + "/__ctl", { method: "POST", body: JSON.stringify({ mode, ...extra }) })).json();

const dir = await makeSandbox({ name: "nexus-server", providersOff: [] });
const S = await startServer(dir, { upstream: mock.url, fullAccess: false });
const WS = path.join(dir, "workspace");

try {
  /* ---------------- static + discovery ---------------- */
  await test("GET / serves the UI", async () => {
    const r = await get(S.base, "/");
    eq(r.status, 200);
    has(r.text, "app.js");
    eq((await get(S.base, "/app.js")).status, 200);
    eq((await get(S.base, "/style.css")).status, 200);
  });

  await test("/api/health reports a working upstream", async () => {
    const r = await get(S.base, "/api/health");
    eq(r.status, 200);
    eq(r.json.key, true, "the key from .env was not picked up");
    eq(r.json.upstream, true, "upstream was not reachable: " + r.json.error);
    ok(r.json.models >= 5, "only " + r.json.models + " models listed");
  });

  await test("/api/models lists free models first", async () => {
    const r = await get(S.base, "/api/models");
    eq(r.status, 200);
    ok(Array.isArray(r.json) && r.json.length >= 5, "models payload is wrong");
    const tiers = r.json.map((m) => m.tier);
    const firstPaid = tiers.indexOf("paid");
    const lastFree = tiers.lastIndexOf("free");
    ok(firstPaid === -1 || lastFree < firstPaid, "paid models are ranked above free ones: " + tiers.join(","));
  });

  await test("/api/system describes the host and the access mode", async () => {
    const r = await get(S.base, "/api/system");
    eq(r.status, 200);
    eq(r.json.fullAccess, false);
    ok(r.json.platform, "no platform reported");
    has(JSON.stringify(r.json), "workspace", "the workspace root is not reported");
  });

  /* ---------------- plain chat ---------------- */
  await test("POST /api/chat streams deltas and a done event", async () => {
    await setMode("text");
    const { events } = await sse(S.base, "/api/chat", { messages: [{ role: "user", content: "hello" }] },
      { until: (e) => e.type === "done" || e.type === "error", timeout: 30000 });
    const text = evs(events, "delta").map((e) => e.text).join("");
    has(text, "mock upstream");
    ok(evs(events, "done").length, "no done event: " + JSON.stringify(events).slice(0, 300));
    eq(evs(events, "error").length, 0, "chat errored: " + JSON.stringify(evs(events, "error")));
  });

  await test("POST /api/title returns a short title", async () => {
    await setMode("text");
    const r = await post(S.base, "/api/title", { text: "create a todo app" });
    eq(r.status, 200);
    ok(r.json.title && r.json.title.length <= 60, "bad title: " + JSON.stringify(r.json));
  });

  await test("POST /api/smart routes a question to chat and streams the answer", async () => {
    await setMode("text");
    const { events } = await sse(S.base, "/api/smart",
      { messages: [{ role: "user", content: "hello there" }], chatId: "smart-chat" },
      { until: (e) => e.type === "job_end" || e.type === "error", timeout: 30000 });
    const route = evs(events, "route")[0];
    ok(route, "no route event: " + JSON.stringify(events).slice(0, 200));
    eq(route.route, "chat", "the router sent a greeting to the agent");
    has(evs(events, "delta").map((e) => e.text).join(""), "mock upstream");
    eq(evs(events, "job_end").at(-1)?.status, "done");
  });

  /* ---------------- the autonomous loop ---------------- */
  await test("the agent loop writes a file, runs it and finishes (full round trip)", async () => {
    await setMode("agent");
    const { events } = await sse(S.base, "/api/smart",
      { messages: [{ role: "user", content: "create hello.py and run it" }], chatId: "agent-e2e", forceAgent: true },
      { until: (e) => e.type === "job_end" || e.type === "error", timeout: 60000 });

    const starts = evs(events, "tool_start").map((e) => e.name);
    ok(starts.includes("write_file"), "write_file was never called: " + starts.join(","));
    ok(starts.includes("run_command"), "run_command was never called: " + starts.join(","));
    ok(evs(events, "tool_end").length >= 2, "no tool_end events");
    ok(evs(events, "term_open").length >= 1, "the terminal was never opened");
    has(evs(events, "term_data").map((e) => e.text).join(""), "hi from nexus", "the script output never reached the UI");
    eq(evs(events, "error").length, 0, "the run errored: " + JSON.stringify(evs(events, "error")));
    eq(evs(events, "job_end").at(-1)?.status, "done");

    has(await fsp.readFile(path.join(WS, "hello.py"), "utf8"), "hi from nexus");
  });

  await test("read-only tools in one step are batched in parallel", async () => {
    await fsp.writeFile(path.join(WS, "a.txt"), "AAA", "utf8");
    await fsp.writeFile(path.join(WS, "b.txt"), "BBB", "utf8");
    await fsp.writeFile(path.join(WS, "c.txt"), "CCC", "utf8");
    await setMode("agent-parallel");
    const { events } = await sse(S.base, "/api/smart",
      { messages: [{ role: "user", content: "read a.txt, b.txt and c.txt" }], chatId: "batch", forceAgent: true },
      { until: (e) => e.type === "job_end" || e.type === "error", timeout: 45000 });
    const batch = evs(events, "batch")[0];
    ok(batch, "no batch event: " + JSON.stringify(events.map((e) => e.type)));
    eq(batch.n, 3, "batch size");
    eq(evs(events, "tool_end").length, 3, "not all three reads completed");
  });

  await test("an unknown tool is reported as a failure, not a crash", async () => {
    await setMode("agent-unknown-tool");
    const { events } = await sse(S.base, "/api/smart",
      { messages: [{ role: "user", content: "do the magic thing" }], chatId: "unknown-tool", forceAgent: true },
      { until: (e) => e.type === "job_end" || e.type === "error", timeout: 30000 });
    const end = evs(events, "tool_end")[0];
    ok(end, "no tool_end for the unknown tool");
    eq(end.failed, true, "the unknown tool was not marked failed");
    has(end.result, "no tool called", "the model is not told the tool does not exist: " + end.result.slice(0, 200));
    eq(evs(events, "error").length, 0);
  });

  await test("ask_user pauses the run and marks it awaiting", async () => {
    await setMode("agent-ask");
    const { events } = await sse(S.base, "/api/smart",
      { messages: [{ role: "user", content: "colour the thing" }], chatId: "ask", forceAgent: true },
      { until: (e) => e.type === "job_end" || e.type === "error", timeout: 30000 });
    const ask = evs(events, "ask")[0];
    ok(ask, "no ask event: " + JSON.stringify(events.map((e) => e.type)));
    has(ask.question, "Which colour");
    eq(evs(events, "done").at(-1)?.awaiting, true, "done.awaiting was not set");
  });

  await test("the supervisor blocks finishing without verification", async () => {
    await setMode("agent-slow-verify");
    const { events } = await sse(S.base, "/api/smart",
      { messages: [{ role: "user", content: "create unverified.txt" }], chatId: "gate", forceAgent: true },
      { until: (e) => e.type === "job_end" || e.type === "error", timeout: 60000 });
    const critics = evs(events, "critic");
    ok(critics.some((c) => c.kind === "unverified" || c.kind === "gate"),
      "the unverified-completion gate never fired: " + JSON.stringify(critics));
    eq(evs(events, "job_end").at(-1)?.status, "done");
  });

  await test("a model that only describes the work is corrected and retried", async () => {
    await setMode("agent-prose");
    const { events } = await sse(S.base, "/api/smart",
      { messages: [{ role: "user", content: "create a file called prose.txt" }], chatId: "prose", forceAgent: true, maxSteps: 4 },
      { until: (e) => e.type === "job_end" || e.type === "error", timeout: 45000 });
    const critics = evs(events, "critic");
    ok(critics.some((c) => c.kind === "no_tool_call" || c.kind === "nothing_done"),
      "the prose nudge never fired: " + JSON.stringify(critics));
    ok(evs(events, "model_switch").length >= 1, "no model switch after the nudge");
  });

  await test("maxSteps is enforced against a looping model", async () => {
    await setMode("agent-loop");
    const { events } = await sse(S.base, "/api/smart",
      { messages: [{ role: "user", content: "loop forever" }], chatId: "loop", forceAgent: true, maxSteps: 3 },
      { until: (e) => e.type === "job_end" || e.type === "error", timeout: 45000 });
    const done = [...evs(events, "done"), ...evs(events, "agent_stopped")];
    ok(done.length, "the loop never ended: " + JSON.stringify(events.map((e) => e.type)));
    ok(evs(events, "tool_start").length <= 4, "maxSteps was not enforced (" + evs(events, "tool_start").length + " tool calls)");
  });

  /* ---------------- jobs ---------------- */
  await test("GET /api/jobs summarises the finished runs", async () => {
    const r = await get(S.base, "/api/jobs");
    eq(r.status, 200);
    const job = r.json.find((j) => j.chatId === "agent-e2e");
    ok(job, "the finished job is not listed: " + JSON.stringify(r.json.map((j) => j.chatId)));
    eq(job.status, "done");
    ok(job.tools >= 2, "tool count not tracked: " + job.tools);
  });

  await test("a finished job can be replayed from the beginning", async () => {
    const { events } = await sse(S.base, "/api/jobs/agent-e2e/stream?since=-1", undefined,
      { until: (e) => e.type === "job_end", timeout: 20000 });
    ok(events.length > 3, "the replay was empty");
    ok(evs(events, "job_end").length >= 1, "no job_end in the replay");
    ok(events.some((e) => e.type === "tool_start"), "the replayed events lost the tool calls");
  });

  await test("replaying a finished job does not crash the server", async () => {
    const before = S.output.length;
    await get(S.base, "/api/jobs/agent-e2e/stream?since=-1", { timeout: 10000 }).catch(() => {});
    await sleep(600);
    const fresh = S.output.slice(before);
    await expectDefect(
      "uncaught ERR_STREAM_WRITE_AFTER_END from an SSE endpoint",
      () => /ERR_STREAM_WRITE_AFTER_END|UNCAUGHT/.test(fresh),
      "GET /api/jobs/:chatId/stream on a FINISHED job writes again after res.end(): attach() replays the\n" +
      "buffered events (the last one is job_end, which ends the response) and then, because the job is no\n" +
      "longer running, calls the listener a second time with another job_end. The write-after-end error is\n" +
      "emitted asynchronously so the surrounding try/catch cannot catch it and it reaches the process-level\n" +
      "uncaughtException handler — i.e. every reconnect to a just-finished task relies on a global handler\n" +
      "to keep the server alive.\nStack: server.js sse() write ← attach listener ← jobs.js attach()",
      "medium");
  });

  await test("a second task on the same chat is refused while one is running", async () => {
    await setMode("agent-slow-verify", { delayMs: 1200 });
    const first = sse(S.base, "/api/smart",
      { messages: [{ role: "user", content: "long running task" }], chatId: "dup", forceAgent: true, maxSteps: 20 },
      { until: (e) => e.type === "job_end", timeout: 60000 });
    await sleep(800);
    const second = await post(S.base, "/api/smart",
      { messages: [{ role: "user", content: "another task" }], chatId: "dup", forceAgent: true });
    has(second.text, "already has a task running", "the duplicate run was not refused: " + second.text.slice(0, 300));
    eq((await get(S.base, "/api/jobs")).json.find((j) => j.chatId === "dup").status, "running");
    const a = await first;
    eq(evs(a.events, "job_end").at(-1)?.status, "done");
    await setMode("agent-slow-verify", { delayMs: 0 });
  });

  await test("a running job can be stopped", async () => {
    await setMode("agent-slow-verify", { delayMs: 1500 });
    const running = sse(S.base, "/api/smart",
      { messages: [{ role: "user", content: "please stop me" }], chatId: "stoppy", forceAgent: true, maxSteps: 20 },
      { until: (e) => e.type === "job_end", timeout: 60000 });
    await sleep(900);
    const stop = await post(S.base, "/api/jobs/stoppy/stop", {});
    eq(stop.json.stopped, true, "stop() reported nothing running");
    const a = await running;
    const end = evs(a.events, "job_end").at(-1);
    eq(end.status, "stopped", "job_end status after a stop: " + JSON.stringify(end));
    await setMode("agent-slow-verify", { delayMs: 0 });
  });

  /* ---------------- terminal / upload / workspace ---------------- */
  await test("POST /api/term streams command output", async () => {
    const { events } = await sse(S.base, "/api/term", { command: "echo term-works && pwd" },
      { until: (e) => e.type === "close", timeout: 20000 });
    has(evs(events, "data").map((e) => e.text).join(""), "term-works");
    eq(evs(events, "close").at(-1)?.code, 0);
  });

  await test("POST /api/term refuses a destructive command", async () => {
    const { events } = await sse(S.base, "/api/term", { command: "rm -rf /" },
      { until: (e) => e.type === "close", timeout: 20000 });
    eq(evs(events, "close").at(-1)?.code, 126, "the shell guard did not fire");
    has(JSON.stringify(events), "BLOCKED");
  });

  await test("POST /api/upload stores the file in the workspace", async () => {
    const boundary = "----nexusTestBoundary";
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="note.txt"\r\nContent-Type: text/plain\r\n\r\n`),
      Buffer.from("uploaded-content-42"),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const r = await fetch(S.base + "/api/upload", { method: "POST", headers: { "content-type": `multipart/form-data; boundary=${boundary}` }, body });
    const j = await r.json();
    eq(r.status, 200, JSON.stringify(j));
    eq(j.name, "note.txt");
    eq(await fsp.readFile(path.join(WS, "uploads", "note.txt"), "utf8"), "uploaded-content-42");
  });

  await test("the workspace API writes, reads and lists files", async () => {
    eq((await post(S.base, "/api/ws/file", { path: "ws-demo.txt", content: "ws-content" })).status, 200);
    eq((await get(S.base, "/api/ws/file?path=ws-demo.txt")).json.content, "ws-content");
    has((await get(S.base, "/api/ws/tree?dir=.")).json.tree, "ws-demo.txt");
  });

  await test("the workspace API refuses to leave the workspace", async () => {
    const abs = await post(S.base, "/api/ws/file", { path: "/tmp/nexus-should-not-exist.txt", content: "nope" });
    eq(abs.status, 400, "an absolute path was accepted: " + abs.text.slice(0, 200));
    const trav = await post(S.base, "/api/ws/file", { path: "../../escape.txt", content: "nope" });
    eq(trav.status, 400, "a traversal path was accepted: " + trav.text.slice(0, 200));
    const read = await get(S.base, "/api/ws/file?path=/etc/passwd");
    eq(read.status, 404, "an absolute read was served: " + read.text.slice(0, 120));
    ok(!fs.existsSync("/tmp/nexus-should-not-exist.txt"), "the escape file was really written");
  });

  await test("POST /api/ws/reset empties the workspace", async () => {
    await post(S.base, "/api/ws/file", { path: "reset-me.txt", content: "x" });
    const r = await post(S.base, "/api/ws/reset", {});
    eq(r.status, 200);
    ok(!fs.existsSync(path.join(WS, "reset-me.txt")), "the file survived the reset");
  });

  await test("POST /api/ws/reset invalidates the file caches", async () => {
    await post(S.base, "/api/ws/file", { path: "stale.txt", content: "stale-content" });
    await get(S.base, "/api/ws/tree?dir=.");                 // prime the tree cache
    eq((await get(S.base, "/api/ws/file?path=stale.txt")).json.content, "stale-content"); // prime the read cache
    await post(S.base, "/api/ws/reset", {});
    const tree = await get(S.base, "/api/ws/tree?dir=.");
    const file = await get(S.base, "/api/ws/file?path=stale.txt");
    await expectDefect(
      "workspace reset leaves stale caches",
      () => tree.text.includes("stale.txt") || file.status === 200,
      "POST /api/ws/reset deletes every file but never calls invalidateCache(), so the module-level\n" +
      "TTLCaches in agent.js keep answering for the deleted tree (8s) and deleted files (~15s):\n" +
      `  • /api/ws/tree still lists "stale.txt": ${tree.text.includes("stale.txt")}\n` +
      `  • /api/ws/file?path=stale.txt still returns content: ${file.status === 200}\n` +
      "The same caches feed the agent's own list_files/read_file tools, so an agent asked to rebuild the\n" +
      "workspace right after a reset reads files that no longer exist.",
      "low");
  });

  /* ---------------- memory / settings / misc ---------------- */
  await test("memory facts persist through the API", async () => {
    const w = await post(S.base, "/api/memory", { text: "the deployment lives on render", kind: "fact" });
    eq(w.status, 200);
    const r = await get(S.base, "/api/memory");
    eq(r.status, 200);
    ok(r.json.facts.some((f) => /render/i.test(f.text)), "the fact was not stored: " + JSON.stringify(r.json.facts).slice(0, 200));
    ok(r.json.stats, "no stats in the payload");
  });

  await test("POST /api/fullaccess toggles full-PC access at runtime", async () => {
    const on = await post(S.base, "/api/fullaccess", { enabled: true });
    eq(on.json.fullAccess, true);
    eq((await get(S.base, "/api/system")).json.fullAccess, true);
    const off = await post(S.base, "/api/fullaccess", { enabled: false });
    eq(off.json.fullAccess, false);
  });

  await test("GET /api/logs replays the buffered server log", async () => {
    const { events } = await sse(S.base, "/api/logs", undefined, { until: (e) => e.type === "log", timeout: 8000 });
    ok(events.length >= 1, "no log lines replayed");
  });

  await test("the discovery endpoints all answer", async () => {
    for (const p of ["/api/providers", "/api/hooks", "/api/checkpoints", "/api/procs", "/api/mcp",
      "/api/os/status", "/api/android/status", "/api/gemini/status"]) {
      const r = await get(S.base, p, { timeout: 30000 });
      eq(r.status, 200, `${p} returned ${r.status}: ${r.text.slice(0, 120)}`);
      ok(r.json !== null, `${p} did not return JSON`);
    }
  });

  await test("POST /api/agent runs the loop directly too", async () => {
    await setMode("agent");
    const { events } = await sse(S.base, "/api/agent",
      { messages: [{ role: "user", content: "make a script and run it" }] },
      { until: (e) => e.type === "done" || e.type === "error", timeout: 60000 });
    ok(evs(events, "tool_start").some((e) => e.name === "write_file"), "no write in the direct agent run");
    has(evs(events, "term_data").map((e) => e.text).join(""), "hi from nexus", "the direct run never executed the file");
    eq(evs(events, "error").length, 0);
  });
} finally {
  await S.stop();
  await mock.close();
}

summary();
