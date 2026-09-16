/* 03 — model registry: ranking, chains, parameter sanitising, retries, failover.
 *
 * Fault scenarios each get their OWN mock upstream + provider, because a quota or
 * 5xx bench is process-global inside models.js and never reset — sharing a provider
 * between a fault test and a happy-path test produces phantom failures.
 * Each scenario also gets a FRESH models.js module instance (import ?v=N) so that
 * DEAD / DEAD_PROVIDERS state cannot leak between tests.
 */
import path from "node:path";
import fsp from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { suite, test, ok, eq, has, hasNot, truthy, rejects, summary, expectDefect, makeSandbox, startMock, sleep } from "./lib.mjs";

suite("03 models");

/* one mock per scenario */
const mX = await startMock();   // xkiro — happy paths
const m5xx = await startMock(); // mock2 — 5xx retry / failover / benching
const mQ1 = await startMock();  // mock3 — quota during complete()
const mQ2 = await startMock();  // mock4 — quota during streamWithFailover()
const mBad = await startMock(); // mock5 — 400 unsupported parameter
const mHang = await startMock();// mock6 — one model that never answers
const mDown = await startMock();// mock7 — everything hangs (total outage)
const mBroken = await startMock();// mock8 — two models permanently 500

await fetch(m5xx.url.replace(/\/v1$/, "") + "/__ctl", { method: "POST", body: JSON.stringify({ mode: "fail500" }) });
await fetch(mQ1.url.replace(/\/v1$/, "") + "/__ctl", { method: "POST", body: JSON.stringify({ mode: "quota" }) });
await fetch(mQ2.url.replace(/\/v1$/, "") + "/__ctl", { method: "POST", body: JSON.stringify({ mode: "quota" }) });
await fetch(mBad.url.replace(/\/v1$/, "") + "/__ctl", { method: "POST", body: JSON.stringify({ mode: "badparam" }) });
await fetch(mHang.url.replace(/\/v1$/, "") + "/__ctl", { method: "POST", body: JSON.stringify({ hangModels: ["mock-max"] }) });
await fetch(mDown.url.replace(/\/v1$/, "") + "/__ctl", { method: "POST", body: JSON.stringify({ hangModels: ["mock-max", "mock-flash", "mock-plain"] }) });
await fetch(mBroken.url.replace(/\/v1$/, "") + "/__ctl", { method: "POST", body: JSON.stringify({ failModels: ["mock-plain", "mock-flash"] }) });

const dir = await makeSandbox({
  name: "nexus-models",
  providersOff: [],
  // `makeSandbox` copies providers.json from the repo; overwrite it below.
});
await fsp.writeFile(path.join(dir, "providers.json"), JSON.stringify({
  providers: {
    mock2: { label: "Mock 5xx", baseURL: m5xx.url, apiKey: "k" },
    mock3: { label: "Mock Quota-C", baseURL: mQ1.url, apiKey: "k" },
    mock4: { label: "Mock Quota-S", baseURL: mQ2.url, apiKey: "k" },
    mock5: { label: "Mock BadParam", baseURL: mBad.url, apiKey: "k" },
    mock6: { label: "Mock Hang", baseURL: mHang.url, apiKey: "k" },
    mock7: { label: "Mock Down", baseURL: mDown.url, apiKey: "k" },
    mock8: { label: "Mock Broken", baseURL: mBroken.url, apiKey: "k" },
  },
}, null, 2), "utf8");

process.env.XKIRO_API_KEY = "sk-mock-test-key";
process.env.XKIRO_BASE_URL = mX.url;
process.env.NEXUS_TIMEOUT_MS = "15000";
process.env.NEXUS_GEMINI = "false";

const U = (f) => pathToFileURL(path.join(dir, f)).href;
const PROV = await import(U("providers.js"));
let gen = 0;
/** A brand-new models.js module (fresh CACHE / DEAD / DEAD_PROVIDERS). */
const freshModels = () => import(U("models.js") + `?v=${++gen}`);

const M = await freshModels();          // shared catalogue instance
await M.loadModels(true);

/* ---------------- catalogue ---------------- */
await test("loadModels() lists every provider's models, namespaced per provider", async () => {
  const all = await M.loadModels();
  const ids = all.map((m) => m.id);
  for (const id of ["mock-max", "mock-flash", "mock-plain", "mock-paid-max", "mock2/mock-max", "mock5/mock-flash"])
    ok(ids.includes(id), `missing ${id} (got ${ids.join(", ")})`);
});

await test("xkiro ids stay bare and keep their capability flags", async () => {
  const all = await M.loadModels();
  const emb = all.find((m) => m.id === "mock-embedding-v1");
  ok(emb, "embedding model missing");
  eq(emb.tools, false, "the embedding model must not advertise tools");
  eq(all.find((m) => m.id === "mock-paid-max").tier, "paid");
});

await test("other providers are tagged with their provider and default to tools-capable", async () => {
  const all = await M.loadModels();
  const m = all.find((x) => x.id === "mock2/mock-max");
  eq(m.provider, "mock2");
  eq(m.tools, true);
});

/* ---------------- selection ---------------- */
await test("pick() returns free models by default", async () => {
  const p = await M.pick("main", { n: 20 });
  ok(p.length >= 5, "too few candidates: " + p.length);
  ok(!p.some((m) => m.tier === "paid"), "paid model offered while freeOnly is on: " + p.map((x) => x.id).join(","));
});

await test("pick('fast') prefers the low-latency models", async () => {
  const [first] = await M.pick("fast", { n: 1 });
  ok(/flash|mini|lite|turbo/.test(first.id), "fast pick was " + first.id);
});

await test("pick('vision') only offers vision models", async () => {
  const p = await M.pick("vision", { n: 10 });
  ok(p.length, "no vision candidates");
  ok(p.every((m) => m.vision), "non-vision model in the vision pool: " + p.map((x) => x.id).join(","));
  ok(p.some((m) => m.id === "mock-max"));
});

await test("pick('plan') requires reasoning and a large context", async () => {
  const p = await M.pick("plan", { n: 10 });
  ok(p.length, "no planning candidates");
  for (const m of p) {
    truthy(m.reasoning, `${m.id} cannot reason`);
    ok(m.context >= 200000, `${m.id} context is only ${m.context}`);
  }
});

await test("pick() honours the exclude list", async () => {
  const p = await M.pick("main", { n: 30, exclude: ["mock-max", "mock-flash"] });
  ok(!p.some((m) => m.id === "mock-max" || m.id === "mock-flash"), "excluded model still offered");
});

await test("pick(freeOnly:false) puts non-free models first", async () => {
  const p = await M.pick("main", { freeOnly: false, n: 5 });
  eq(p[0].tier, "paid", "paid-capable pick did not lead with the non-free model: " + p.map((x) => `${x.id}:${x.tier}`).join(","));
});

await test("chainFor() puts the preferred model first and never duplicates", async () => {
  const chain = await M.chainFor("main", "mock-plain", true);
  eq(chain[0], "mock-plain");
  eq(new Set(chain).size, chain.length, "duplicates in chain: " + chain.join(","));
  ok(chain.length >= 3, "chain too short: " + chain.join(","));
});

await test("chainFor() drops a model that has been benched", async () => {
  const Mx = await freshModels();
  await Mx.loadModels();
  Mx.markDead("mock-max");
  const chain = await Mx.chainFor("main", "mock-max", true);
  ok(!chain.slice(1).includes("mock-max"), "dead model reappears in the chain: " + chain.join(","));
});

/* ---------------- helpers ---------------- */
await test("sanitize() strips temperature from kimi-k3", async () => {
  const out = M.sanitize({ temperature: 0.4, top_p: 0.9, messages: [] }, "dashscope/kimi-k3");
  ok(!("temperature" in out), "temperature survived");
  ok(!("top_p" in out), "top_p survived");
  ok("messages" in out, "sanitize dropped unrelated fields");
});

await test("sanitize() leaves normal models alone", async () => {
  const body = { temperature: 0.4, max_tokens: 100, messages: [] };
  eq(M.sanitize(body, "mock-max"), body);
});

await test("isQuota() and needsBalance() classify upstream errors", async () => {
  truthy(M.isQuota(new Error("free-model token quota exceeded")), "quota message not detected");
  truthy(M.isQuota({ status: 429, message: "429 rate_limit_exceeded" }), "429 not treated as quota");
  ok(!M.isQuota(new Error("connection reset")), "network error treated as quota");
  truthy(M.needsBalance(new Error("This model requires real deposited balance")), "balance error not detected");
  ok(!M.needsBalance(new Error("quota exceeded")), "quota mistaken for a balance error");
});

/* ---------------- complete() ---------------- */
await test("complete() returns the completion and the model used", async () => {
  const { res, model } = await M.complete({ messages: [{ role: "user", content: "hi" }] }, { chain: ["mock-max"] });
  has(res.choices[0].message.content, "mock upstream");
  eq(model, "mock-max");
});

await test("complete() retries a 400 about an unsupported parameter without that parameter", async () => {
  const Mx = await freshModels();
  await Mx.loadModels();
  await fetch(mBad.url.replace(/\/v1$/, "") + "/__ctl", { method: "POST", body: JSON.stringify({ mode: "badparam" }) });
  const { res } = await Mx.complete({ temperature: 0.7, messages: [{ role: "user", content: "hi" }] }, { chain: ["mock5/mock-max"] });
  has(res.choices[0].message.content, "accepted after parameter retry");
  const reqs = (await (await fetch(mBad.url.replace(/\/v1$/, "") + "/__requests")).json());
  eq(reqs.length, 2, "expected exactly two upstream calls");
  ok(reqs[0].temperature !== undefined, "first attempt should carry temperature");
  eq(reqs[1].temperature, undefined, "the retry still sent the rejected parameter");
});

await test("complete() retries a transient 5xx before giving up", async () => {
  const Mx = await freshModels();
  await Mx.loadModels();
  await fetch(m5xx.url.replace(/\/v1$/, "") + "/__reset", { method: "POST" });
  await fetch(m5xx.url.replace(/\/v1$/, "") + "/__ctl", { method: "POST", body: JSON.stringify({ mode: "fail500" }) });
  const { res } = await Mx.complete({ messages: [{ role: "user", content: "hi" }] },
    { chain: ["mock2/mock-plain"], retries: 3 });
  has(res.choices[0].message.content, "recovered after 5xx");
  const reqs = await (await fetch(m5xx.url.replace(/\/v1$/, "") + "/__requests")).json();
  eq(reqs.filter((r) => r.model === "mock-plain").length, 3, "expected three attempts at the flaky model");
});

await test("complete() fails over to a healthy model and reports the switch", async () => {
  const Mx = await freshModels();
  await Mx.loadModels();
  const switches = [];
  const { model } = await Mx.complete({ messages: [{ role: "user", content: "hi" }] },
    { chain: ["mock8/mock-plain", "mock8/mock-flash", "mock8/mock-max"], onSwitch: (m, why) => switches.push([m, why]) });
  eq(model, "mock8/mock-max", "failover did not reach the third model");
  ok(switches.some(([m]) => m === "mock8/mock-max"), "onSwitch never reported the switch: " + JSON.stringify(switches));
});

await test("complete() benches a model that keeps failing", async () => {
  const Mx = await freshModels();
  await Mx.loadModels();
  await rejects(() => Mx.complete({ messages: [{ role: "user", content: "hi" }] }, { chain: ["mock8/mock-flash"] }), /broken|500/i);
  truthy(Mx.isDead("mock8/mock-flash"), "the hard-failing model was not benched");
});

await test("complete() surfaces the last error when the whole chain fails", async () => {
  const Mx = await freshModels();
  await Mx.loadModels();
  await rejects(() => Mx.complete({ messages: [{ role: "user", content: "hi" }] },
    { chain: ["mock7/mock-plain", "mock7/mock-flash"] }, { timeoutMs: 700 }), /./);
});

/* ---- quota errors must bench the whole provider, not only the model ---- */
await test("complete() benches the out-of-quota PROVIDER (and its models)", async () => {
  const Mx = await freshModels();
  await Mx.loadModels();
  mQ1.ctl.state.mode = "quota";
  await rejects(() => Mx.complete({ messages: [{ role: "user", content: "hi" }] }, { chain: ["mock3/mock-max"] }), /quota/i);
  truthy(Mx.isDead("mock3/mock-max"), "the model was not benched");
  await expectDefect(
    "complete() does not bench an out-of-quota provider",
    () => !Mx.providerDead("mock3/mock-max"),
    "models.js complete() calls markDead(model) on a quota error but never markProviderDead(), unlike\n" +
    "streamWithFailover() which does. Effect: after the free tier of a provider is exhausted, every\n" +
    "request built for a role still ranks that provider's models as healthy, walks into the same 429,\n" +
    "and only then falls through to the next provider — one wasted round-trip per call, and the failure\n" +
    "is invisible to the critic/model picker, which relies on providerDead() to skip dead providers.",
    "medium");
});

/* ---- contrast: the streaming path DOES bench the provider ---- */
await test("streamWithFailover() benches the provider when it answers 429", async () => {
  const Mx = await freshModels();
  await Mx.loadModels();
  try { await Mx.streamWithFailover({ messages: [{ role: "user", content: "hi" }] },
    { chain: ["mock4/mock-max", "mock4/mock-flash"], firstTokenMs: 3000 }); } catch {}
  truthy(Mx.providerDead("mock4/mock-flash"), "the quota-dead provider was not benched by the streaming path");
});

/* ---------------- streaming ---------------- */
await test("streamWithFailover() streams content chunks", async () => {
  const Mx = await freshModels();
  await Mx.loadModels();
  const { model, first, it } = await Mx.streamWithFailover({ messages: [{ role: "user", content: "hi" }] },
    { chain: ["mock-max"], firstTokenMs: 5000 });
  eq(model, "mock-max");
  let text = first?.value?.choices?.[0]?.delta?.content || "";
  while (true) { const n = await it.next(); if (n.done) break; text += n.value.choices?.[0]?.delta?.content || ""; }
  has(text, "mock upstream");
});

await test("streamWithFailover() abandons a model that never sends a first token", async () => {
  const Mx = await freshModels();
  await Mx.loadModels();
  const switches = [];
  const { model, first, it } = await Mx.streamWithFailover({ messages: [{ role: "user", content: "hi" }] },
    { chain: ["mock6/mock-max", "mock6/mock-flash"], firstTokenMs: 800, onSwitch: (m, why) => switches.push([m, why]) });
  eq(model, "mock6/mock-flash", "the stalled model was not abandoned");
  let text = first?.value?.choices?.[0]?.delta?.content || "";
  while (true) { const n = await it.next(); if (n.done) break; text += n.value.choices?.[0]?.delta?.content || ""; }
  has(text, "mock upstream");
  ok(switches.some(([m]) => m === "mock6/mock-flash"), "no switch reported: " + JSON.stringify(switches));
});

await test("streamWithFailover() reports an error when every model is down", async () => {
  const Mx = await freshModels();
  await Mx.loadModels();
  await rejects(() => Mx.streamWithFailover({ messages: [{ role: "user", content: "hi" }] },
    { chain: ["mock7/mock-plain", "mock7/mock-flash"], firstTokenMs: 500 }), /./);
});

/* ---------------- parallel ---------------- */
await test("parallel() runs several chains and reports each result", async () => {
  const Mx = await freshModels();
  await Mx.loadModels();
  const out = await Mx.parallel([
    { id: "a", body: { messages: [{ role: "user", content: "one" }] }, chain: ["mock-max"] },
    { id: "b", body: { messages: [{ role: "user", content: "two" }] }, chain: ["mock-plain"] },
  ]);
  eq(out.length, 2);
  ok(out.every((r) => r.ok), "a parallel job failed: " + JSON.stringify(out.map((r) => r.error)));
  eq(out.map((r) => r.id), ["a", "b"]);
  ok(out[0].text.length > 0, "no text returned");
});

await test("parallel() returns the error for a failed job instead of rejecting", async () => {
  const Mx = await freshModels();
  await Mx.loadModels();
  const out = await Mx.parallel([{ id: "bad", body: { messages: [] }, chain: ["mock7/mock-plain"] }]);
  eq(out[0].ok, false);
  ok(out[0].error, "no error reported");
});

/* ---------------- provider resolution ---------------- */
await test("resolve() maps a namespaced id back to its provider client", async () => {
  const R = PROV.resolve("mock2/mock-max");
  eq(R.provider, "mock2");
  eq(R.model, "mock-max");
  ok(R.client, "no client returned");
});

await test("resolve() keeps a single-segment id on the default provider", async () => {
  const R = PROV.resolve("mock-max");
  eq(R.model, "mock-max");
  ok(R.provider, "no default provider");
});

/* ---- unknown provider prefixes must be reported, not silently re-routed ---- */
await test("resolve() warns when a provider prefix is unknown", async () => {
  const warnings = [];
  const orig = console.warn;
  console.warn = (...a) => warnings.push(a.map(String).join(" "));
  let R;
  try { R = PROV.resolve("ghost-provider/some-model"); } finally { console.warn = orig; }
  const warned = warnings.some((w) => /ghost-provider/.test(w) && /not a configured provider/.test(w));
  await expectDefect(
    "unknown provider prefix silently re-routed",
    () => R.provider !== "ghost-provider" && !warned,
    `providers.js resolve("ghost-provider/some-model") returns { provider: "${R.provider}", model: "${R.model}" }\n` +
    "without any warning of its own (a typo in a model id is sent to whatever provider happens to be first,\n" +
    "with a mangled model name, so the user sees an unrelated 404). resolve() now logs a one-off warning;\n" +
    "the earlier behaviour was completely silent.",
    "low");
});

summary();
