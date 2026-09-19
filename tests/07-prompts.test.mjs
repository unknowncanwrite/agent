/* 07 — the 20-prompt pack.
   Twenty prompts a real user would type, sent through the REAL server pipeline
   (POST /api/smart → router → agent loop → tools → jobs → publish) with the scripted
   upstream. Every prompt asserts what the product must do with it, and the run is
   audited as a whole at the end (job accounting, no stray errors, no cross-talk,
   publishing only when a site was actually built). */
import path from "node:path";
import fsp from "node:fs/promises";
import { suite, test, ok, eq, has, hasNot, note, summary, makeSandbox, startMock, startServer, get, post, sse, evs, sleep } from "./lib.mjs";

suite("07 prompts (20-prompt pack)");

const mock = await startMock();
const MOCK = mock.url.replace(/\/v1$/, "");
const ctl = (o) => fetch(MOCK + "/__ctl", { method: "POST", body: JSON.stringify({ mode: "pack", ...o }) }).then((r) => r.json());
const deployments = () => fetch(MOCK + "/__deployments").then((r) => r.json());

const dir = await makeSandbox({ name: "nexus-prompts" });
const S = await startServer(dir, { upstream: mock.url, fullAccess: false,
  env: { VERCEL_TOKEN: "vc-pack-token", VERCEL_API_BASE: MOCK, NEXUS_BROWSER_INSTALL: "0" } });
const WS = path.join(dir, "workspace");
const W = (p) => path.join(WS, p);
const read = (p) => fsp.readFile(W(p), "utf8").then((t) => t, () => null);
const exists = (p) => fsp.access(W(p)).then(() => true, () => false);

/* files the file-prompts need before they run */
await fsp.mkdir(path.join(WS, "notes"), { recursive: true });
await fsp.writeFile(W("a.txt"), "one\ntwo\n", "utf8");
await fsp.writeFile(W("scratch.txt"), "throw me away\n", "utf8");
await fsp.writeFile(W("code.js"), "// TODO: add pagination\nexport const x = 1;\n", "utf8");

const RUNS = [];
let n = 0;
/** Send one prompt exactly like the UI does and record everything the run produced. */
async function ask(prompt, scenario, { route = "agent", timeout = 120000 } = {}) {
  const id = String(++n).padStart(2, "0");
  const chatId = `pack-${id}`;
  await ctl({ scenario, route, fetchUrl: `${MOCK}/demo` });
  const { events } = await sse(S.base, "/api/smart",
    { messages: [{ role: "user", content: prompt }], chatId, maxSteps: 16 },
    { until: (e) => e.type === "job_end" || e.type === "error", timeout });
  const end = evs(events, "job_end").at(-1);
  const run = {
    id, chatId, prompt, events, status: end?.status,
    route: evs(events, "route")[0]?.route,
    tools: evs(events, "tool_start").map((e) => e.name),
    ends: evs(events, "tool_end"),
    text: evs(events, "delta").map((e) => e.text).join(""),
    errors: evs(events, "error"),
    publishes: evs(events, "publish"),
    term: evs(events, "term_data").map((e) => e.text).join(""),
  };
  RUNS.push(run);
  return run;
}
const tool = (r, name) => r.ends.find((t) => t.name === name);
/** Every agent prompt must finish cleanly: one job_end, status done, no error events. */
function clean(r) {
  eq(evs(r.events, "error").length, 0, "the run produced an error event: " + JSON.stringify(r.errors));
  eq(evs(r.events, "job_end").length, 1, "expected exactly one job_end, got " + evs(r.events, "job_end").length);
  eq(r.status, "done", "job status was " + r.status);
}

/* ------------------------------------------------------------------ 20 prompts */

await test("1. “What's a good name for a coffee shop?” → chat, no tools", async () => {
  const r = await ask("What's a good name for a coffee shop?", "chat", { route: "chat" });
  clean(r);
  eq(r.route, "chat", "a question was sent to the agent");
  eq(r.tools.length, 0, "tools ran for a chat answer: " + r.tools.join(","));
  ok(r.text.length > 10, "the chat answer was empty");
});

await test("2. “Summarise what you can do for me in two sentences.” → chat", async () => {
  const r = await ask("Summarise what you can do for me in two sentences.", "chat", { route: "chat" });
  clean(r);
  eq(r.route, "chat", "a summary request was sent to the agent");
  eq(r.tools.length, 0, "tools ran for a chat answer");
});

await test("3. “Create notes/todo.md with three bullet points…” → file written", async () => {
  const r = await ask("Create notes/todo.md with three bullet points about launching a landing page.", "notes");
  clean(r);
  has(r.tools.join(","), "write_file", "write_file was not used");
  const body = await read("notes/todo.md");
  ok(body, "notes/todo.md was not created");
  eq((body.match(/^- \[ \]/gm) || []).length, 3, "expected three bullet points, got:\n" + body);
  eq(r.publishes.length, 0, "a note file triggered a publish");
});

await test("4. “Make a simple website for a bakery…” → built, verified and auto-published", async () => {
  const before = (await deployments()).length;
  const r = await ask("Make a simple website for a bakery and make sure the page works.", "website");
  clean(r);
  has(r.tools.join(","), "write_file");
  ok((await read("index.html"))?.includes("Riverside Bakery"), "index.html is missing or wrong");
  eq(tool(r, "run_command")?.failed, false, "the verification command failed");
  eq(evs(r.events, "publish_start")[0]?.auto, true, "auto-publish never started");
  const pub = r.publishes.at(-1);
  ok(pub, "no publish event: " + JSON.stringify(r.events.map((e) => e.type)));
  eq(pub.ok, true, "publish failed: " + pub.error);
  has(pub.url, "vercel.app", "the published URL looks wrong: " + pub.url);
  const deps = await deployments();
  eq(deps.length, before + 1, "the host did not receive exactly one deployment");
  ok(deps.at(-1).files.some((f) => f.file === "index.html"), "index.html was not uploaded");
});

await test("5. “…first 10 Fibonacci numbers, then run it” → script executed, output visible", async () => {
  const r = await ask("Write a Python script that prints the first 10 Fibonacci numbers, then run it and show me the output.", "fib");
  clean(r);
  has(r.tools.join(","), "run_command");
  eq(tool(r, "run_command")?.failed, false, "python exited non-zero: " + tool(r, "run_command")?.result);
  has(r.term, "34", "the script output never reached the terminal: " + r.term.slice(0, 200));
});

await test("6. “Save a CSV of three products and read it back to me.” → write + read", async () => {
  const r = await ask("Save a CSV of three products with prices and read it back to me.", "csv");
  clean(r);
  has(r.tools.join(","), "write_file");
  has(r.tools.join(","), "read_file");
  has(tool(r, "read_file")?.result || "", "coffee", "the CSV content was not returned to the model");
  has(await read("products.csv"), "bread", "products.csv is wrong");
});

await test("7. “Run the tests and tell me honestly whether they pass.” → failure reported, not hidden", async () => {
  const r = await ask("Run the project's test suite and tell me honestly whether it passes.", "tests-fail");
  clean(r);
  eq(tool(r, "run_command")?.failed, true, "a non-zero exit was not marked as failed");
  eq(r.tools.length, 1, "the agent kept going after a failing command");
  ok(/fail/i.test(r.text), "the answer hides the failure: " + JSON.stringify(r.text.slice(0, 200)));
});

await test("8. “What files are in my workspace right now?” → real listing", async () => {
  const r = await ask("What files are in my workspace right now?", "list");
  clean(r);
  has(r.tools.join(","), "list_files");
  has(tool(r, "list_files")?.result || "", "index.html", "the listing does not reflect the real workspace");
});

await test("9. “Append a line that says # reviewed to a.txt.” → file really changed", async () => {
  const r = await ask("Open a.txt and append a line that says # reviewed.", "append");
  clean(r);
  has(r.tools.join(","), "edit_file");
  eq(await read("a.txt"), "one\ntwo\n# reviewed\n", "a.txt does not have the appended line");
});

await test("10. “Delete the scratch file, I don't need it any more.” → file gone", async () => {
  const r = await ask("Delete the scratch file scratch.txt, I don't need it any more.", "delete");
  clean(r);
  has(r.tools.join(","), "delete_file");
  eq(await exists("scratch.txt"), false, "scratch.txt still exists");
});

await test("11. “Search the workspace for TODO comments.” → real matches", async () => {
  const r = await ask("Search the workspace for TODO comments and show me what you find.", "search");
  clean(r);
  has(r.tools.join(","), "search_code");
  has(tool(r, "search_code")?.result || "", "add pagination", "the search result lost the match");
});

await test("12. “Fetch that page and tell me what it says.” → page text without a browser", async () => {
  const r = await ask(`Fetch the page at ${MOCK}/demo and tell me what it says.`, "fetch");
  clean(r);
  has(r.tools.join(","), "fetch_url");
  const res = tool(r, "fetch_url")?.result || "";
  has(res, "MOCK PAGE TEXT", "the page content was not fetched: " + res.slice(0, 200));
  eq(tool(r, "fetch_url")?.failed, false, "fetch_url failed even though plain HTTP works");
});

await test("13. “Start a server on 4711, check it, then stop it.” → process lifecycle", async () => {
  const r = await ask("Start a small server on port 4711 that serves the workspace, check it responds, then stop it.", "server");
  clean(r);
  const t = r.tools.join(",");
  has(t, "start_server");
  has(t, "stop_server");
  eq(tool(r, "start_server")?.failed, false, "the server did not start: " + tool(r, "start_server")?.result);
  has(r.term, "200", "the HTTP probe never returned 200");
  const procs = (await get(S.base, "/api/procs")).json.filter((p) => !p.exited);
  eq(procs.length, 0, "a background process was left running: " + JSON.stringify(procs));
});

await test("14. “Remember that I prefer dark mode.” → stored and recalled", async () => {
  const r = await ask("Remember that I prefer dark-mode interfaces, and confirm what you remember.", "remember");
  clean(r);
  has(r.tools.join(","), "remember");
  has(r.tools.join(","), "recall");
  const mem = await get(S.base, "/api/memory");
  has(JSON.stringify(mem.json.facts), "dark", "the fact was not persisted");
});

await test("15. “How much disk space and memory is free?” → real machine numbers", async () => {
  const r = await ask("How much disk space and memory is free on this machine?", "stats");
  clean(r);
  has(r.tools.join(","), "system_stats");
  has(tool(r, "system_stats")?.result || "", "disk", "no disk figures in the result");
});

await test("16. “Ask me which database to use before you start.” → pauses the run", async () => {
  const r = await ask("Ask me which database to use before you start writing anything.", "ask");
  ok(evs(r.events, "ask").length, "the agent never asked");
  has(evs(r.events, "ask")[0].question, "database");
  eq(evs(r.events, "done").at(-1)?.awaiting, true, "the run was not marked as awaiting an answer");
});

await test("17. “Do two things in parallel: write README.md and LICENSE.” → sub-agents", async () => {
  const r = await ask("Do two independent jobs in parallel: write the file README.md and write the file LICENSE.", "parallel", { timeout: 180000 });
  clean(r);
  ok(evs(r.events, "subagents_start").length, "the parallel machinery never started: " + r.tools.join(","));
  eq(evs(r.events, "subagents_end").length, 1, "subagents_end missing");
  ok(await exists("README.md"), "README.md was not written by the sub-agent");
  ok(await exists("LICENSE"), "LICENSE was not written by the sub-agent");
});

await test("18. “Undo your last change to notes/todo.md.” → the file it created is removed", async () => {
  const r = await ask("I changed my mind — undo the last change you made to notes/todo.md.", "undo");
  clean(r);
  has(r.tools.join(","), "undo_last_change");
  hasNot(tool(r, "undo_last_change")?.result || "", "No checkpoint found", "undo claimed there was nothing to undo");
  eq(await exists("notes/todo.md"), false, "notes/todo.md should be gone after undoing its creation");
});

await test("19. “Show me the git status of the workspace.” → clear answer, no crash", async () => {
  const r = await ask("Show me git status for the workspace.", "gitstatus");
  clean(r);
  has(r.tools.join(","), "git_status");
  const res = tool(r, "git_status")?.result || "";
  ok(/not a git repository|branch:/i.test(res), "git_status answered with something unusable: " + res.slice(0, 200));
});

await test("20. “Build a small todo app with a test and make sure it passes.” → app + tests + publish", async () => {
  const r = await ask("Build me a small todo app (HTML + JS) with a test, and make sure the test passes.", "todoapp");
  clean(r);
  ok(await exists("index.html"), "index.html missing");
  ok(await exists("app.js"), "app.js missing");
  ok(await exists("test.js"), "test.js missing");
  const test = tool(r, "run_command");
  eq(test?.failed, false, "the test run failed: " + test?.result);
  has(test?.result || "", "2 tests passed", "the tests did not actually run");
  const pub = r.publishes.at(-1);
  ok(pub && pub.ok, "the finished site was not published");
});

await test("21. “Use parallel agents to build the site, then get it live.” → merged and auto-published", async () => {
  const before = (await deployments()).length;
  const r = await ask("Use parallel agents to build a small bakery site in the site/ folder — one writes the page, one writes the stylesheet — then get it live.", "parallel-site", { timeout: 180000 });
  clean(r);
  ok(evs(r.events, "subagents_start").length, "no sub-agents were used: " + r.tools.join(","));
  ok(await exists("site/index.html"), "the sub-agent's page never reached the workspace");
  ok(await exists("site/styles.css"), "the sub-agent's stylesheet never reached the workspace");
  const pub = r.publishes.at(-1);
  ok(pub, "a site built by parallel agents was never published");
  eq(pub.ok, true, "publish failed: " + pub.error);
  const deps = await deployments();
  eq(deps.length, before + 1, "the host did not receive the merged site");
  ok(deps.at(-1).files.some((f) => f.file === "index.html"), "index.html was not uploaded");
});

/* ------------------------------------------------------- the pack as a whole */

await test("all 20 runs are tracked as finished jobs with the right accounting", async () => {
  const jobs = (await get(S.base, "/api/jobs")).json;
  eq(jobs.filter((j) => /^pack-(0[1-9]|1[0-9]|20)$/.test(j.chatId)).length, 20, "expected the 20 prompt jobs");
  const bad = jobs.filter((j) => j.status !== "done");
  eq(bad.length, 0, "jobs not finished: " + JSON.stringify(bad.map((j) => [j.chatId, j.status])));
  for (const r of RUNS) {
    const job = jobs.find((j) => j.chatId === r.chatId);
    ok(job, `job ${r.chatId} is missing from /api/jobs`);
    eq(job.tools, r.tools.length, `${r.chatId}: tool counter ${job.tools} ≠ ${r.tools.length}`);
    if (r.tools.length) eq(job.lastTool, r.tools.at(-1), `${r.chatId}: lastTool is wrong`);
    ok(job.events >= r.events.length - 1, `${r.chatId}: only ${job.events} job events buffered`);
  }
  const pack = jobs.filter((j) => /^pack-(0[1-9]|1[0-9]|20)$/.test(j.chatId));
  eq(pack.filter((j) => j.tools > 0).length, 18, "18 of the 20 prompts should have used tools (the two questions stay chat)");
});

await test("exactly the two site prompts published — nothing else did", async () => {
  const pubs = RUNS.flatMap((r) => r.publishes.map((p) => ({ id: r.id, ...p })));
  eq(pubs.length, 3, "publishes: " + JSON.stringify(pubs.map((p) => [p.id, p.ok, p.url])));
  eq(pubs.every((p) => ["04", "20", "21"].includes(p.id)), true, "an unexpected prompt published: " + JSON.stringify(pubs.map((p) => p.id)));
  eq(pubs.every((p) => p.ok && p.auto), true, "an auto-publish failed: " + JSON.stringify(pubs));
});

await test("no uncaught errors or stream misuse anywhere in the 20 runs", async () => {
  const log = S.output;
  hasNot(log, "UNCAUGHT", "the server hit an uncaught exception");
  hasNot(log, "UNHANDLED REJECTION", "the server hit an unhandled rejection");
  hasNot(log, "ERR_STREAM_WRITE_AFTER_END", "an SSE endpoint wrote after end()");
  hasNot(log, "MaxListenersExceededWarning", "listeners are leaking");
});

await test("a finished run replays event-for-event from the beginning", async () => {
  const live = RUNS.find((r) => r.tools.length >= 2);
  const { events } = await sse(S.base, `/api/jobs/${live.chatId}/stream?since=-1`, undefined,
    { until: (e) => e.type === "job_end", timeout: 20000 });
  eq(evs(events, "job_end").length, 1, "the replay contains the wrong number of job_end events");
  const liveTypes = live.events.map((e) => e.type).filter((t) => t !== "ping");
  const replayTypes = events.map((e) => e.type);
  const missing = ["route", "step", "tool_start", "tool_end", "done"].filter((t) => !replayTypes.includes(t));
  eq(missing.length, 0, "the replay lost: " + missing.join(",") + " (live had: " + liveTypes.slice(0, 14).join(",") + ")");
  eq(replayTypes.at(-1), "job_end", "the replay did not end with job_end");
});

await test("a rejected publish is reported to the user, not swallowed", async () => {
  await ctl({ scenario: "website", route: "agent", failDeploy: true });
  const { events } = await sse(S.base, "/api/smart",
    { messages: [{ role: "user", content: "Make a tiny site for a bike shop and publish it." }], chatId: "pack-pubfail", maxSteps: 8 },
    { until: (e) => e.type === "job_end" || e.type === "error", timeout: 90000 });
  await ctl({ failDeploy: false });
  const pub = evs(events, "publish").at(-1);
  ok(pub, "no publish event at all: " + JSON.stringify(events.map((e) => e.type)));
  eq(pub.ok, false, "a 403 from the host was reported as a success");
  ok(/invalid token|forbidden|403/i.test(String(pub.error)), "the publish error lost the host's message: " + pub.error);
  eq(evs(events, "job_end").at(-1)?.status, "done", "the run did not finish cleanly");
  const told = evs(events, "publish_log").map((e) => e.text).join(" ");
  has(told, "invalid token", "the host's error was not streamed into the publish log");
});

await test("three chats at once stay isolated and all finish", async () => {
  await ctl({ scenario: "list", route: "agent" });
  const ids = ["par-a", "par-b", "par-c"];
  const all = await Promise.all(ids.map((chatId) => sse(S.base, "/api/smart",
    { messages: [{ role: "user", content: "What files are in my workspace right now?", chatId }], chatId, maxSteps: 4 },
    { until: (e) => e.type === "job_end" || e.type === "error", timeout: 90000 })));
  all.forEach((res, i) => {
    const events = res.events;
    eq(evs(events, "job_end").at(-1)?.status, "done", ids[i] + " did not finish");
    eq(evs(events, "error").length, 0, ids[i] + " errored");
    eq(evs(events, "tool_start").length, 1, ids[i] + " ran " + evs(events, "tool_start").length + " tools — events leaked between chats");
  });
});

summary();
