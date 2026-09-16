/* Background job manager — agent runs survive disconnects, tab switches and reloads.
   Each chat gets its own job; many can run concurrently and you can reattach any time. */

const JOBS = new Map();          // chatId -> job
const MAX_BUFFER = 4000;         // events kept for replay

export function get(chatId) { return JOBS.get(chatId); }

export function list() {
  return [...JOBS.values()].map((j) => ({
    chatId: j.chatId,
    status: j.status,
    title: j.title,
    startedAt: j.startedAt,
    endedAt: j.endedAt || null,
    events: j.buffer.length,
    tools: j.tools,
    step: j.step,
    lastTool: j.lastTool || null,
    model: j.model || null,
    subscribers: j.subs.size,
  }));
}

export function isRunning(chatId) {
  const j = JOBS.get(chatId);
  return !!j && j.status === "running";
}

/** Start a detached run. `fn(send, signal)` does the work. */
export function start({ chatId, title, fn }) {
  const existing = JOBS.get(chatId);
  if (existing?.status === "running") return { ok: false, error: "already running", job: existing };

  const controller = new AbortController();
  const job = {
    chatId, title: title || "task",
    status: "running",
    startedAt: Date.now(), endedAt: null,
    buffer: [], subs: new Set(), controller,
    seq: 0, tools: 0, step: 0, lastTool: null, model: null,
  };
  JOBS.set(chatId, job);

  const send = (ev) => {
    if (!ev || typeof ev !== "object") return;
    const packed = { ...ev, _i: job.seq++ };

    // keep a light summary for the jobs list / UI badges
    if (ev.type === "tool_start") { job.tools++; job.lastTool = ev.name; }
    if (ev.type === "step") job.step = ev.step;
    if (ev.type === "model" || ev.type === "model_switch") job.model = ev.model;

    job.buffer.push(packed);
    if (job.buffer.length > MAX_BUFFER) job.buffer.splice(0, job.buffer.length - MAX_BUFFER);

    for (const sub of job.subs) {
      try { sub(packed); } catch { job.subs.delete(sub); }
    }
  };

  // run detached — nothing here depends on an HTTP connection
  (async () => {
    try {
      await fn(send, controller.signal);
      job.status = controller.signal.aborted ? "stopped" : "done";
    } catch (e) {
      job.status = "failed";
      send({ type: "error", error: e?.message || String(e) });
    } finally {
      job.endedAt = Date.now();
      send({ type: "job_end", status: job.status });
      // keep finished jobs around briefly so a reconnecting tab still sees the ending
      setTimeout(() => {
        const cur = JOBS.get(chatId);
        if (cur && cur.status !== "running" && !cur.subs.size) JOBS.delete(chatId);
      }, 10 * 60 * 1000);
    }
  })();

  return { ok: true, job };
}

/** Attach a listener; replays everything missed since `since`. */
export function attach(chatId, listener, since = -1) {
  const job = JOBS.get(chatId);
  if (!job) return null;
  for (const ev of job.buffer) {
    if (ev._i > since) { try { listener(ev); } catch {} }
  }
  if (job.status !== "running") {
    try { listener({ type: "job_end", status: job.status, _i: job.seq }); } catch {}
    return { detach() {} };
  }
  job.subs.add(listener);
  return { detach() { job.subs.delete(listener); } };
}

export function stop(chatId) {
  const job = JOBS.get(chatId);
  if (!job) return false;
  try { job.controller.abort(); } catch {}
  job.status = "stopped";
  return true;
}

export function stopAll() {
  let n = 0;
  for (const id of [...JOBS.keys()]) if (stop(id)) n++;
  return n;
}
