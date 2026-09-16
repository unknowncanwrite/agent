/* 02 — unit tests for the pure modules: shell guards, memory, router, supervisor,
   hooks, skills, mcp, jobs and the agent tool implementations.
   Everything runs against a throwaway copy of the app (no repo state is touched). */
import path from "node:path";
import fsp from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { suite, test, ok, eq, has, hasNot, truthy, rejects, summary, makeSandbox, startMock, sleep } from "./lib.mjs";

suite("02 units");

const mock = await startMock();
const dir = await makeSandbox({ name: "nexus-units", providersOff: [] });
const WS = path.join(dir, "workspace");
process.env.AGENT_WORKSPACE = WS;
process.env.AGENT_FULL_ACCESS = "false";
process.env.XKIRO_API_KEY = "sk-mock-test-key";
process.env.XKIRO_BASE_URL = mock.url;
process.env.NEXUS_TIMEOUT_MS = "15000";
process.env.NEXUS_GEMINI = "false";

const U = (f) => pathToFileURL(path.join(dir, f)).href;
const shell = await import(U("shell.js"));
const MEM = await import(U("memory.js"));
const SUP = await import(U("supervisor.js"));
const HOOK = await import(U("hooks.js"));
const SK = await import(U("skills.js"));
const MCP = await import(U("mcp.js"));
const JOBS = await import(U("jobs.js"));
const agent = await import(U("agent.js"));
const router = await import(U("router.js"));

/* ---------------- shell ---------------- */
await test("shell guard blocks the classic destructive commands", async () => {
  for (const c of ["rm -rf /", "mkfs.ext4 /dev/sda1", "dd if=/dev/zero of=/dev/sda",
    ":(){ :|:& };:", "shutdown -h now", "reboot"]) {
    ok(shell.isBlocked(c), `not blocked: ${c}`);
  }
});

await test("shell guard leaves normal commands alone", async () => {
  for (const c of ["ls -la", "npm test", "rm -rf ./build", "python3 -m http.server 8000", "git status"]) {
    ok(!shell.isBlocked(c), `wrongly blocked: ${c}`);
  }
});

await test("runStream captures stdout and the exit code", async () => {
  const r = await shell.runStream("echo hello-nexus", { cwd: WS, timeout: 10 });
  eq(r.code, 0, "exit code");
  has(r.stdout, "hello-nexus");
});

await test("runStream propagates a non-zero exit code", async () => {
  const r = await shell.runStream("exit 3", { cwd: WS, timeout: 10 });
  eq(r.code, 3, "exit code");
});

await test("runStream refuses a blocked command (exit 126)", async () => {
  const chunks = [];
  const r = await shell.runStream("rm -rf /", { cwd: WS, timeout: 10, onData: (d) => chunks.push(d.text) });
  eq(r.code, 126, "exit code");
  truthy(r.blocked, "blocked flag not set");
  has(r.stderr, "BLOCKED");
  has(chunks.join(""), "BLOCKED", "the refusal is not streamed to the UI");
});

await test("runStream streams output live via onData", async () => {
  const chunks = [];
  await shell.runStream("printf 'a\\n'; sleep 0.3; printf 'b\\n'", { cwd: WS, timeout: 10, onData: (d) => chunks.push(d.text) });
  has(chunks.join(""), "a");
  has(chunks.join(""), "b");
  ok(chunks.length >= 2, `expected multiple chunks, got ${chunks.length}`);
});

await test("runStream honours cwd", async () => {
  await fsp.mkdir(path.join(WS, "sub"), { recursive: true });
  const r = await shell.runStream("pwd", { cwd: path.join(WS, "sub"), timeout: 10 });
  has(r.stdout, "sub");
});

await test("runStream times out and kills the child", async () => {
  const r = await shell.runStream("sleep 30", { cwd: WS, timeout: 1 });
  truthy(r.timedOut, "timedOut was not set");
});

await test("sysInfo reports the environment", async () => {
  const s = shell.sysInfo(WS);
  ok(s.platform && s.arch && s.node, "sysInfo is missing platform/arch/node");
  has(JSON.stringify(s), "workspace", "sysInfo does not mention the workspace root");
});

await test("FULL_ACCESS is off by default and toggles", async () => {
  eq(shell.isFull(), false, "sandboxed process should not be in full access");
  shell.setFullAccess(true);
  eq(shell.isFull(), true);
  shell.setFullAccess(false);
  eq(shell.isFull(), false);
});

/* ---------------- memory ---------------- */
await test("remember() stores a fact and reports its id", async () => {
  const msg = await MEM.remember({ text: "The project mascot is a teal fox", kind: "fact", importance: 4 });
  ok(/Remembered|Merged|Already knew/.test(msg), "unexpected reply: " + msg);
  const hits = await MEM.recall("mascot");
  ok(hits.some((f) => /teal fox/.test(f.text)), "the fact is not recallable: " + msg);
});

await test("recall() finds facts by keyword", async () => {
  await MEM.remember({ text: "Deploys go out on Tuesdays", tags: ["ops"] });
  const hits = await MEM.recall("Tuesdays");
  ok(hits.some((f) => /Tuesdays/.test(f.text)), "keyword recall missed the fact");
});

await test("forget() deletes a fact", async () => {
  const msg = await MEM.remember({ text: "the temporary widget is mauve" });
  const id = /#(\w+)/.exec(msg)?.[1];
  ok(id, "no id in the reply: " + msg);
  ok(await MEM.forget(id), "forget returned false");
  const hits = await MEM.recall("mauve");
  ok(!hits.some((x) => x.id === id), "the fact is still recalled after forget");
});

await test("project notes round-trip", async () => {
  await MEM.writeProjectNotes("# Notes\n\n- agent under test\n");
  has(await MEM.projectNotes(), "agent under test");
});

await test("session log records a run", async () => {
  await MEM.logSession({ task: "unit test run", outcome: "ok", files: ["a.txt"], ms: 1234 });
  const s = await MEM.recentSessions(5);
  ok(s.length >= 1, "no sessions recorded");
  has(JSON.stringify(s[0]), "unit test run");
});

await test("contextBlock() summarises memory for the model", async () => {
  const b = await MEM.contextBlock();
  ok(typeof b === "string" && b.length > 0, "contextBlock returned nothing");
});

await test("stats() counts what was stored", async () => {
  const st = await MEM.stats();
  ok(st && (st.facts ?? st.total ?? 0) >= 1, "stats look empty: " + JSON.stringify(st));
});

/* ---------------- router ---------------- */
/* router.js keeps `heuristic` private, so test it through a generated copy. */
const routerSrc = await fsp.readFile(path.join(dir, "router.js"), "utf8");
await fsp.writeFile(path.join(dir, "router-exported.mjs"),
  routerSrc.replace(/^function heuristic/m, "export function heuristic"), "utf8");
const routerX = await import(U("router-exported.mjs"));

await test("heuristic: an informational question routes to chat", async () => {
  const h = routerX.heuristic("what is a monad?");
  ok(h && h.route === "chat", JSON.stringify(h));
});

await test("heuristic: build / file / OS requests route to the agent", async () => {
  for (const [text, why] of [["create a react todo app", "build"], ["run the tests", "execute"],
    ["take a screenshot of my desktop", "os"], ["make a pdf report of sales.csv", "file"]]) {
    const h = routerX.heuristic(text);
    ok(h && h.route === "agent", `${why}: ${JSON.stringify(h)}`);
  }
});

await test("heuristic: genuinely ambiguous text defers to the model", async () => {
  eq(routerX.heuristic("the weather yesterday was pleasant i suppose"), null);
});

await test("router.route(): forceAgent skips classification", async () => {
  const d = await router.route("what is 2+2?", { forceAgent: true });
  eq(d.route, "agent");
  eq(d.tier, "deep");
  eq(mock.ctl.requests.length, 0, "the classifier model was called even though forceAgent was set");
});

await test("router.route(): a build request goes to the agent", async () => {
  const d = await router.route("create a react todo app with tests", { freeOnly: true });
  eq(d.route, "agent", JSON.stringify(d));
});

await test("router.route(): a question goes to chat", async () => {
  const d = await router.route("what is the capital of Peru?", { freeOnly: true });
  eq(d.route, "chat", JSON.stringify(d));
});

await test("router.route(): falls back to the heuristic when the model replies with prose", async () => {
  await fetch(mock.url.replace(/\/v1$/, "") + "/__ctl", { method: "POST", body: JSON.stringify({ mode: "text" }) });
  const d = await router.route("explain how TCP handshakes work", { freeOnly: true });
  ok(["chat", "agent"].includes(d.route), "no route returned");
  ok(d.by, "route decision does not say which model/heuristic decided");
});

await test("router.route(): trusts a JSON classification from the model", async () => {
  await fetch(mock.url.replace(/\/v1$/, "") + "/__ctl", { method: "POST", body: JSON.stringify({ mode: "route-agent" }) });
  const d = await router.route("blah blah nothing obvious here at all", { freeOnly: true });
  eq(d.route, "agent", JSON.stringify(d));
});

await test("router.roleFor() maps route+tier to a model role", async () => {
  eq(router.roleFor({ route: "chat", tier: "light" }), "fast");
  eq(router.roleFor({ route: "chat", tier: "deep" }), "main");
  eq(router.roleFor({ route: "agent", tier: "deep" }), "plan");
  eq(router.roleFor({ route: "agent", tier: "light" }), "code");
});

/* ---------------- supervisor detectors ---------------- */
const log = (n, name, target, extra = {}) => ({ sig: `${name}:${target}`, name, target, failed: false, ...extra });

await test("detect: exact repetition is flagged as a loop", () => {
  const t = [log(1, "list_files", "."), log(2, "list_files", "."), log(3, "list_files", ".")];
  const d = SUP.detect({ toolLog: t });
  ok(d.some((x) => x.kind === "loop" && x.severity === "high"), JSON.stringify(d));
});

await test("detect: varied calls are not flagged", () => {
  const t = [log(1, "read_file", "a"), log(2, "read_file", "b"), log(3, "run_command", "ls")];
  eq(SUP.detect({ toolLog: t }).length, 0);
});

await test("detect: A/B oscillation is caught", () => {
  const t = [log(1, "read_file", "a"), log(2, "write_file", "b"), log(3, "read_file", "a"), log(4, "write_file", "b")];
  const d = SUP.detect({ toolLog: t });
  ok(d.some((x) => x.kind === "oscillation"), JSON.stringify(d));
});

await test("detect: the same tool failing 3 times is 'repeat_fail'", () => {
  const t = Array.from({ length: 3 }, (_, i) => ({ sig: `run_command:cmd${i}`, name: "run_command", failed: true, target: "" }));
  ok(SUP.detect({ toolLog: t }).some((x) => x.kind === "repeat_fail"));
});

await test("detect: an error streak is caught", () => {
  ok(SUP.detect({ toolLog: [], errorStreak: 3 }).some((x) => x.kind === "error_streak"));
});

await test("detect: rewriting one file 4x is thrash", () => {
  const t = Array.from({ length: 4 }, () => ({ sig: "write_file:app.js", name: "write_file", target: "app.js", failed: false }));
  ok(SUP.detect({ toolLog: t }).some((x) => x.kind === "thrash"));
});

await test("detect: finishing without verification is blocked", () => {
  const t = [{ sig: "write_file:x", name: "write_file", target: "x", failed: false }];
  const d = SUP.detect({ toolLog: t, finishing: true });
  ok(d.some((x) => x.kind === "unverified"), JSON.stringify(d));
});

await test("detect: finishing after a successful run is allowed", () => {
  const t = [{ sig: "write_file:x", name: "write_file", target: "x", failed: false },
             { sig: "run_command:python x", name: "run_command", target: "", failed: false }];
  const d = SUP.detect({ toolLog: t, finishing: true });
  ok(!d.some((x) => x.kind === "unverified"), JSON.stringify(d));
});

await test("detect: stalling is flagged", () => {
  ok(SUP.detect({ toolLog: [], stepsWithoutProgress: 4 }).some((x) => x.kind === "stalled"));
});

await test("detect: pure orientation with no output is flagged", () => {
  const t = ["update_plan", "system_info", "list_files", "recall"].map((n, i) => ({ sig: `${n}:${i}`, name: n, failed: false }));
  ok(SUP.detect({ toolLog: t }).some((x) => x.kind === "no_output"), "no_output not raised");
});

await test("isFailure() recognises the failure shapes the agent emits", () => {
  for (const s of ["ERROR: nope", "BLOCKED: guard", "FAILED to build", "exit code: 1", "Traceback (most recent call last):", "No such file or directory"])
    ok(SUP.isFailure(s), `missed: ${s}`);
  for (const s of ["Wrote app.js — 3 lines", "exit code: 0", "Plan updated and written to todo.md."])
    ok(!SUP.isFailure(s), `false positive: ${s}`);
});

await test("makeTracker() counts failures and progress", () => {
  const tr = SUP.makeTracker();
  tr.record("read_file", { path: "a" }, "ERROR: nope", true);
  eq(tr.errorStreak, 1);
  tr.record("write_file", { path: "a", content: "x" }, "Wrote a", false);
  eq(tr.errorStreak, 0, "a successful write should clear the error streak");
  eq(tr.stepsWithoutProgress, 0, "a write counts as progress");
  tr.record("read_file", { path: "a" }, "x", false);
  eq(tr.stepsWithoutProgress, 1);
  eq(tr.toolLog.length, 3);
});

await test("criticChain() gives the supervisor a different model than the worker", async () => {
  const chain = await SUP.criticChain(true, "mock-max");
  ok(Array.isArray(chain) && chain.length, "no critic chain");
  ok(chain[0] !== "mock-max", "the critic would grade its own homework: " + chain[0]);
});

await test("review() returns a verdict object and never throws", async () => {
  const r = await SUP.review({ convo: [{ role: "user", content: "build a thing" }], toolLog: [], task: "build a thing", freeOnly: true });
  ok(r && typeof r === "object", "review returned " + JSON.stringify(r));
});

/* ---------------- hooks ---------------- */
await test("hooks config loads and round-trips", async () => {
  const before = await HOOK.loadHooks();
  ok("hooks" in before, "no hooks key");
  await HOOK.saveHooks({ hooks: [{ event: "after_write", command: "true" }] });
  const after = await HOOK.loadHooks();
  eq(after.hooks.length, 1);
  await HOOK.saveHooks(before);
});

await test("hooks fire a shell command with TOOL/FILE env", async () => {
  const marker = path.join(dir, "hook-ran.txt");
  await HOOK.saveHooks({ hooks: [{ event: "after_write", command: `printf hook-env-$TOOL > ${marker}` }] });
  const r = await HOOK.fire("after_write", { tool: "write_file", file: "x.txt" });
  eq(r.ran, 1, "hook did not run");
  has(await fsp.readFile(marker, "utf8"), "hook-env-write_file");
  await HOOK.saveHooks({ hooks: [] });
});

await test("a failing before_ hook blocks the tool", async () => {
  await HOOK.saveHooks({ hooks: [{ event: "before_write", command: "exit 7" }] });
  const r = await HOOK.fire("before_write", { tool: "write_file", file: "x.txt" });
  eq(r.blocked, true);
  await HOOK.saveHooks({ hooks: [] });
});

await test("checkpoints are written and listed", async () => {
  const f = path.join(WS, "checkpoint-me.txt");
  await fsp.writeFile(f, "v1", "utf8");
  await HOOK.checkpoint(f, "unit");
  await fsp.writeFile(f, "v2", "utf8");
  const list = await HOOK.listCheckpoints(5);
  ok(list.length >= 1, "no checkpoints listed");
});

/* ---------------- skills ---------------- */
await test("skills.list() finds the built-in skills", async () => {
  const s = await SK.list();
  const names = s.map((x) => x.name);
  ok(names.length >= 5, "too few skills: " + names.join(", "));
  for (const n of ["code-review", "tdd", "deep-research"]) ok(names.includes(n), `missing skill ${n}`);
});

await test("skills.get() returns the body of a skill", async () => {
  const s = await SK.get("tdd");
  ok(s && String(s.body || s.content || "").length > 50, "skill body is empty: " + JSON.stringify(s).slice(0, 200));
});

await test("skills.catalogue() is a non-empty prompt string", async () => {
  const c = await SK.catalogue();
  ok(typeof c === "string" && c.length > 50, "catalogue too small");
});

/* ---------------- mcp ---------------- */
await test("mcp config loads (empty by default) and round-trips", async () => {
  const cfg = await MCP.loadConfig();
  ok(cfg && typeof cfg === "object", "bad config");
  await MCP.saveConfig({ mcpServers: { demo: { command: "true", args: [] } } });
  eq(Object.keys((await MCP.loadConfig()).mcpServers).length, 1);
  await MCP.saveConfig({ mcpServers: {} });
});

await test("mcp status starts empty and toolSchemas is an array", async () => {
  eq(MCP.status().length, 0, "no server should be connected");
  ok(Array.isArray(MCP.toolSchemas()));
});

/* ---------------- jobs ---------------- */
await test("jobs: start runs detached and buffers events", async () => {
  const r = JOBS.start({ chatId: "u1", title: "t", fn: async (send) => { send({ type: "a" }); await sleep(20); send({ type: "b" }); } });
  ok(r.ok, "start refused");
  await sleep(80);
  const j = JOBS.get("u1");
  eq(j.status, "done");
  eq(j.buffer.map((e) => e.type), ["a", "b", "job_end"]);
});

await test("jobs: a second start on the same chat is refused", async () => {
  JOBS.start({ chatId: "u2", title: "t", fn: async (send) => { await sleep(150); send({ type: "late" }); } });
  const r = JOBS.start({ chatId: "u2", title: "t", fn: async () => {} });
  eq(r.ok, false);
  has(String(r.error), "running");
  JOBS.stop("u2");
});

await test("jobs: attach replays missed events by index", async () => {
  JOBS.start({ chatId: "u3", title: "t", fn: async (send) => { for (let i = 0; i < 5; i++) send({ type: "n", n: i }); } });
  await sleep(60);
  const seen = [];
  JOBS.attach("u3", (e) => seen.push(e), 2);
  eq(seen.filter((e) => e.type === "n").map((e) => e.n), [3, 4]);
});

await test("jobs: stop() aborts the job", async () => {
  JOBS.start({ chatId: "u4", title: "t", fn: async (send, signal) => {
    await sleep(500);
    if (signal.aborted) throw new Error("aborted");
    send({ type: "never" });
  } });
  await sleep(30);
  eq(JOBS.stop("u4"), true);
  await sleep(80);
  eq(JOBS.get("u4").status, "stopped");
});

/* ---------------- agent tool implementations ---------------- */
const send = () => {};
const impl = agent.makeImpl({ send, freeOnly: true });

await test("write_file then read_file round-trips", async () => {
  const w = await impl.write_file({ path: "notes/hello.txt", content: "hello world\n" });
  has(w, "Wrote");
  eq(await impl.read_file({ path: "notes/hello.txt" }), "hello world\n");
});

await test("write_file invalidates the read cache", async () => {
  await impl.write_file({ path: "cache.txt", content: "first" });
  eq(await impl.read_file({ path: "cache.txt" }), "first");
  await impl.write_file({ path: "cache.txt", content: "second" });
  eq(await impl.read_file({ path: "cache.txt" }), "second", "stale cached content served after a write");
});

await test("edit_file replaces text and reports a miss", async () => {
  await impl.write_file({ path: "edit.txt", content: "alpha beta gamma\n" });
  has(await impl.edit_file({ path: "edit.txt", old_text: "beta", new_text: "BETA" }), "Edited");
  eq(await impl.read_file({ path: "edit.txt" }), "alpha BETA gamma\n");
  has(await impl.edit_file({ path: "edit.txt", old_text: "not-there", new_text: "x" }), "ERROR");
});

await test("delete_file removes it", async () => {
  await impl.write_file({ path: "gone.txt", content: "x" });
  has(await impl.delete_file({ path: "gone.txt" }), "Deleted");
  await rejects(() => impl.read_file({ path: "gone.txt" }), /ENOENT|no such file/i, "read after delete should fail");
});

await test("list_files lists the workspace and hides nothing important", async () => {
  const t = await impl.list_files({ dir: ".", depth: 3 });
  has(t, "notes/");
  has(t, "hello.txt");
});

await test("search_code finds a needle", async () => {
  await impl.write_file({ path: "src/app.py", content: "def nexus_marker():\n    return 42\n" });
  has(await impl.search_code({ query: "nexus_marker", dir: "." }), "src/app.py");
});

await test("run_command executes and reports the exit code", async () => {
  const r = await impl.run_command({ command: "echo tool-output", timeout: 10 });
  has(r, "exit code: 0");
  has(r, "tool-output");
});

await test("run_command surfaces a failing command", async () => {
  const r = await impl.run_command({ command: "exit 4", timeout: 10 });
  has(r, "exit code: 4");
});

await test("run_command refuses to background a process", async () => {
  const r = await impl.run_command({ command: "node -e 'setTimeout(()=>{},10000)' &", timeout: 10 });
  has(r, "REFUSED");
});

await test("paths outside the workspace are refused when not in full access", async () => {
  await rejects(() => impl.read_file({ path: "/etc/passwd" }), /outside workspace/i);
  await rejects(() => impl.write_file({ path: "/tmp/nexus-escape.txt", content: "x" }), /outside workspace/i);
  await rejects(() => impl.read_file({ path: "../escape.txt" }), /outside workspace/i);
});

await test("update_plan writes todo.md and rejects no-op re-plans", async () => {
  const r = await impl.update_plan({ steps: [{ title: "step one", status: "pending" }, { title: "step two", status: "pending" }] });
  has(r, "Plan updated");
  has(await fsp.readFile(path.join(WS, "todo.md"), "utf8"), "step one");
  has(await impl.update_plan({ steps: [{ title: "step one", status: "pending" }, { title: "step two", status: "pending" }] }), "Plan unchanged");
});

await test("system_info reports the runtime", async () => {
  const r = await impl.system_info({});
  ok(r && r.length > 20, "system_info returned nothing useful");
});

await test("ask_user surfaces the question and the loop's awaiting state", async () => {
  const asked = await impl.ask_user({ question: "Which colour?" });
  has(asked, "Which colour?");
});

summary();
