/* Concurrency primitives: bounded worker pool, tool batching, context compaction */

/** Run jobs with a max concurrency limit. Preserves input order. */
export async function pool(items, limit, fn) { // pooled
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    while (true) {
      const idx = i++;
      if (idx >= items.length) return;
      try { out[idx] = await fn(items[idx], idx); }
      catch (e) { out[idx] = { __error: e?.message || String(e) }; }
    }
  });
  await Promise.all(workers);
  return out;
}

/** Tools that only read state — safe to run simultaneously. */
export const READ_ONLY = new Set([
  "list_files", "read_file", "search_code", "web_search", "fetch_url",
  "system_info", "read_own_code", "list_processes", "screenshot",
  "self_diff", "self_history",
]);

/** Tools that must never overlap with anything else. */
export const EXCLUSIVE = new Set([
  "write_file", "edit_file", "delete_file", "run_command", "start_server",
  "stop_server", "browser_interact", "write_own_code", "patch_own_code",
  "rollback_self", "self_test", "restart_app",
]);

/**
 * Split a batch of tool calls into ordered groups.
 * Consecutive read-only calls become one parallel group; everything else runs alone.
 */
export function scheduleCalls(calls) {
  const groups = [];
  let batch = [];
  for (const c of calls) {
    const name = c.function?.name;
    if (READ_ONLY.has(name) && !EXCLUSIVE.has(name)) batch.push(c);
    else {
      if (batch.length) { groups.push(batch); batch = []; }
      groups.push([c]);
    }
  }
  if (batch.length) groups.push(batch);
  return groups;
}

/* ---------------- Context management ---------------- */

const approxTokens = (s) => Math.ceil((typeof s === "string" ? s.length : JSON.stringify(s || "").length) / 3.6);

export function convoTokens(convo) {
  return convo.reduce((n, m) => n + approxTokens(m.content) + (m.tool_calls ? approxTokens(m.tool_calls) : 0), 0);
}

/**
 * Keep the conversation under budget without breaking tool_call/tool pairing.
 * Strategy: keep system + first user turn + a recent window; summarise the middle
 * and aggressively shrink old tool outputs (which dominate token use).
 */
export function compact(convo, { budget = 120000, keepRecent = 14 } = {}) {
  if (convoTokens(convo) <= budget) return { convo, compacted: false };

  const sys = convo[0]?.role === "system" ? [convo[0]] : [];
  const rest = convo.slice(sys.length);
  const firstUser = rest.findIndex((m) => m.role === "user");
  const head = firstUser >= 0 ? [rest[firstUser]] : [];

  // Walk back from the end, but don't cut between an assistant tool_calls msg and its tool results.
  let cut = Math.max(0, rest.length - keepRecent);
  while (cut > 0 && rest[cut]?.role === "tool") cut--;
  const tail = rest.slice(cut);
  const middle = rest.slice(firstUser + 1, cut);

  const facts = [];
  for (const m of middle) {
    if (m.role === "tool") {
      const t = String(m.content || "");
      const line = t.split("\n").find((l) => /^(Wrote|Edited|Deleted|exit code|Started|Rolled)/.test(l));
      if (line) facts.push(`- ${m.name}: ${line.slice(0, 160)}`);
      else if (/ERROR|FAIL/i.test(t)) facts.push(`- ${m.name}: ${t.split("\n")[0].slice(0, 160)}`);
    } else if (m.role === "assistant" && m.content) {
      const s = m.content.trim().split("\n")[0];
      if (s.length > 25) facts.push(`- (me) ${s.slice(0, 160)}`);
    }
  }
  const summary = {
    role: "user",
    content: "[Earlier work compacted to save context. Key events:]\n" +
      (facts.slice(-45).join("\n") || "(routine steps)") +
      "\n[Continue from here — do not redo completed work.]",
  };

  let out = [...sys, ...head, summary, ...tail];

  // Still too big? shrink the largest tool payloads.
  let guard = 0;
  while (convoTokens(out) > budget && guard++ < 60) {
    let bi = -1, bl = 0;
    out.forEach((m, i) => {
      if (m.role === "tool" && typeof m.content === "string" && m.content.length > bl) { bl = m.content.length; bi = i; }
    });
    if (bi < 0 || bl < 900) break;
    // keep any file reference so the content stays RESTORABLE
    const ref = /Full output saved to: (\S+)/.exec(out[bi].content)?.[1];
    out[bi] = { ...out[bi], content: out[bi].content.slice(0, 700) +
      (ref ? `\n…[trimmed — full content still at ${ref}]` : "\n…[trimmed to save context]") };
  }
  return { convo: out, compacted: true, tokens: convoTokens(out) };
}

/* ---------------- Caches ---------------- */

export class TTLCache {
  constructor(ttl = 20000, max = 200) { this.ttl = ttl; this.max = max; this.m = new Map(); }
  get(k) {
    const v = this.m.get(k);
    if (!v) return undefined;
    if (Date.now() - v.t > this.ttl) { this.m.delete(k); return undefined; }
    return v.v;
  }
  set(k, v) {
    if (this.m.size >= this.max) this.m.delete(this.m.keys().next().value);
    this.m.set(k, { v, t: Date.now() });
  }
  clear() { this.m.clear(); }
}
