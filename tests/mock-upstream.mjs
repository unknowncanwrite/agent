/* Mock OpenAI-compatible upstream used by the NEXUS test-suite.
   Implements just enough of the API (models + chat completions, streaming and not)
   to drive the real server.js / agent.js code paths offline.

   Scenarios are selected with POST /__ctl {"mode":"..."}; every request is recorded
   in memory and readable at GET /__requests. Per-model faults go in
   state.failModels (500 for those ids) and state.hangModels (never answer). */
import http from "node:http";

const MODELS = [
  { id: "mock-max", display_name: "Mock Max", capabilities: { tools: true, vision: true, reasoning: true }, context_length: 200000, access_tier: "free" },
  { id: "mock-flash", display_name: "Mock Flash", capabilities: { tools: true, vision: false, reasoning: false }, context_length: 32000, access_tier: "free" },
  { id: "mock-plain", display_name: "Mock Plain", capabilities: { tools: true, vision: false, reasoning: false }, context_length: 128000, access_tier: "free" },
  { id: "mock-embedding-v1", display_name: "Mock Embedding V1", capabilities: { tools: false }, context_length: 8000, access_tier: "free" },
  { id: "mock-paid-max", display_name: "Mock Paid Max", capabilities: { tools: true, reasoning: true }, context_length: 500000, access_tier: "paid" },
];

export function startMock({ port = 0 } = {}) {
  const state = { mode: "text", scenario: "", route: "agent", fetchUrl: "", requests: [], counters: {},
                  failModels: [], hangModels: [], delayMs: 0,
                  deployments: [], hooks: 0, renderDeploys: [], failDeploy: false };
  const ctl = { get mode() { return state.mode; }, get requests() { return state.requests; }, state };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const body = await readBody(req);

    if (url.pathname === "/__ctl") {
      Object.assign(state, JSON.parse(body || "{}"));
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ ok: true, mode: state.mode }));
    }
    if (url.pathname === "/__requests") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(state.requests));
    }
    if (url.pathname === "/__deployments") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify(state.deployments));
    }
    if (url.pathname === "/__reset") {
      state.requests = []; state.counters = {}; state.mode = "text";
      state.scenario = ""; state.route = "agent"; state.fetchUrl = "";
      state.failModels = []; state.hangModels = []; state.delayMs = 0;
      state.deployments = []; state.hooks = 0; state.renderDeploys = []; state.failDeploy = false;
      res.writeHead(200); return res.end("ok");
    }

    if (url.pathname.endsWith("/models") && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ object: "list", data: MODELS }));
    }

    if (url.pathname.endsWith("/chat/completions") && req.method === "POST") {
      let payload = {};
      try { payload = JSON.parse(body || "{}"); } catch {}
      const n = (state.counters[payload.model] = (state.counters[payload.model] || 0) + 1);
      state.requests.push({
        model: payload.model, stream: !!payload.stream, temperature: payload.temperature,
        max_tokens: payload.max_tokens, nTools: (payload.tools || []).length,
        toolNames: (payload.tools || []).map((t) => t.function?.name),
        messages: payload.messages,
        lastRole: payload.messages?.at(-1)?.role,
        toolMsgs: (payload.messages || []).filter((m) => m.role === "tool").length,
      });
      if (state.failModels.includes(payload.model)) {
        res.writeHead(500, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: "this model is broken", type: "server_error" } }));
      }
      if (state.hangModels.includes(payload.model)) return;      // never answer
      if (state.delayMs) await sleep(state.delayMs);
      return handleCompletion(req, res, payload, n, state);
    }

    // ---- a fetchable page (used by the fetch_url prompt) ----
    if (url.pathname === "/demo" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end("<html><head><title>Demo</title></head><body><h1>MOCK PAGE TEXT</h1>" +
        "<p>This is the demo page served by the mock upstream. It exists so fetch_url " +
        "has something real to read without a browser.</p></body></html>");
    }

    // ---- fake hosting APIs (used by the publish tests) ----
    if (url.pathname === "/v13/deployments" && req.method === "POST") {
      if (state.failDeploy) {
        res.writeHead(403, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { code: "forbidden", message: "invalid token" } }));
      }
      const dep = JSON.parse(body || "{}");
      state.deployments.push({ name: dep.name, target: dep.target, projectSettings: dep.projectSettings,
        files: (dep.files || []).map((f) => ({ file: f.file, encoding: f.encoding, bytes: String(f.data || "").length })) });
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ id: "dpl_mock_" + state.deployments.length, url: `${dep.name}-mock.vercel.app`, readyState: "READY" }));
    }
    if (url.pathname === "/hook" && req.method === "POST") {
      state.hooks++;
      res.writeHead(200, { "content-type": "text/plain" });
      return res.end("deploy hook triggered");
    }
    if (/^\/v1\/services\/[^/]+$/.test(url.pathname) && req.method === "GET") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ id: "srv_mock", name: "demo-site", serviceDetails: { url: "demo-site.onrender.com" } }));
    }
    if (/^\/v1\/services\/[^/]+\/deploys$/.test(url.pathname) && req.method === "POST") {
      state.renderDeploys.push(JSON.parse(body || "{}") || {});
      res.writeHead(202, { "content-type": "application/json" });
      return res.end(JSON.stringify({ id: "dep_mock_" + state.renderDeploys.length }));
    }

    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "not found", type: "invalid_request_error" } }));
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      resolve({ server, port: server.address().port, ctl,
        url: `http://127.0.0.1:${server.address().port}/v1`,
        close: () => new Promise((r) => server.close(r)) });
    });
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => resolve(b));
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---- scripted responses ------------------------------------------------- */

function planFor(payload, n, state) {
  const messages = payload.messages || [];
  const toolResults = messages.filter((m) => m.role === "tool");
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const userText = typeof lastUser?.content === "string" ? lastUser.content
    : (lastUser?.content || []).map((p) => p.text || "").join(" ");

  switch (state.mode) {
    case "text":
      return { content: "Hello from the mock upstream. Everything is fine." };

    case "echo-system": {
      const sys = messages.find((m) => m.role === "system")?.content || "";
      return { content: `SYSTEM_LEN=${sys.length}` };
    }

    case "badparam":
      if (n === 1) return { error: { status: 400, message: "Parameter 'temperature' is not supported by this model" } };
      return { content: "accepted after parameter retry" };

    case "fail500":
      if (n <= 2) return { error: { status: 500, message: "upstream exploded" } };
      return { content: "recovered after 5xx" };

    case "quota":
      return { error: { status: 429, message: "free-model token quota exceeded for today" } };

    case "stall":
      return { hang: true };

    case "agent":
      // write → run → answer: a full, well-behaved agent run
      if (toolResults.length === 0) {
        return { tool_calls: [{ name: "write_file", args: { path: "hello.py", content: "print('hi from nexus')\n" } }] };
      }
      if (!toolResults.some((m) => m.name === "run_command")) {
        return { tool_calls: [{ name: "run_command", args: { command: "python3 hello.py" } }] };
      }
      return { content: `DONE. Verified hello.py printed its output. (last user msg: ${String(userText).slice(0, 40)})` };

    case "agent-slow-verify":
      // writes, then claims it is finished without running anything (tests the unverified gate)
      if (toolResults.length === 0) {
        return { tool_calls: [{ name: "write_file", args: { path: "unverified.txt", content: "never executed\n" } }] };
      }
      if (toolResults.length < 8) return { content: "I have finished the task, everything is done." };
      return { content: "Verified after the supervisor forced it." };

    case "agent-parallel":
      if (toolResults.length === 0) {
        return { tool_calls: [
          { name: "read_file", args: { path: "a.txt" } },
          { name: "read_file", args: { path: "b.txt" } },
          { name: "read_file", args: { path: "c.txt" } },
        ] };
      }
      return { content: "Read all three files in parallel." };

    case "agent-loop":
      return { tool_calls: [{ name: "list_files", args: { dir: "." } }] };

    case "agent-count":
      if (toolResults.length === 0) return { tool_calls: [{ name: "system_info", args: {} }] };
      return { content: "counted" };

    case "agent-unknown-tool":
      if (toolResults.length === 0) return { tool_calls: [{ name: "do_magic", args: {} }] };
      return { content: "tool error handled" };

    case "agent-site":
      if (toolResults.length === 0) {
        return { tool_calls: [{ name: "write_file", args: { path: "index.html", content:
          "<!doctype html><html><head><title>Mock Site</title></head><body><h1>hello from the mock site</h1></body></html>\n" } }] };
      }
      if (!toolResults.some((m) => m.name === "run_command")) {
        return { tool_calls: [{ name: "run_command", args: { command: "ls -la index.html" } }] };
      }
      return { content: "Built and verified the landing page." };

    case "agent-ask":
      if (toolResults.length === 0) {
        return { tool_calls: [{ name: "ask_user", args: { question: "Which colour?" } }] };
      }
      return { content: "should not get here" };

    case "route-agent":
      return { content: '{"route":"agent","tier":"deep","why":"needs tools"}' };

    case "route-chat":
      return { content: 'Sure! {"route":"chat","tier":"light","why":"question"} hope that helps.' };

    case "agent-prose":
      return { content: "I will create the file for you now. Let me write the script and run it." };

    case "agent-use-skill":
      // the model loads a skill by name, then does a tiny bit of work
      if (toolResults.length === 0)
        return { tool_calls: [{ name: "use_skill", args: { name: "systematic-debugging" } }] };
      if (!toolResults.some((m) => m.name === "system_info"))
        return { tool_calls: [{ name: "system_info", args: {} }] };
      return { content: "Skill loaded and system checked. NEVER guess-and-patch — reproduce the failure first, then localise it." };

    case "gstack-sprint":
      return gstackSprintPlan(messages, toolResults);

    case "pack":
      // a single mode driven per-request by /__ctl { scenario, route, fetchUrl }
      return packPlan(state, messages, toolResults);

    default:
      return { content: "unhandled mock mode: " + state.mode };
  }
}

/* Detect the router's classification call so the pack mode can answer it with a route. */
function isClassifyCall(messages) {
  return (messages || []).some((m) => {
    const c = typeof m.content === "string" ? m.content
      : (m.content || []).map((p) => p.text || "").join(" ");
    return /Classify the user's message/i.test(c);
  });
}

const SUBAGENT_FILES = {
  "README.md": "# Project\n\nA short overview of this project, written by a parallel sub-agent.\n",
  "LICENSE": "MIT License\n\nCopyright (c) 2026\n\nPermission is hereby granted, free of charge, to any person obtaining a copy.\n",
  "site/index.html": "<!doctype html>\n<html><head><meta charset='utf-8'><title>Riverside Bakery</title><link rel='stylesheet' href='styles.css'></head>\n<body><h1>Riverside Bakery</h1><p>Fresh sourdough, croissants and coffee every morning.</p></body></html>\n",
  "site/styles.css": "body { font-family: Georgia, serif; margin: 3rem auto; max-width: 40rem; }\nh1 { color: #6b3f23; }\n",
};

/* A sub-agent conversation (spawn_subagents) gets a simple writer plan derived from its GOAL. */
function subagentPlan(messages, toolResults) {
  const lastUser = [...(messages || [])].reverse().find((m) => m.role === "user");
  const u = typeof lastUser?.content === "string" ? lastUser.content : "";
  if (!/You are sub-agent/i.test(u)) return null;
  const cell = (/WRITE ALL FILES UNDER:\s*(\S+)/.exec(u) || [])[1] || "";
  const file = (/write the file ([\w./-]+)/i.exec(u) || [])[1] || "";
  const target = (cell ? cell + "/" : "") + file;
  if (!toolResults.length) {
    if (file) return { tool_calls: [{ name: "write_file", args: { path: target, content: SUBAGENT_FILES[file] || `Written by a sub-agent.\n` } }] };
    return { content: "Done." };
  }
  return { content: `Done — wrote ${file || "the requested file"}.` };
}

/* The gstack sprint stages: each [SKILL …] marker names its stage. A chained chat carries
   several markers — the stage under test is always the LAST one. */
function gstackSprintPlan(messages, toolResults) {
  const all = (messages || []).map((m) => String(typeof m.content === "string" ? m.content : "")).join("\n");
  const marks = [...all.matchAll(/\[SKILL \/([a-z0-9-]+)\]/g)];
  const stage = marks.length ? marks.at(-1)[1] : "";
  if (stage.includes("office-hours")) {
    if (!toolResults.length) return { tool_calls: [{ name: "write_file", args: { path: "DESIGN.md", content:
      "# Design: daily briefing app for my calendar\n\n## Forcing questions\nWhat pain does it remove, for whom, and how much would they pay?\n\n## Narrowest wedge\nOne morning email: today's meetings plus the free blocks between them.\n\n## Recommendation\nBuild the wedge first. Ship it in a day, then grow from real usage.\n" } }] };
    return { content: "DESIGN.md written — forcing questions answered, the narrowest wedge named, one recommendation." };
  }
  if (stage.includes("plan-ceo-review")) {
    if (!toolResults.length) return { tool_calls: [{ name: "write_file", args: { path: "PLAN-REVIEW.md", content:
      "# CEO review of the briefing app plan\n\nScope: right-sized. Risk: low. Decision: ship the wedge first.\n" } }] };
    return { content: "PLAN-REVIEW.md written — scope modes compared, decision appended." };
  }
  if (stage.includes("ship")) {
    if (!toolResults.length) return { tool_calls: [{ name: "write_file", args: { path: "SPRINT.md", content:
      "# SPRINT report\n\nDiff audited, full test run green, change committed and pushed.\n" } }] };
    return { content: "SPRINT.md written — the ship report: audit, tests, commit." };
  }
  if (!toolResults.length) return { tool_calls: [{ name: "write_file", args: { path: "STAGE.md", content: "Stage output.\n" } }] };
  return { content: "Stage complete." };
}

/* The 20-prompt pack: one plan per scenario. Steps advance as tool results accumulate,
   exactly like the existing "agent" modes above. */
function packPlan(state, messages, toolResults) {
  if (isClassifyCall(messages)) {
    const route = state.route === "chat" ? "chat" : "agent";
    return { content: JSON.stringify({ route, tier: "deep", why: "scripted pack routing" }) };
  }
  const sub = subagentPlan(messages, toolResults);
  if (sub) return sub;

  switch (state.scenario) {
    case "chat":
      return { content: "A few name ideas: The Daily Grind, Copper Kettle, First Light, Beans & Bough. My pick is Copper Kettle — warm, specific and easy to say out loud." };
    case "notes":
      if (!toolResults.length) return { tool_calls: [{ name: "write_file", args: { path: "notes/todo.md", content:
        "# Launch the landing page\n\n- [ ] Finalise the copy and pick the domain\n- [ ] Wire up the waitlist form\n- [ ] Send the launch email\n" } }] };
      return { content: "notes/todo.md created with the three launch tasks." };
    case "website":
      if (!toolResults.length) return { tool_calls: [{ name: "write_file", args: { path: "index.html", content:
        "<!doctype html>\n<html><head><meta charset='utf-8'><title>Riverside Bakery</title></head>\n<body><h1>Riverside Bakery</h1><p>Fresh sourdough, croissants and coffee every morning.</p></body></html>\n" } }] };
      if (!toolResults.some((m) => m.name === "run_command"))
        return { tool_calls: [{ name: "run_command", args: { command: "test -f index.html && grep -c 'Riverside Bakery' index.html" } }] };
      return { content: "The bakery page is built and the check passed — index.html carries the name and the offer." };
    case "fib":
      if (!toolResults.length) return { tool_calls: [{ name: "write_file", args: { path: "fib.py", content:
        "n, a, b = 10, 0, 1\nout = []\nwhile n:\n    out.append(str(a))\n    a, b = b, a + b\n    n -= 1\nprint(\" \".join(out))\n" } }] };
      if (!toolResults.some((m) => m.name === "run_command"))
        return { tool_calls: [{ name: "run_command", args: { command: "python3 fib.py" } }] };
      return { content: "fib.py written and run — the first ten Fibonacci numbers printed above." };
    case "csv":
      if (!toolResults.length) return { tool_calls: [{ name: "write_file", args: { path: "products.csv", content:
        "name,price\ncoffee,3.50\nbread,2.80\njam,4.20\n" } }] };
      if (!toolResults.some((m) => m.name === "read_file"))
        return { tool_calls: [{ name: "read_file", args: { path: "products.csv" } }] };
      return { content: "products.csv saved and read back: coffee, bread and jam with their prices." };
    case "tests-fail":
      if (!toolResults.length) return { tool_calls: [{ name: "run_command", args: { command: "python3 -c \"import sys; sys.exit(1)\"" } }] };
      return { content: "I ran the suite and I have to be straight with you: it FAILED. The run exited non-zero and the output above is the failure — I would not call this green." };
    case "list":
      if (!toolResults.length) return { tool_calls: [{ name: "list_files", args: { dir: "." } }] };
      return { content: "That is the current workspace, listed above — everything that exists right now." };
    case "append":
      if (!toolResults.length) return { tool_calls: [{ name: "edit_file", args: { path: "a.txt", old_text: "two\n", new_text: "two\n# reviewed\n" } }] };
      return { content: "a.txt now ends with the line # reviewed." };
    case "delete":
      if (!toolResults.length) return { tool_calls: [{ name: "delete_file", args: { path: "scratch.txt" } }] };
      return { content: "scratch.txt is deleted." };
    case "search":
      if (!toolResults.length) return { tool_calls: [{ name: "search_code", args: { query: "TODO" } }] };
      return { content: "Here is every TODO in the workspace — the matches are listed above." };
    case "fetch":
      if (!toolResults.length) return { tool_calls: [{ name: "fetch_url", args: { url: state.fetchUrl || "http://127.0.0.1/demo" } }] };
      return { content: "The page says it is the mock demo page — the heading is MOCK PAGE TEXT and the body explains what it is for." };
    case "server":
      if (!toolResults.length) return { tool_calls: [{ name: "start_server", args: { command: "python3 -m http.server 4711", port: 4711 } }] };
      if (!toolResults.some((m) => m.name === "run_command"))
        return { tool_calls: [{ name: "run_command", args: { command: "curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4711/" } }] };
      if (!toolResults.some((m) => m.name === "stop_server"))
        return { tool_calls: [{ name: "stop_server", args: { all: true } }] };
      return { content: "The server answered 200 to the probe and is stopped again — nothing left running." };
    case "remember":
      if (!toolResults.length) return { tool_calls: [{ name: "remember", args: { text: "User prefers dark-mode interfaces.", kind: "preference" } }] };
      if (!toolResults.some((m) => m.name === "recall"))
        return { tool_calls: [{ name: "recall", args: { query: "dark mode" } }] };
      return { content: "Saved, and confirmed from memory: you prefer dark-mode interfaces." };
    case "stats":
      if (!toolResults.length) return { tool_calls: [{ name: "system_stats", args: {} }] };
      return { content: "Those are the live numbers — disk, memory, load and uptime, read from this machine just now." };
    case "ask":
      if (!toolResults.length) return { tool_calls: [{ name: "ask_user", args: { question: "Which database should I use — SQLite or Postgres?" } }] };
      return { content: "should not get here" };
    case "parallel":
      if (!toolResults.length) return { tool_calls: [{ name: "spawn_subagents", args: { tasks: [
        { name: "readme", goal: "write the file README.md with a short project overview." },
        { name: "license", goal: "write the file LICENSE containing a short MIT license." },
      ] } }] };
      return { content: "Both parallel agents finished — README.md and LICENSE are in the workspace." };
    case "undo":
      if (!toolResults.length) return { tool_calls: [{ name: "undo_last_change", args: { file: "notes/todo.md" } }] };
      return { content: "Done — the last change to notes/todo.md is undone, so the file is gone again." };
    case "gitstatus":
      if (!toolResults.length) return { tool_calls: [{ name: "git_status", args: {} }] };
      return { content: "The workspace is not a git repository yet — no branch, no commits, nothing to report." };
    case "todoapp":
      if (toolResults.length < 3) {
        const files = [
          ["index.html", "<!doctype html>\n<html><head><meta charset='utf-8'><title>Todo</title></head>\n<body><ul id='list'></ul><script src='app.js'></script></body></html>\n"],
          ["app.js", "const items = [];\nfunction add(item) { items.push(item); render(); return items.length; }\nfunction remove(item) { const i = items.indexOf(item); if (i >= 0) items.splice(i, 1); render(); return items.length; }\nfunction render() { const el = document.getElementById(\"list\"); if (el) el.innerHTML = items.map((x) => `<li>${x}</li>`).join(\"\"); }\nadd(\"example task\");\n"],
          ["test.js", "const list = [];\nlist.push(\"buy milk\");\nif (list.length !== 1) { console.error(\"FAIL: first item added\"); process.exit(1); }\nlist.splice(list.indexOf(\"buy milk\"), 1);\nif (list.length !== 0) { console.error(\"FAIL: item removed\"); process.exit(1); }\nconsole.log(\"2 tests passed\");\n"],
        ];
        return { tool_calls: [{ name: "write_file", args: { path: files[toolResults.length][0], content: files[toolResults.length][1] } }] };
      }
      if (!toolResults.some((m) => m.name === "run_command"))
        return { tool_calls: [{ name: "run_command", args: { command: "node test.js" } }] };
      return { content: "The todo app is built (index.html + app.js + test.js) and the test run above shows 2 tests passed." };
    case "parallel-site":
      if (!toolResults.length) return { tool_calls: [{ name: "spawn_subagents", args: { tasks: [
        { name: "page", isolate: true, goal: "write the file site/index.html — the bakery page." },
        { name: "styles", isolate: true, goal: "write the file site/styles.css — the bakery stylesheet." },
      ], merge: "keep-both" } }] };
      return { content: "Both agents finished and their files are merged back into site/ — the page and its stylesheet are ready to go live." };
    default:
      return { content: "unhandled pack scenario: " + state.scenario };
  }
}

async function handleCompletion(req, res, payload, n, state) {
  const plan = planFor(payload, n, state);

  if (plan.hang) return;

  if (plan.error) {
    res.writeHead(plan.error.status || 500, { "content-type": "application/json" });
    return res.end(JSON.stringify({ error: { message: plan.error.message, type: "invalid_request_error" } }));
  }

  const id = "chatcmpl-" + Math.random().toString(36).slice(2, 10);
  const created = Math.floor(Date.now() / 1000);

  if (!payload.stream) {
    const message = plan.tool_calls
      ? { role: "assistant", content: null,
          tool_calls: plan.tool_calls.map((t, i) => ({ id: `call_${i}_${id}`, type: "function",
            function: { name: t.name, arguments: JSON.stringify(t.args || {}) } })) }
      : { role: "assistant", content: plan.content ?? "" };
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({
      id, object: "chat.completion", created, model: payload.model,
      choices: [{ index: 0, message, finish_reason: plan.tool_calls ? "tool_calls" : "stop" }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    }));
  }

  // streaming
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
  const chunk = (delta, finish = null) => res.write("data: " + JSON.stringify({
    id, object: "chat.completion.chunk", created, model: payload.model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  }) + "\n\n");

  chunk({ role: "assistant" });
  if (plan.tool_calls) {
    plan.tool_calls.forEach((t, i) => {
      chunk({ tool_calls: [{ index: i, id: `call_${i}_${id}`, type: "function",
        function: { name: t.name, arguments: JSON.stringify(t.args || {}) } }] });
    });
    chunk({}, "tool_calls");
  } else {
    const words = String(plan.content ?? "").split(/(?<=\s)/);
    for (const w of words) { chunk({ content: w }); await sleep(2); }
    chunk({}, "stop");
  }
  res.write("data: [DONE]\n\n");
  res.end();
}
