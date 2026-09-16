/* Model registry: free-first ranking + role-based selection + parallel racing */
import "./env.js";
import OpenAI from "openai";
import * as PROV from "./providers.js";

const API_KEY = (process.env.XKIRO_API_KEY || process.env.OPENAI_API_KEY || "").trim();

const HAS_KEY = !!API_KEY && !/your-key-here/i.test(API_KEY);
if (false) {
  console.error("\n" + "─".repeat(62));
  console.error("  MISSING API KEY\n");
  console.error("  NEXUS needs an API key to talk to the models.\n");
  console.error("  1. Open the .env file in this folder");
  console.error("     (if it does not exist, copy .env.example to .env)");
  console.error("  2. Set your key:  XKIRO_API_KEY=sk-xt-...");
  console.error("  3. Save, then run:  npm start");
  console.error("─".repeat(62) + "\n");
  process.exit(2);      // exit 2 = fatal config error, supervisor will not loop
}

export const client = new OpenAI({
  apiKey: API_KEY || "local-only",
  baseURL: process.env.XKIRO_BASE_URL || "https://api.xkiro.com/v1",
  timeout: Number(process.env.NEXUS_TIMEOUT_MS || 120000),  // outer bound only
  maxRetries: 0,                                            // we handle retries/failover
});

const TIER_RANK = { local: 0, free: 1, premium: 2, paid: 3 };   // local first: no quota, private, free

/** Primary providers: genuinely free and reliable. Ranked above everything else. */
const MAIN_PROVIDERS = new Set(["gemini", "dashscope", "ollama", "lmstudio", "llamacpp", "jan", "vllm"]);
const providerOf = (id) => (String(id).includes("/") ? String(id).split("/")[0] : "xkiro");

/** Hand-tuned quality scores for the free tier (higher = better). */
const QUALITY = {
  "qwen/qwen3.8-max": 100, "qwen/qwen3.7-max": 96, "qwen/qwen3.7-plus": 94,
  "qwen/qwen3-coder-plus": 93, "deepseek/deepseek-v4-pro": 92,
  "minimax/minimax-m3": 91, "qwen/qwen3.6-plus": 90, "deepseek/deepseek-v4-flash": 89,
  "qwen/qwen3.5-plus": 87, "qwen/qwen3-max": 86, "qwen/qwen3.5-flash": 84,
  "minimax/minimax-m2.7": 83, "mistralai/mistral-medium-3.5": 82,
  "qwen/qwen3.5-397b-a17b": 81, "deepseek/deepseek-chat-v3.1": 80,
  "mistralai/devstral-medium": 79, "mistralai/codestral-2508": 78,
  "qwen/qwen3-vl-plus": 77, "minimax/minimax-m2.5": 74, "deepseek/deepseek-v3.2": 73,
  "mistralai/mistral-large-2512": 72, "qwen/qwen3.6-27b": 70,
  "openai/gpt-5.3-codex-spark": 69, "mistralai/ministral-14b": 60,
  // DashScope (Alibaba) — strong tool-callers
  "dashscope/qwen3.8-max": 100, "dashscope/qwen3.8-max-0902": 100,
  "dashscope/kimi-k3": 97, "dashscope/kimi/kimi-k3": 97,
  "dashscope/ZHIPU/GLM-5.3": 95, "dashscope/glm-5.3": 95,
  "dashscope/deepseek-v4-pro-0813": 94, "dashscope/qwen3.8-2.4t-a95b": 93,
  "dashscope/kimi-k2.7-code": 92, "dashscope/qwen3.8-27b": 88,
  "dashscope/qwen3.8-flash": 86, "dashscope/deepseek-v4-flash-0731": 85,
  "dashscope/qwen3.7-max-2026-06-08": 90, "dashscope/qwen-plus": 82,
  "dashscope/glm-5.2": 84, "dashscope/qwen3.7-flash": 80,
  // Gemini Web (free, via gemini-web2api) — excellent reasoning for the supervisor
  "gemini/gemini-3.5-flash-thinking": 97, "gemini/gemini-3.7-flash": 94,
  "gemini/gemini-3.6-flash": 92, "gemini/gemini-3.5-flash": 90,
  "gemini/gemini-3.1-pro": 93, "gemini/gemini-auto": 88, "gemini/gemini-flash-lite": 78,
};
const base = (id) => id.replace(/:free$/, "");
const score = (m) =>
  (QUALITY[base(m.id)] ?? 50) +
  (m.context >= 500000 ? 4 : 0) +
  (MAIN_PROVIDERS.has(m.provider || providerOf(m.id)) ? 30 : 0);   // prefer the reliable free mains

let CACHE = { at: 0, list: [] };
const DEAD = new Map();               // id -> timestamp when it last hard-failed
const DEAD_MS = 3 * 60 * 1000;

export function markDead(id) { DEAD.set(id, Date.now()); }

const DEAD_PROVIDERS = new Map();
const PROVIDER_DEAD_MS = 10 * 60 * 1000;
export function markProviderDead(id) {
  const p = String(id).includes("/") ? String(id).split("/")[0] : "xkiro";
  DEAD_PROVIDERS.set(p, Date.now());
}
export function providerDead(id) {
  const p = String(id).includes("/") ? String(id).split("/")[0] : "xkiro";
  return Date.now() - (DEAD_PROVIDERS.get(p) || 0) < PROVIDER_DEAD_MS;
}
export const isDead = (id) => providerDead(id) || Date.now() - (DEAD.get(id) || 0) < DEAD_MS;

export async function loadModels(force = false) {
  if (!force && CACHE.list.length && Date.now() - CACHE.at < 5 * 60_000) return CACHE.list;
  if (!PROV.all().length) await PROV.init();
  const list = (await PROV.listModels())
    .sort((a, b) =>
      (TIER_RANK[a.tier] ?? 9) - (TIER_RANK[b.tier] ?? 9) ||
      score(b) - score(a) ||
      b.context - a.context);
  CACHE = { at: Date.now(), list };
  return list;
}

/** Pick the best models for a role. */
export async function pick(role, { freeOnly = true, n = 1, exclude = [] } = {}) {
  const all = await loadModels();
  const NON_CHAT = /embedding|rerank|-asr|-tts|image|video|ocr|speech|audio-.*-(asr|tts)/i;
  let pool = all.filter((m) => m.tools && !exclude.includes(m.id) && !isDead(m.id) && !NON_CHAT.test(m.id));
  if (freeOnly) {
    const free = pool.filter((m) => m.tier === "free" || m.tier === "local");
    if (free.length) pool = free;
  } else {
    // paid allowed: put non-free first, since free is usually what ran out
    pool = [...pool.filter((m) => m.tier !== "free"), ...pool.filter((m) => m.tier === "free")];
  }
  const need = {
    vision: (m) => m.vision,
    plan: (m) => m.reasoning && m.context >= 200000,
    review: (m) => m.reasoning,
    code: () => true,
    fast: () => true,
    main: () => true,
  }[role] || (() => true);

  let cands = pool.filter(need);
  if (!cands.length) cands = pool;
  if (role === "fast") {
    // genuinely low-latency models first: flash/mini/turbo/highspeed, small params, local
    const speed = (m) => {
      let s = 0;
      if (/flash|mini|turbo|highspeed|instant|lite|small|haiku/i.test(m.id)) s += 50;
      if (/\b(3b|7b|8b|9b|14b|27b)\b/i.test(m.id)) s += 20;
      if (m.tier === "local") s += 15;
      if (/max|opus|ultra|pro|405b|235b|2\.4t/i.test(m.id)) s -= 40;   // big = slow
      if (m.reasoning) s -= 15;                                        // thinking = slow
      return s;
    };
    cands = [...cands].sort((a, b) => speed(b) - speed(a));
  }
  return cands.slice(0, n);
}

/** Ordered failover chain for a role. */
export async function chainFor(role, preferred, freeOnly = true) {
  const picks = await pick(role, { freeOnly, n: freeOnly ? 8 : 10 });
  const ids = picks.map((m) => m.id);
  const out = [];
  if (preferred && !isDead(preferred)) out.push(preferred);
  for (const id of ids) if (!out.includes(id)) out.push(id);
  return out.length ? out : [preferred || "qwen/qwen3.8-max:free"];
}

export function needsBalance(e) {
  let b = (e?.message || "");
  try { b += " " + JSON.stringify(e?.error ?? ""); } catch {}
  return /requires real deposited balance|pay-as-you-go|insufficient balance|deposited/i.test(b);
}
export function isQuota(e) {
  let blob = (e?.message || "") + " " + (e?.code || "") + " " + (e?.type || "");
  try { blob += " " + JSON.stringify(e?.error ?? e?.response?.data ?? e?.body ?? ""); } catch {}
  return /free-model token quota|rate_limit_exceeded|insufficient_quota|quota/i.test(blob);
}
/** Some models reject standard params (e.g. kimi-k3 forbids temperature). */
const PARAM_BLOCK = [
  { match: /kimi-k3/i, drop: ["temperature", "top_p"] },
  { match: /^o[1-9]|o1-|o3-/i, drop: ["temperature", "top_p", "frequency_penalty", "presence_penalty"] },
];
export function sanitize(body, model) {
  const rule = PARAM_BLOCK.find((r) => r.match.test(model));
  if (!rule) return body;
  const out = { ...body };
  for (const k of rule.drop) delete out[k];
  return out;
}
/** A 400 complaining about a parameter — retry without it. */
function unsupportedParam(e) {
  let msg = e?.message || "";
  try { msg += " " + JSON.stringify(e?.error ?? e?.response?.data ?? ""); } catch {}
  if (e?.status !== 400) return null;
  const pats = [
    /Parameter '([\w_.]+)'/i,
    /unsupported parameter[:\s]+'?([\w_.]+)'?/i,
    /does not support '?([\w_.]+)'?/i,
    /'([\w_.]+)' is not supported/i,
    /invalid[_ ]parameter[:\s]+'?([\w_.]+)'?/i,
    /unrecognized (?:request )?(?:argument|parameter)[:\s]+'?([\w_.]+)'?/i,
  ];
  for (const p of pats) { const r = p.exec(msg); if (r?.[1]) return r[1]; }
  // generic 400 mentioning a param we sent -> drop the usual suspects
  for (const k of ["temperature", "top_p", "max_tokens", "frequency_penalty", "presence_penalty"]) {
    if (new RegExp(`\\b${k}\\b`, "i").test(msg)) return k;
  }
  return null;
}

const transient = (e) => {
  if (isQuota(e)) return false;              // retrying cannot help
  const s = e?.status;
  return !s || s === 429 || s >= 500 || /timeout|ECONNRESET|fetch failed|aborted/i.test(e?.message || "");
};

/**
 * Call the API with automatic retry + model failover.
 * onSwitch(modelId, reason) fires whenever we move to a different model.
 */
export async function complete(body, { chain, signal, onSwitch, retries = 1, timeoutMs = 60000, onAttempt } = {}) {
  let lastErr;
  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];
    if (isDead(model) && i < chain.length - 1) continue;
    for (let a = 0; a < retries; a++) {
      try {
        const ac = new AbortController();
        const onAbort = () => ac.abort();
        signal?.addEventListener("abort", onAbort, { once: true });
        const tm = setTimeout(() => ac.abort(), timeoutMs);
        let res;
        const R = PROV.resolve(model);
        let sent = sanitize({ ...body, model: R.model }, model);
        try { res = await (R.client || client).chat.completions.create(sent, { signal: ac.signal }); }
        catch (e1) {
          const bad = unsupportedParam(e1);
          if (!bad) throw e1;
          delete sent[bad];
          res = await (R.client || client).chat.completions.create(sent, { signal: ac.signal });
        }
        finally { clearTimeout(tm); signal?.removeEventListener("abort", onAbort); }
        if (i > 0) onSwitch?.(model, "failover");
        return { res, model };
      } catch (e) {
        lastErr = e;
        if (signal?.aborted) throw e;
        // Exhausted quota is a provider-wide condition: bench the whole provider so the
        // model picker stops offering its models (matching streamWithFailover()).
        if (isQuota(e)) { markProviderDead(model); break; }
        if (!transient(e)) { markDead(model); break; }        // hard error: skip model
        if (a === retries - 1) markDead(model);
        else await new Promise((r) => setTimeout(r, 700 * (a + 1)));
      }
    }

  }
  throw lastErr || new Error("All models failed");
}

/**
 * Streaming with failover AND a stall guard: if a model produces no first token
 * within `firstTokenMs`, abandon it and try the next one.
 */
export async function streamWithFailover(body, { chain, signal, onSwitch, firstTokenMs = 12000 } = {}) {
  let lastErr;
  for (let i = 0; i < chain.length; i++) {
    const model = chain[i];
    if (isDead(model) && i < chain.length - 1) continue;

    const ac = new AbortController();
    const onAbort = () => ac.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let timer = null;

    try {
      // Guard BOTH the connection and the first token with one race.
      const R = PROV.resolve(model);
      const attempt = (async () => {
        let sent = sanitize({ ...body, model: R.model, stream: true }, model);
        let stream;
        try { stream = await (R.client || client).chat.completions.create(sent, { signal: ac.signal }); }
        catch (e1) {
          const bad = unsupportedParam(e1);
          if (!bad) throw e1;
          delete sent[bad];
          stream = await (R.client || client).chat.completions.create(sent, { signal: ac.signal });
        }
        const it = stream[Symbol.asyncIterator]();
        const first = await it.next();
        return { stream, it, first };
      })();

      const firstMs = R.local ? Math.max(firstTokenMs, 90000) : firstTokenMs;   // local models load slowly
      const timeout = new Promise((_, rej) => {
        timer = setTimeout(() => {
          try { ac.abort(); } catch {}
          rej(new Error(`no response within ${firstMs}ms`));
        }, firstMs);
      });

      const { it, first } = await Promise.race([attempt, timeout]);
      clearTimeout(timer); timer = null;
      signal?.removeEventListener("abort", onAbort);
      if (i > 0) onSwitch?.(model, "failover");
      return { model, first, it };
    } catch (e) {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      try { ac.abort(); } catch {}
      if (signal?.aborted) throw e;
      if (isQuota(e)) { markProviderDead(model); lastErr = e; continue; }   // bench provider, try next
      lastErr = e;
      markDead(model);
    }
  }
  throw lastErr || new Error("All models failed to stream");
}

/** Run several prompts concurrently (different models) and return all results. */
export async function parallel(jobs, { signal, onSwitch } = {}) {
  return Promise.all(jobs.map(async (j) => {
    try {
      const { res, model } = await complete(j.body, { chain: j.chain, signal, onSwitch });
      return { ok: true, id: j.id, model, text: res.choices?.[0]?.message?.content || "", raw: res };
    } catch (e) {
      return { ok: false, id: j.id, error: e.message };
    }
  }));
}
