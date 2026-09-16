/* Multi-provider registry — cloud APIs and LOCAL model servers side by side.
   Any OpenAI-compatible endpoint works: Ollama, LM Studio, llama.cpp, vLLM, LocalAI, Jan. */
import "./env.js";
import OpenAI from "openai";
import fs from "node:fs/promises";
import fss from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.join(__dirname, "providers.json");

/** Well-known local servers we probe for automatically. */
export const LOCAL_PRESETS = [
  { id: "gemini", label: "Gemini Web", baseURL: "http://127.0.0.1:8081/v1", key: "none",
    site: "https://github.com/Sophomoresty/gemini-web2api", free: true },
  { id: "ollama",   label: "Ollama",     baseURL: "http://127.0.0.1:11434/v1", key: "ollama",
    site: "https://ollama.com/download", probe: "http://127.0.0.1:11434/api/tags" },
  { id: "lmstudio", label: "LM Studio",  baseURL: "http://127.0.0.1:1234/v1",  key: "lm-studio",
    site: "https://lmstudio.ai" },
  { id: "llamacpp", label: "llama.cpp",  baseURL: "http://127.0.0.1:8080/v1",  key: "sk-no-key",
    site: "https://github.com/ggerganov/llama.cpp" },
  { id: "jan",      label: "Jan",        baseURL: "http://127.0.0.1:1337/v1",  key: "jan",
    site: "https://jan.ai" },
  { id: "vllm",     label: "vLLM",       baseURL: "http://127.0.0.1:8000/v1",  key: "sk-no-key",
    site: "https://github.com/vllm-project/vllm" },
];

/** Known cloud providers users can plug a key into. */
export const CLOUD_PRESETS = [
  { id: "xkiro", label: "xKiro", envKey: "XKIRO_API_KEY",
    baseURL: "https://api.xkiro.com/v1",
    site: "https://api.xkiro.com", note: "free tier — daily quota, off by default" },
  { id: "dashscope", label: "Alibaba DashScope", envKey: "DASHSCOPE_API_KEY",
    baseURL: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    site: "https://bailian.console.alibabacloud.com", note: "Qwen, Kimi, GLM, DeepSeek" },
  { id: "openai", label: "OpenAI", envKey: "OPENAI_API_KEY",
    baseURL: "https://api.openai.com/v1", site: "https://platform.openai.com/api-keys" },
  { id: "groq", label: "Groq (very fast)", envKey: "GROQ_API_KEY",
    baseURL: "https://api.groq.com/openai/v1", site: "https://console.groq.com/keys" },
  { id: "openrouter", label: "OpenRouter", envKey: "OPENROUTER_API_KEY",
    baseURL: "https://openrouter.ai/api/v1", site: "https://openrouter.ai/keys" },
  { id: "together", label: "Together AI", envKey: "TOGETHER_API_KEY",
    baseURL: "https://api.together.xyz/v1", site: "https://api.together.xyz/settings/api-keys" },
  { id: "deepseek", label: "DeepSeek", envKey: "DEEPSEEK_API_KEY",
    baseURL: "https://api.deepseek.com/v1", site: "https://platform.deepseek.com/api_keys" },
];

/* ---------------- config ---------------- */
export async function loadConfig() {
  try { return JSON.parse(await fs.readFile(CONFIG, "utf8")); }
  catch { return { providers: {} }; }
}
export async function saveConfig(cfg) {
  await fs.writeFile(CONFIG, JSON.stringify(cfg, null, 2), "utf8");
}

/* ---------------- registry ---------------- */
const clients = new Map();   // id -> { id, label, client, baseURL, local, enabled }

/** Providers the user has explicitly switched off. xKiro is off by default
 *  because its free quota runs out; DashScope + Gemini Web are the mains. */
const DEFAULT_OFF = new Set(["xkiro"]);
let disabled = null;

function stateFile() { return path.join(__dirname, ".providers-off.json"); }
function loadDisabled() {
  if (disabled) return disabled;
  try { disabled = new Set(JSON.parse(fss.readFileSync(stateFile(), "utf8"))); }
  catch { disabled = new Set(DEFAULT_OFF); }
  return disabled;
}
function saveDisabled() {
  try { fss.writeFileSync(stateFile(), JSON.stringify([...loadDisabled()]), "utf8"); } catch {}
}
export function isEnabled(id) { return !loadDisabled().has(id); }
export function setEnabled(id, on) {
  const d = loadDisabled();
  if (on) d.delete(id); else d.add(id);
  saveDisabled();
  const rec = clients.get(id);
  if (rec) rec.enabled = on;
  return on;
}

export function register({ id, label, baseURL, apiKey, local = false }) {
  const client = new OpenAI({
    apiKey: apiKey || "not-needed",
    baseURL,
    timeout: Number(process.env.NEXUS_TIMEOUT_MS || (local ? 300000 : 120000)),  // outer bound; complete() enforces the real per-call budget
    maxRetries: 0,
  });
  const rec = { id, label: label || id, client, baseURL, local, enabled: isEnabled(id) };
  clients.set(id, rec);
  return rec;
}

export function get(id) { return clients.get(id); }
export function all() { return [...clients.values()]; }
export function remove(id) { clients.delete(id); }

/** Is a local server actually up? */
export async function ping(baseURL, ms = 2500) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const r = await fetch(baseURL.replace(/\/v1\/?$/, "") + "/v1/models", { signal: ac.signal });
    clearTimeout(t);
    if (!r.ok) return { up: false };
    const j = await r.json().catch(() => ({}));
    return { up: true, models: (j.data || []).map((m) => m.id) };
  } catch { clearTimeout(t); return { up: false }; }
}

/** Scan for any local model server that's running. */
export async function detectLocal(onLog = () => {}) {
  const found = [];
  await Promise.all(LOCAL_PRESETS.map(async (p) => {
    const r = await ping(p.baseURL);
    if (r.up) {
      found.push({ ...p, models: r.models || [] });
      onLog(`found ${p.label} at ${p.baseURL} (${(r.models || []).length} models)\n`);
    }
  }));
  return found;
}

/** Boot: cloud provider + saved providers + auto-detected local servers. */
export async function init(onLog = () => {}) {
  clients.clear();

  // cloud providers configured via .env (DASHSCOPE_API_KEY, GROQ_API_KEY, ...)
  for (const c of CLOUD_PRESETS) {
    const k = (process.env[c.envKey] || "").trim();
    if (!k || /your-key-here/i.test(k)) continue;
    const base = (process.env[c.envKey.replace("_API_KEY", "_BASE_URL")] || "").trim() || c.baseURL;
    register({ id: c.id, label: c.label, baseURL: base, apiKey: k });
    onLog(`cloud provider ${c.label} enabled\n`);
  }

  // user-saved providers
  const cfg = await loadConfig();
  for (const [id, p] of Object.entries(cfg.providers || {})) {
    if (p.disabled) continue;
    register({ id, label: p.label || id, baseURL: p.baseURL, apiKey: p.apiKey, local: !!p.local });
  }

  // auto-detect local servers not already configured
  const local = await detectLocal(onLog);
  for (const l of local) {
    if (clients.has(l.id)) continue;
    register({ id: l.id, label: l.label + " (local)", baseURL: l.baseURL, apiKey: l.key, local: true });
  }

  return all().map((p) => ({ id: p.id, label: p.label, local: p.local, baseURL: p.baseURL }));
}

/** Add a provider permanently. */
export async function add({ id, label, baseURL, apiKey, local }) {
  const probe = await ping(baseURL);
  const cfg = await loadConfig();
  cfg.providers = cfg.providers || {};
  cfg.providers[id] = { label, baseURL, apiKey, local: !!local };
  await saveConfig(cfg);
  register({ id, label, baseURL, apiKey, local });
  return { ok: true, reachable: probe.up, models: probe.models || [] };
}

/** List models from every enabled provider, tagged with provider id. */
export async function listModels() {
  const out = [];
  await Promise.all(all().filter((p) => p.enabled !== false).map(async (p) => {
    try {
      const r = await p.client.models.list();
      for (const m of r.data || []) {
        const caps = m.capabilities || {};
        out.push({
          id: p.id === "xkiro" ? m.id : `${p.id}/${m.id}`,
          rawId: m.id,
          provider: p.id,
          providerLabel: p.label,
          local: p.local,
          name: m.display_name || m.id,
          tier: p.local ? "local" : (m.access_tier || "free"),
          vision: caps.vision !== undefined ? !!caps.vision : /vl|vision|omni|image/i.test(m.id),
          tools: p.id === "xkiro" ? !!caps.tools : true,   // most providers support tools but do not advertise
          reasoning: caps.reasoning !== undefined ? !!caps.reasoning
            : /think|reason|r1|qwq|max|pro|k3|glm-5/i.test(m.id),
          context: m.context_length || (p.local ? 32768 : 131072),
        });
      }
    } catch { /* provider down — skip */ }
  }));
  return out;
}

/** Resolve a tagged model id back to { client, model }. */
const _warnedPrefixes = new Set();
export function resolve(taggedId) {
  if (taggedId && taggedId.includes("/")) {
    const [maybe, ...rest] = taggedId.split("/");
    const p = clients.get(maybe);
    if (p) return { client: p.client, model: rest.join("/"), provider: p.id, local: p.local };
    // A tag that is not a provider id would silently be sent to the default provider with a
    // mangled model name; say so at least once instead of failing somewhere confusing.
    if (!_warnedPrefixes.has(maybe)) {
      _warnedPrefixes.add(maybe);
      console.warn(`[providers] "${maybe}" is not a configured provider — routing "${taggedId}" to the default provider. ` +
        `Known providers: ${[...clients.keys()].join(", ") || "(none)"}`);
    }
  }
  const x = all().find((p) => p.enabled !== false) || all()[0];
  return { client: x?.client, model: taggedId, provider: x?.id, local: !!x?.local };
}
