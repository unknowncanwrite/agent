/* 08 — the gstack skill pack, ported from github.com/garrytan/gstack (MIT).
   Checks the pack itself (front matter, triggers, no Claude-Code-only instructions), the
   plumbing (catalogue, trigger matching, /api/skills, use_skill) and the real behaviour:
   a slash command loads the playbook into the run and the agent loop executes it. */
import { suite, test, ok, eq, has, hasNot, note, summary, makeSandbox, startMock, startServer, get, post, sse, evs } from "./lib.mjs";

suite("08 gstack pack");

const mock = await startMock();
const MOCK = mock.url.replace(/\/v1$/, "");
const setMode = async (mode, extra = {}) =>
  (await fetch(MOCK + "/__ctl", { method: "POST", body: JSON.stringify({ mode, ...extra }) })).json();
const upstreamRequests = () => fetch(MOCK + "/__requests").then((r) => r.json());

const dir = await makeSandbox({ name: "nexus-gstack" });
const S = await startServer(dir, { upstream: mock.url, env: { NEXUS_BROWSER_INSTALL: "0" } });

const SPRINT = ["gstack-office-hours", "gstack-plan-ceo-review", "gstack-plan-eng-review", "gstack-review",
  "gstack-investigate", "gstack-qa", "gstack-cso", "gstack-ship", "gstack-land-and-deploy", "gstack-canary",
  "gstack-benchmark", "gstack-retro", "gstack-learn", "gstack-browse", "gstack-scrape", "gstack-spec",
  "gstack-autoplan", "gstack-design-consultation", "gstack-design-shotgun", "gstack-design-html",
  "gstack-design-review", "gstack-plan-design-review", "gstack-plan-devex-review",
  "gstack-document-release", "gstack-document-generate", "gstack-make-pdf", "gstack-diagram",
  "gstack-qa-only"];

/* ---------------------------------------------------------------- the pack */

await test("every gstack skill loads with clean front matter", async () => {
  const r = await get(S.base, "/api/skills?full=1");
  eq(r.status, 200);
  const g = r.json.filter((s) => s.name.startsWith("gstack"));
  eq(g.length, 29, "expected the hub + 28 stage skills, saw " + g.length);
  for (const s of g) {
    ok(s.description && s.description.length > 20, `${s.name}: description too short`);
    ok(s.triggers.length >= 3, `${s.name}: needs at least 3 triggers, has ${s.triggers.length}`);
    has(s.body, "# ", `${s.name}: body has no heading`);
    ok(s.bytes > 700, `${s.name}: body is suspiciously small (${s.bytes}b)`);
  }
  const names = g.map((s) => s.name);
  eq(new Set(names).size, names.length, "duplicate skill names in the pack");
});

await test("the hub names a stage and the stage exists", async () => {
  const r = await get(S.base, "/api/skills?full=1");
  const names = new Set(r.json.map((s) => s.name));
  const hub = r.json.find((s) => s.name === "gstack");
  const referenced = [...hub.body.matchAll(/`\/(gstack-[a-z0-9-]+)`/g)].map((m) => m[1]);
  ok(referenced.length >= 20, "the hub references only " + referenced.length + " stages");
  const dead = [...new Set(referenced)].filter((n) => !names.has(n));
  eq(dead.length, 0, "the hub points at skills that do not exist: " + dead.join(", "));
  for (const stage of SPRINT) ok(names.has(stage), `missing stage skill ${stage}`);
  has(hub.body, "reuse ladder", "the hub lost the reuse ladder");
  has(hub.body, "Boil the Ocean", "the hub lost the ethos");
});

await test("the pack speaks NEXUS, not Claude Code", async () => {
  const r = await get(S.base, "/api/skills?full=1");
  const g = r.json.filter((s) => s.name.startsWith("gstack"));
  const forbidden = [/AskUserQuestion/, /ExitPlanMode/, /~\/\.claude\/skills/, /gstack-skill-start/, /allowed-tools:/, /skill_start/];
  for (const s of g) {
    for (const re of forbidden) hasNot(s.body, re.source.replace(/\\/g, ""), `${s.name} still references ${re}`);
  }
  // and it does use NEXUS tool names
  const TOOLS = /use_skill|run_command|spawn_subagents|browser_interact|screenshot|git_commit|create_document|create_skill|ask_user|review_code|think_parallel|write_file|read_file|search_code|list_files|start_server|stop_server|remember|recall|forget|fetch_url|web_search|git_diff|publish_website|update_plan|list_skills/;
  const without = g.filter((s) => !TOOLS.test(s.body));
  eq(without.length, 0, "these skills never name a tool the agent can actually call: " +
    without.map((s) => s.name).join(", "));
});

await test("attribution is intact", async () => {
  const r = await get(S.base, "/api/skills?full=1");
  const g = r.json.filter((s) => s.name.startsWith("gstack"));
  const credited = g.filter((s) => /garrytan\/gstack/.test(s.body) && /MIT/.test(s.body));
  eq(credited.length, g.length, "these skills lost the MIT attribution: " +
    g.filter((s) => !credited.includes(s)).map((s) => s.name).join(", "));
});

/* ------------------------------------------------------------ the plumbing */

await test("every skill is in the catalogue the model sees", async () => {
  const { catalogue } = await import("../skills.js");
  const cat = await catalogue();
  has(cat, "gstack-ship", "the catalogue omits the pack");
  ok((cat.match(/^- gstack/gm) || []).length === 29, "the catalogue lists the wrong number of gstack skills");
  ok(cat.length < 9000, "the catalogue no longer fits a system prompt cheaply (" + cat.length + " chars)");
});

await test("triggers surface the right skill for a plain-English request", async () => {
  const { match } = await import("../skills.js");
  const cases = [
    ["i have an idea for an app, is this worth building", "gstack-office-hours"],
    ["debug this, it doesn't work and I have no idea why", "gstack-investigate"],
    ["can you review my code before I merge", "gstack-review"],
    ["merge the pr and deploy it", "gstack-land-and-deploy"],
  ];
  for (const [text, expected] of cases) {
    const hits = (await match(text)).map((h) => h.name);
    ok(hits.includes(expected), `"${text}" matched ${hits.join(", ") || "(nothing)"} instead of ${expected}`);
  }
});

await test("use_skill returns the real playbook and emits an event", async () => {
  await setMode("agent-use-skill");
  const { events } = await sse(S.base, "/api/smart",
    { messages: [{ role: "user", content: "load the skill systematic-debugging with use_skill, then call system_info, then answer" }],
      chatId: "skill-tool", forceAgent: true, maxSteps: 4 },
    { until: (e) => e.type === "job_end" || e.type === "error", timeout: 60000 });
  const sk = evs(events, "skill")[0];
  ok(sk, "no skill event was emitted: " + JSON.stringify(events.map((e) => e.type)));
  eq(sk.name, "systematic-debugging");
  const done = evs(events, "tool_end").find((t) => t.name === "use_skill");
  const text = done?.result || (await upstreamRequests()).flatMap((r) => r.messages).map((m) => String(m.content)).join("\n");
  has(text, "NEVER guess-and-patch", "the skill body never reached the model");
});

await test("the UI can offer the commands: menu markup, styles and the API it reads", async () => {
  const html = await get(S.base, "/");
  has(html.text, 'id="slashMenu"', "the slash menu is not in the page");
  const css = await get(S.base, "/style.css");
  has(css.text, ".slash-menu", "the menu has no styles");
  has(css.text, ".log.skill", "the skill card has no styles");
  const js = await get(S.base, "/app.js");
  for (const fn of ["updateSlash", "pickSlash", "closeSlash", "moveSlash"]) has(js.text, fn, `app.js lost ${fn}()`);
  has(js.text, "/api/skills", "the menu does not read the skills API");
  // the menu renders exactly these fields — the API must keep providing them
  const api = (await get(S.base, "/api/skills")).json;
  ok(api.every((s) => s.dir && s.description && Array.isArray(s.triggers)), "the list endpoint dropped a field the menu needs");
  eq("body" in api[0], false, "the list endpoint should stay light (use ?full=1 for bodies)");
});

/* ------------------------------------------------- the slash command path */

await test("/gstack-ship loads the playbook into the run and forces the agent loop", async () => {
  await setMode("text");                       // the mock would answer in chat mode — the skill must veto that
  const before = (await upstreamRequests()).length;
  const { events } = await sse(S.base, "/api/smart",
    { messages: [{ role: "user", content: "/gstack-ship ship the paste feature we just built" }],
      chatId: "slash-ship", maxSteps: 4, title: "ship it" },
    { until: (e) => e.type === "job_end" || e.type === "error", timeout: 60000 });

  const sk = evs(events, "skill")[0];
  ok(sk, "no skill event for a slash command");
  eq(sk.name, "gstack-ship");
  eq(sk.command, "/gstack-ship");
  ok(sk.bytes > 800, "the event does not carry the playbook size");

  const routes = evs(events, "route");
  eq(routes.length, 1, "the router still ran its own classification");
  eq(routes[0].route, "agent", "a slash command did not force the agent loop");
  has(routes[0].why, "skill gstack-ship");
  eq(evs(events, "routing").length, 0, "the UI was told 'routing…' for a command that needs no routing");

  const after = (await upstreamRequests()).slice(before);
  const convo = after.flatMap((r) => r.messages).map((m) => String(m.content)).join("\n");
  has(convo, "[SKILL /gstack-ship", "the playbook was not injected into the conversation");
  has(convo, "Release Engineer", "the stage text is missing from the conversation");
  has(convo, "ship the paste feature we just built", "the user's task was dropped");
  eq(after.every((r) => !/Classify the user's message/i.test((r.messages || []).map((m) => String(m.content)).join(" "))), true,
    "the classification call was still made for a slash command");
});

await test("a bare /office-hours asks the workflow to run on the workspace", async () => {
  await setMode("agent-use-skill");
  const { events } = await sse(S.base, "/api/smart",
    { messages: [{ role: "user", content: "/office-hours" }], chatId: "slash-bare", maxSteps: 3 },
    { until: (e) => e.type === "job_end" || e.type === "error", timeout: 60000 });
  const sk = evs(events, "skill")[0];
  ok(sk, "no skill event");
  eq(sk.name, "gstack-office-hours", "the bare name did not resolve to the gstack- prefixed skill");
  has(sk.task, "Run the /office-hours workflow", "no default task was written: " + sk.task);
});

await test("a non-command starting with / is left alone", async () => {
  await setMode("text");
  const { events } = await sse(S.base, "/api/smart",
    { messages: [{ role: "user", content: "/home/user/notes is where my files live — what is there?" }],
      chatId: "slash-path", maxSteps: 6 },
    { until: (e) => e.type === "job_end" || e.type === "error", timeout: 60000 });
  eq(evs(events, "skill").length, 0, "a filesystem path was treated as a skill command");
  ok(evs(events, "route").length, "normal routing stopped working");
});

await test("an unknown /command falls through to routing instead of breaking", async () => {
  await setMode("text");
  const { events } = await sse(S.base, "/api/smart",
    { messages: [{ role: "user", content: "/definitely-not-a-skill hello" }], chatId: "slash-unknown", maxSteps: 4 },
    { until: (e) => e.type === "job_end" || e.type === "error", timeout: 60000 });
  eq(evs(events, "skill").length, 0);
  ok(evs(events, "route").length, "the run did not fall back to the router");
  eq(evs(events, "error").length, 0, "an unknown command produced an error");
});

/* ------------------------------------------------- the sprint, end to end */

await test("a gstack sprint stage produces its artefact through the agent loop", async () => {
  await setMode("gstack-sprint");
  const { events } = await sse(S.base, "/api/smart",
    { messages: [{ role: "user", content: "/gstack-office-hours I want to build a daily briefing app for my calendar" }],
      chatId: "sprint-1", maxSteps: 8 },
    { until: (e) => e.type === "job_end" || e.type === "error", timeout: 60000 });
  const sk = evs(events, "skill")[0];
  eq(sk?.name, "gstack-office-hours");
  const tools = evs(events, "tool_start").map((e) => e.name);
  has(tools.join(","), "write_file", "the stage never wrote its artefact: " + tools.join(","));
  eq(evs(events, "job_end").at(-1)?.status, "done", "the stage did not finish");
  const ws = await get(S.base, "/api/ws/file?path=DESIGN.md");
  eq(ws.status, 200, "DESIGN.md was not created: " + ws.text.slice(0, 200));
  has(ws.json.content, "## Recommendation", "DESIGN.md is missing the office-hours sections");
  has(ws.json.content, "Narrowest wedge", "DESIGN.md is missing the forcing questions");
});

await test("the sprint's stages can be chained in one chat (design doc → review → ship)", async () => {
  await setMode("gstack-sprint");
  const run = (pick, chatId) => sse(S.base, "/api/smart",
    { messages: [{ role: "user", content: pick }], chatId, maxSteps: 6 },
    { until: (e) => e.type === "job_end" || e.type === "error", timeout: 60000 });
  const a = await run("/gstack-plan-ceo-review review the briefing app plan", "sprint-2");
  has(evs(a.events, "skill")[0]?.name, "plan-ceo-review");
  const b = await run("/gstack-ship ship it", "sprint-3");
  has(evs(b.events, "skill")[0]?.name, "ship");
  const ws = await get(S.base, "/api/ws/tree?dir=.");
  const files = JSON.stringify(ws.json);
  has(files, "DESIGN.md", "the design doc vanished");
  has(files, "PLAN-REVIEW.md", "the CEO review wrote no artefact");
  has(files, "SPRINT.md", "the ship stage left no report");
});

await test("a slash run keeps the playbook out of the job title and out of memory", async () => {
  const jobs = (await get(S.base, "/api/jobs")).json;
  const bad = jobs.filter((j) => /\[SKILL|# \/gstack-/.test(j.title || ""));
  eq(bad.length, 0, "these jobs are titled with the injected playbook: " +
    bad.map((j) => `${j.chatId}="${String(j.title).slice(0, 60)}"`).join(", "));
  // an explicit title wins; with none, the user's task text is used (never the playbook)
  eq(jobs.find((j) => j.chatId === "slash-ship")?.title, "ship it", "an explicit title was overwritten");
  eq(jobs.find((j) => j.chatId === "slash-bare")?.title, "/office-hours",
     "a bare command should be titled with the command itself");
  ok(!/gstack-office-hours|# \/gstack/.test(jobs.find((j) => j.chatId === "slash-bare")?.title || ""),
     "the playbook leaked into the fallback title");

  const mem = await get(S.base, "/api/memory");
  const sessions = JSON.stringify(mem.json.sessions || []);
  hasNot(sessions, "[SKILL", "the playbook text was recorded as the session's task in memory");
  ok(sessions.includes("ship the paste feature") || sessions.includes("briefing app"),
    "no session was recorded at all — the fix went too far");
});

await test("the pack does not break the existing skills or the run audit", async () => {
  const jobs = (await get(S.base, "/api/jobs")).json;
  const bad = jobs.filter((j) => j.status !== "done");
  eq(bad.length, 0, "jobs left unfinished: " + JSON.stringify(bad.map((j) => [j.chatId, j.status])));
  hasNot(S.output, "UNCAUGHT", "an uncaught exception was thrown");
  hasNot(S.output, "UNHANDLED REJECTION", "an unhandled rejection was thrown");
  const code = await get(S.base, "/api/skills");
  ok(code.json.some((s) => s.name === "code-review"), "the pre-existing skills disappeared");
});

summary();
