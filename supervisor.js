/* CRITIC — a master supervisor agent that watches every step, catches loops,
   mistakes and dead ends, and either auto-corrects or injects guidance. */
import { complete, chainFor, loadModels, isDead } from "./models.js";
import * as MEM from "./memory.js";

/* ---------------- deterministic detectors (free, instant) ---------------- */

const sig = (call) => {
  try {
    const a = JSON.parse(call.function?.arguments || "{}");
    const key = a.command || a.path || a.file || a.query || a.url || a.dir || "";
    return `${call.function?.name}:${String(key).slice(0, 120)}`;
  } catch { return call.function?.name || "?"; }
};

/** Look at recent history and flag mechanical failure patterns. */
export function detect(state) {
  const { toolLog = [], stepsWithoutProgress = 0, errorStreak = 0 } = state;
  const out = [];

  // 1. exact repetition — the classic loop
  const last6 = toolLog.slice(-6).map((t) => t.sig);
  const counts = {};
  for (const s of last6) counts[s] = (counts[s] || 0) + 1;
  for (const [s, n] of Object.entries(counts)) {
    if (n >= 3) out.push({ kind: "loop", severity: "high",
      msg: `You have called \`${s}\` ${n} times in the last 6 steps with the same arguments. Repeating it will not change the result.` });
  }

  // 2. A/B oscillation
  if (last6.length >= 4) {
    const [a, b, c, d] = last6.slice(-4);
    if (a === c && b === d && a !== b) out.push({ kind: "oscillation", severity: "high",
      msg: `You are alternating between \`${a}\` and \`${b}\` without progress.` });
  }

  // 3. repeated failures of the same tool
  const fails = toolLog.slice(-8).filter((t) => t.failed);
  const byName = {};
  for (const f of fails) byName[f.name] = (byName[f.name] || 0) + 1;
  for (const [n, c] of Object.entries(byName)) {
    if (c >= 3) out.push({ kind: "repeat_fail", severity: "high",
      msg: `\`${n}\` has failed ${c} times recently. The approach is wrong, not the arguments.` });
  }

  // 4. consecutive errors
  if (errorStreak >= 3) out.push({ kind: "error_streak", severity: "high",
    msg: `${errorStreak} tool calls in a row failed. Stop and re-read the first error.` });

  // 5. thrash: editing the same file repeatedly
  const edits = toolLog.slice(-10).filter((t) => /write_file|edit_file|patch_own_code/.test(t.name));
  const byFile = {};
  for (const e of edits) byFile[e.target] = (byFile[e.target] || 0) + 1;
  for (const [f, c] of Object.entries(byFile)) {
    if (f && c >= 4) out.push({ kind: "thrash", severity: "medium",
      msg: `You have rewritten \`${f}\` ${c} times. Read it fully and fix the real cause instead of patching.` });
  }

  // 6. no verification before finishing
  if (state.finishing) {
    const verified = toolLog.some((t) => /run_command|screenshot|browser_interact|self_test|analyze_data|android_build/.test(t.name) && !t.failed);
    const built = toolLog.some((t) => /write_file|edit_file|create_document|android_create/.test(t.name));
    if (built && !verified) out.push({ kind: "unverified", severity: "high",
      msg: "You are about to finish but never actually RAN or LOOKED AT anything you built. Verify it first." });
  }

  // 7. stalling
  if (stepsWithoutProgress >= 4) out.push({ kind: "stalled", severity: "high",
    msg: `${stepsWithoutProgress} steps without creating or running anything. Stop planning and write the first real file NOW.` });

  // 8. orienting loop — planning/reading with nothing produced
  const first5 = toolLog.slice(0, 5).map((t) => t.name);
  const orient = first5.filter((n) => /update_plan|system_info|list_files|use_skill|recall|os_control_status/.test(n)).length;
  if (toolLog.length >= 4 && orient >= 4 && !toolLog.some((t) => /write_file|create_document|android_create|run_command|start_server|scaffold_project/.test(t.name))) {
    out.push({ kind: "no_output", severity: "high",
      msg: "You have only planned and inspected — nothing has been created. Call write_file with real content on your very next step." });
  }

  return out;
}

/* ---------------- LLM critic (the "master" reviewer) ---------------- */

/**
 * Pick the BEST AVAILABLE model to supervise, re-evaluated on every call.
 * Not bound to any provider or fixed model:
 *  - scores every live model across every configured provider
 *  - strongly prefers reasoning ability and large context
 *  - EXCLUDES whatever the worker is using, so review is genuinely independent
 *  - skips benched/quota-dead models automatically
 */
export async function criticChain(freeOnly, workerModel = null) {
  let all = [];
  try { all = await loadModels(); } catch {}

  const NON_CHAT = /embedding|rerank|-asr|-tts|image|video|ocr|speech/i;
  const score = (m) => {
    let s = 0;
    if (m.reasoning) s += 40;                       // a supervisor must reason
    if (m.context >= 500000) s += 14;
    else if (m.context >= 200000) s += 10;
    else if (m.context >= 100000) s += 6;
    if (m.vision) s += 4;
    if (m.tools) s += 3;
    if (/max|opus|pro|ultra|405b|235b|k3|glm-5|v4-pro/i.test(m.id)) s += 22;  // flagship tiers
    if (/plus|large|32b|27b|70b|72b/i.test(m.id)) s += 12;
    if (/flash|mini|lite|small|tiny|8b|3b|1b|highspeed/i.test(m.id)) s -= 18; // too weak to supervise
    if (m.tier === "local") s += 6;                 // free + private, still capable
    if (m.tier === "free") s += 4;
    return s;
  };

  // Gemini Web is free and strong — ideal supervisor, and independent of the worker's provider
  const gem = all.filter((m) => m.provider === "gemini" && /thinking|pro|3\.7|3\.6/.test(m.id));

  const candidates = all
    .filter((m) => m.tools !== false && !NON_CHAT.test(m.id) && !isDead(m.id))
    .filter((m) => !freeOnly || m.tier === "free" || m.tier === "local")
    .sort((a, b) => score(b) - score(a));

  // independence: never let the worker grade its own homework
  const independent = candidates.filter((m) => m.id !== workerModel);
  const pool = independent.length ? independent : candidates;

  // spread across providers so one outage cannot silence the supervisor
  const byProvider = new Map();
  for (const m of pool) {
    const p = m.provider || "default";
    if (!byProvider.has(p)) byProvider.set(p, []);
    byProvider.get(p).push(m.id);
  }
  const chain = [];
  // put a free Gemini thinking model first when present
  for (const g of gem) if (g.id !== workerModel && !chain.includes(g.id)) { chain.push(g.id); break; }
  for (let i = 0; i < 4; i++) {
    for (const list of byProvider.values()) if (list[i] && !chain.includes(list[i])) chain.push(list[i]);
  }
  if (!chain.length) {                              // last resort
    const rev = await chainFor("review", null, freeOnly);
    return rev.filter((m) => m !== workerModel).concat(rev);
  }
  return chain.slice(0, 10);
}

const CRITIC_SYSTEM = `You are CRITIC — the supervising engineer watching another AI agent work in real time.
You are more experienced than it is. Your job is to catch mistakes EARLY and redirect.

Judge only what you can see. Tool arguments and results in the trace are ABBREVIATED for length
(long paths are shortened with "…" in the middle). NEVER conclude a file has a wrong or truncated
name from how it appears here — that is a display artefact, not a bug. If you need to check what
exists on disk, request list_files via autofix instead of asserting.

Look for:
- wrong approach (a simpler/more reliable path exists)
- unverified claims ("it works" with nothing run)
- repeated failures where the hypothesis is wrong
- ignoring the user's actual request or drifting scope
- fabricated APIs, invented file contents, made-up numbers
- security or destructive risk
- giving up too early

You may also AUTO-FIX: if the correct next action is unambiguous and safe, name the exact tool
call the agent should make and it will be executed automatically.

Reply with STRICT JSON only:
{"verdict":"ok"|"warn"|"intervene",
 "issue":"<one sentence, empty if ok>",
 "guidance":"<concrete next action in 1-2 sentences, empty if ok>",
 "autofix":{"tool":"<tool name>","args":{...}}   // OPTIONAL, omit unless certain
 "confidence":0.0-1.0}

Only include autofix for safe, read-only or clearly-correct actions
(read_file, list_files, search_code, run_command with a test/inspect command, use_skill).
NEVER autofix a delete, a power action, or an irreversible write.

verdict=ok         : on track, say nothing
verdict=warn       : minor drift, gentle nudge
verdict=intervene  : it is stuck, wrong, or about to ship something broken

Be sparing with intervene — only when it genuinely changes the outcome.
Before claiming something failed, point to the exact line in RECENT ACTIONS that shows it.
If a tool returned a success message, treat it as successful unless a later line contradicts it.`;

/** Build a compact trace for the critic. */
function digest(convo, toolLog, task) {
  const recent = toolLog.slice(-10).map((t) =>
    `${t.failed ? "✗" : "✓"} ${t.name}(${t.arg || ""}) → ${String(t.result || "").slice(0, 180).replace(/\n/g, " ")}`);
  const lastSay = [...convo].reverse().find((m) => m.role === "assistant" && m.content)?.content || "";
  return `USER'S TASK: ${String(task).slice(0, 600)}

RECENT ACTIONS:
${recent.join("\n") || "(none yet)"}

AGENT'S LATEST REASONING:
${String(lastSay).slice(0, 1200) || "(none)"}`;
}

/**
 * Ask a strong model to review. Runs in parallel with the main agent —
 * never blocks it, result is applied on the next step.
 */
export async function review({ convo, toolLog, task, freeOnly, signal, onEvent, workerModel = null }) {
  try {
    const chain = await criticChain(freeOnly, workerModel);
    onEvent?.({ type: "critic_thinking", model: chain[0] });
    const { res, model } = await complete({
      temperature: 0.1,
      max_tokens: 300,
      messages: [
        { role: "system", content: CRITIC_SYSTEM },
        { role: "user", content: digest(convo, toolLog, task) },
      ],
    }, { chain, signal, timeoutMs: 40000 });

    const raw = res.choices?.[0]?.message?.content || "";
    const m = raw.match(/\{[\s\S]*\}/);
    if (!m) return null;
    const j = JSON.parse(m[0]);
    if (!j.verdict || j.verdict === "ok") return { verdict: "ok", model };
    return {
      verdict: j.verdict,
      issue: String(j.issue || "").slice(0, 400),
      guidance: String(j.guidance || "").slice(0, 600),
      autofix: SAFE_AUTOFIX.has(j.autofix?.tool) ? j.autofix : null,
      confidence: Number(j.confidence) || 0.6,
      model,
    };
  } catch {
    return null;   // critic must never break the run
  }
}

/** Tools the supervisor is allowed to run on its own. */
export const SAFE_AUTOFIX = new Set([
  "read_file", "list_files", "search_code", "git_diff", "git_status",
  "use_skill", "recall", "self_test", "android_status", "os_control_status", "system_info",
]);

/* ---------------- self-learning ---------------- */

/** After a run, distil durable lessons into long-term memory. */
export async function learn({ task, convo, toolLog, interventions, freeOnly, signal, userMsgs = [], workerModel = null }) {
  const failures = toolLog.filter((t) => t.failed);
  // learn from corrections/preferences in what the user SAID, not only from failures
  const corrective = userMsgs.filter((m) =>
    /\b(no|not|don'?t|stop|instead|actually|i want|i prefer|always|never|wrong|fix it|should be)\b/i.test(m));
  if (!failures.length && !interventions.length && !corrective.length) return null;

  try {
    const chain = await criticChain(freeOnly, workerModel);
    const { res } = await complete({
      temperature: 0.2,
      max_tokens: 400,
      messages: [
        { role: "system", content:
`You extract durable LESSONS from an AI agent's work session so it performs better next time.
Only record things that will still be true in future sessions: environment quirks, this user's
preferences, commands that do/don't work here, recurring mistakes to avoid.
Ignore one-off details.

Reply STRICT JSON: {"lessons":[{"text":"...","kind":"habit"|"fact"|"preference"|"project","importance":1-5}]}
Return at most 3. If nothing durable was learned, return {"lessons":[]}.` },
        { role: "user", content:
`TASK: ${String(task).slice(0, 400)}

FAILURES ENCOUNTERED:
${failures.slice(-8).map((f) => `- ${f.name}: ${String(f.result).slice(0, 200).replace(/\n/g, " ")}`).join("\n") || "(none)"}

SUPERVISOR INTERVENTIONS:
${interventions.slice(-5).map((i) => `- ${i.issue} → ${i.guidance}`).join("\n") || "(none)"}

WHAT THE USER SAID (mine this for preferences and corrections):
${corrective.slice(-6).map((m) => "- " + m.slice(0, 220)).join("\n") || "(nothing corrective)"}` },
      ],
    }, { chain, signal, timeoutMs: 40000 });

    const m = (res.choices?.[0]?.message?.content || "").match(/\{[\s\S]*\}/);
    if (!m) return null;
    const { lessons = [] } = JSON.parse(m[0]);
    const saved = [];
    for (const l of lessons.slice(0, 3)) {
      if (!l.text || l.text.length < 12) continue;
      await MEM.remember({ text: l.text, kind: l.kind || "habit", tags: ["lesson"], importance: l.importance || 3 });
      saved.push(l.text);
    }
    return saved.length ? saved : null;
  } catch { return null; }
}

/* ---------------- run tracker ---------------- */

/** Shorten for display WITHOUT losing the filename (a truncated path made the
 *  critic hallucinate that files were written to broken names). */
function shortenArg(v, max = 90) {
  if (v.length <= max) return v;
  const head = v.slice(0, 28);
  const tail = v.slice(-(max - 31));      // always keep the end = filename
  return head + "…" + tail;
}

export function makeTracker() {
  return {
    toolLog: [], errorStreak: 0, stepsWithoutProgress: 0,
    interventions: [], lastCriticStep: 0, pending: null, finishing: false,

    record(name, args, result, failed) {
      let target = "";
      try { target = args?.path || args?.file || ""; } catch {}
      this.toolLog.push({
        name, sig: sig({ function: { name, arguments: JSON.stringify(args || {}) } }),
        arg: shortenArg(String(args?.path || args?.command || args?.file || args?.query || "")),
        target, result: String(result || "").slice(0, 400), failed: !!failed,
      });
      if (this.toolLog.length > 60) this.toolLog.shift();
      this.errorStreak = failed ? this.errorStreak + 1 : 0;
      const progressed = !failed && /write_file|edit_file|delete_file|run_command|start_server|create_document|android_build|android_create|git_commit|screenshot|browser_interact|analyze_data|scaffold_project|install_packages|patch_own_code|write_own_code/.test(name);
      this.stepsWithoutProgress = progressed ? 0 : this.stepsWithoutProgress + 1;
    },
  };
}

export const isFailure = (r) => /^ERROR|BLOCKED|FAILED|not found|exit code: [1-9]|Traceback|No such file/im.test(String(r || ""));
