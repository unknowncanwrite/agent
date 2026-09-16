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
  const state = { mode: "text", requests: [], counters: {}, failModels: [], hangModels: [], delayMs: 0 };
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
    if (url.pathname === "/__reset") {
      state.requests = []; state.counters = {}; state.mode = "text";
      state.failModels = []; state.hangModels = []; state.delayMs = 0;
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

    default:
      return { content: "unhandled mock mode: " + state.mode };
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
