/* ================= NEXUS — unified chat client ================= */
const $ = (s) => document.querySelector(s) || new Proxy({}, {
  get: (_, k) => (k === "classList" ? { add() {}, remove() {}, toggle() {}, contains: () => false }
    : k === "style" ? {} : k === "dataset" ? {}
    : k === "value" || k === "textContent" || k === "innerHTML" ? ""
    : k === "checked" ? false
    : k === "querySelector" || k === "querySelectorAll" ? () => null
    : k === "appendChild" || k === "insertAdjacentHTML" || k === "focus" || k === "remove" ? () => {}
    : undefined),
  set: () => true,
});

// Any uncaught boot error would leave a blank, dead page. Show it instead.
window.addEventListener("error", (e) => {
  const box = document.getElementById("bootErr");
  if (box) { box.style.display = "block"; box.textContent = "UI error: " + (e.message || e.error); }
  console.error("[nexus]", e.error || e.message);
});
window.addEventListener("unhandledrejection", (e) => console.error("[nexus] promise:", e.reason));
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
const uid = () => Math.random().toString(36).slice(2, 9);

const ATT = [];          // pending attachments (declared early: send() runs before the UI block)
const inp = $("#input");
let SW = { agents: new Map(), checks: 0, flags: 0, fixes: 0, swarmEl: null,
  reset(){}, add(){}, task(){}, done(){}, render(){}, critic(){}, pulse(){} };  // real one assigned below
const state = {
  chats: store.get("nexus.chats", []),
  cur: store.get("nexus.cur", null),
  models: [],
  model: store.get("nexus.model", ""),
  autoRoute: store.get("nexus.autoRoute", true),
  freeOnly: store.get("nexus.freeOnly", true),
  maxSteps: store.get("nexus.maxSteps", 40),
  ctrl: null,
  busy: false,
};

/* ---------------- markdown ---------------- */
function md(src) {
  const blocks = [];
  let s = String(src ?? "");
  s = s.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
    const i = blocks.length;
    blocks.push(`<pre><div class="code-head"><span>${esc(lang || "code")}</span>
      <button class="code-cp" data-code="${encodeURIComponent(code)}">copy</button></div><code>${esc(code.replace(/\n$/, ""))}</code></pre>`);
    return `\u0000B${i}\u0000`;
  });
  s = s.replace(/`([^`\n]+)`/g, (_, c) => { const i = blocks.length; blocks.push(`<code>${esc(c)}</code>`); return `\u0000B${i}\u0000`; });
  s = esc(s);

  // tables
  s = s.replace(/(^\|.+\|\s*$\n^\|[\s:|-]+\|\s*$\n(?:^\|.*\|\s*$\n?)*)/gm, (t) => {
    const rows = t.trim().split("\n").map((r) => r.replace(/^\||\|$/g, "").split("|").map((c) => c.trim()));
    const head = rows[0], body = rows.slice(2);
    return `<table><thead><tr>${head.map((h) => `<th>${h}</th>`).join("")}</tr></thead>` +
      `<tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
  });

  s = s.replace(/^### (.+)$/gm, "<h3>$1</h3>")
       .replace(/^## (.+)$/gm, "<h2>$1</h2>")
       .replace(/^# (.+)$/gm, "<h1>$1</h1>")
       .replace(/^&gt; (.+)$/gm, "<blockquote>$1</blockquote>")
       .replace(/^(?:---|\*\*\*)$/gm, "<hr>")
       .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
       .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
       .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  s = s.replace(/(?:^[-*] .+\n?)+/gm, (m) => `<ul>${m.trim().split("\n").map((l) => `<li>${l.replace(/^[-*] /, "")}</li>`).join("")}</ul>`);
  s = s.replace(/(?:^\d+\. .+\n?)+/gm, (m) => `<ol>${m.trim().split("\n").map((l) => `<li>${l.replace(/^\d+\. /, "")}</li>`).join("")}</ol>`);

  s = s.split(/\n{2,}/).map((p) => (/^<(h\d|ul|ol|pre|table|blockquote|hr)/.test(p.trim()) ? p : p.trim() ? `<p>${p.replace(/\n/g, "<br>")}</p>` : "")).join("");
  return s.replace(/\u0000B(\d+)\u0000/g, (_, i) => blocks[+i]);
}

document.addEventListener("click", (e) => {
  const b = e.target.closest(".code-cp");
  if (b) { navigator.clipboard.writeText(decodeURIComponent(b.dataset.code)); b.textContent = "copied!"; setTimeout(() => (b.textContent = "copy"), 1400); }
  const img = e.target.closest(".shot img");
  if (img) window.open(img.src, "_blank");
});

/* ---------------- toast ---------------- */
let tT;
function toast(m) { const t = $("#toast"); t.textContent = m; t.classList.add("show"); clearTimeout(tT); tT = setTimeout(() => t.classList.remove("show"), 2600); }

/* ---------------- chats ---------------- */
const curChat = () => state.chats.find((c) => c.id === state.cur);
function saveChats() { store.set("nexus.chats", state.chats.slice(0, 60)); store.set("nexus.cur", state.cur); }
function newChat() {
  const blank = state.chats.find((c) => !c.msgs.length);
  if (blank) { state.cur = blank.id; saveChats(); renderRail(); renderFeed(); $("#input").focus(); return; }
  const c = { id: uid(), title: "New", msgs: [], at: Date.now() };
  state.chats.unshift(c); state.cur = c.id; saveChats(); renderRail(); renderFeed();
  $("#input").focus();
}
function renderRail() {
  const w = $("#railChats"); w.innerHTML = "";
  const q = ($("#chatSearch")?.value || "").toLowerCase();
  state.chats
    .filter((c) => !q || (c.title || "").toLowerCase().includes(q))
    .slice(0, 40).forEach((c) => {
      const b = document.createElement("div");
      b.className = "rc" + (c.id === state.cur ? " on" : "");
      b.dataset.id = c.id;
      b.innerHTML = `<span>${esc((c.title || "N")[0].toUpperCase())}</span>
        <span class="rc-name">${esc(c.title || "New")}</span>
        <span class="rc-del" title="Delete">✕</span>
        <span class="rc-tip">${esc(c.title || "New")}</span>`;
      b.onclick = (e) => {
        if (e.target.classList.contains("rc-del")) {
          state.chats = state.chats.filter((x) => x.id !== c.id);
          if (state.cur === c.id) state.cur = state.chats[0]?.id || null;
          saveChats(); renderRail(); renderFeed();
          return;
        }
        state.cur = c.id; saveChats(); renderRail(); renderFeed();
      };
      w.appendChild(b);
    });
}

/* ---------------- feed ---------------- */
const feed = () => $("#feed");
function atBottom() { const f = feed(); return f.scrollHeight - f.scrollTop - f.clientHeight < 130; }
function toBottom(force) { const f = feed(); if (force || atBottom()) f.scrollTop = f.scrollHeight; }

function renderFeed() {
  const f = feed(); f.innerHTML = "";
  const c = curChat();
  if (!c || !c.msgs.length) { f.appendChild(heroEl()); return; }
  c.msgs.forEach((m) => {
    if (m.role === "user") {
      const t = typeof m.content === "string" ? m.content
        : (m.content.find((p) => p.type === "text")?.text || "");
      f.appendChild(userTurn(t.split("\n\n--- attached file:")[0], m._atts || []));
    }
    else {
      const { turn, body } = aiTurn();
      body.innerHTML = `<div class="md">${md(m.content)}</div>`;
      addActs(body, m.content);
      f.appendChild(turn);
    }
  });
  toBottom(true);
}
function heroEl() {
  const d = document.createElement("div");
  d.id = "hero";
  d.innerHTML = `<div class="hero-orb">◆</div><h1>What can I do for you?</h1>
    <p>I can chat, write and run code, browse the web, and control your computer.</p>
    <div class="hero-chips"></div>`;
  const chips = [
    ["💬", "Explain how JWT auth works"],
    ["⚡", "Build a snake game and test it"],
    ["🖥", "What's using my disk space?"],
    ["🌐", "Research the best free AI models right now"],
  ];
  const cw = d.querySelector(".hero-chips");
  chips.forEach(([i, t]) => {
    const b = document.createElement("button");
    b.className = "hchip"; b.textContent = `${i}  ${t}`;
    b.onclick = () => { $("#input").value = t; send(); };
    cw.appendChild(b);
  });
  return d;
}
function userTurn(text, atts = []) {
  const d = document.createElement("div");
  d.className = "turn usr";
  const bar = atts.length
    ? `<div class="ubar">${atts.map((a2) => a2.kind === "image" && a2.data
        ? `<span class="uatt">🖼 ${esc(a2.name)}<img src="${a2.data}"></span>`
        : `<span class="uatt">📎 ${esc(a2.name)}</span>`).join("")}</div>` : "";
  d.innerHTML = `<div>${bar}<div class="bub">${esc(text)}</div></div>`;
  return d;
}
function aiTurn() {
  const turn = document.createElement("div");
  turn.className = "turn ai";
  turn.innerHTML = `<div class="av">◆</div><div class="ai-body"></div>`;
  return { turn, body: turn.querySelector(".ai-body") };
}
function addActs(body, text) {
  const a = document.createElement("div");
  a.className = "acts";
  a.innerHTML = `<button class="act" data-a="copy">copy</button><button class="act" data-a="retry">retry</button>`;
  a.querySelector('[data-a="copy"]').onclick = () => { navigator.clipboard.writeText(text); toast("Copied"); };
  a.querySelector('[data-a="retry"]').onclick = () => {
    const c = curChat(); if (!c) return;
    while (c.msgs.length && c.msgs[c.msgs.length - 1].role !== "user") c.msgs.pop();
    const last = c.msgs.pop();
    saveChats(); renderFeed();
    if (last) { $("#input").value = last.content; send(); }
  };
  body.appendChild(a);
}

/* ---- inline log cards ---- */
const ICON = {
  update_plan: "📋", list_files: "🗂", read_file: "📄", write_file: "✍️", edit_file: "✏️", delete_file: "🗑",
  search_code: "🔎", run_command: "▶️", start_server: "🚀", stop_server: "⏹", list_processes: "📊",
  web_search: "🌐", fetch_url: "🔗", screenshot: "📸", browser_interact: "🖱",
  think_parallel: "🧠", delegate_parallel: "⚡", review_code: "🔍",
  read_own_code: "🪞", write_own_code: "🧬", patch_own_code: "🧬", self_test: "🧪", restart_app: "🔄",
  open_app: "🚀", close_app: "✖", list_apps: "🗔", open_path: "📂", find_files: "🔦", known_folders: "🗂",
  clipboard_read: "📋", clipboard_write: "📋", notify: "🔔", speak: "🔊", screen_capture: "🖥",
  system_stats: "📊", volume_control: "🔉", power_control: "⏻", schedule_task: "⏰", system_info: "🖥",
  cursor_screenshot: "👁", cursor_click: "🖱", cursor_move: "🖱", cursor_type: "⌨️", cursor_key: "⌨️",
  cursor_drag: "🖱", cursor_scroll: "🖱", list_windows: "🗔", focus_window: "🗔", os_control_status: "🖱",
  remember: "🧠", recall: "🧠", forget: "🧠", write_project_notes: "📓",
  spawn_subagents: "👥", undo_last_change: "↩️", list_checkpoints: "🕐", restore_checkpoint: "↩️",
  mcp_status: "🔌", mcp_add: "🔌", ask_user: "❓",
  use_skill: "🎓", list_skills: "🎓", create_skill: "🎓",
  git_status: "🌿", git_diff: "🔀", git_commit: "📦", git_worktree: "🌳",
  create_document: "📄", analyze_data: "📊", scaffold_project: "🏗", install_packages: "📥",
  android_status: "🤖", android_setup: "⬇️", android_create: "📱", android_build: "📱", android_install: "📲",
};
function argOf(n, a = {}) {
  if (n === "run_command" || n === "start_server") return "$ " + (a.command || "");
  if (n === "update_plan") return (a.steps || []).length + " steps";
  if (n === "web_search") return a.query || "";
  if (n === "cursor_click") return `(${a.x}, ${a.y})`;
  if (n === "cursor_type" || n === "speak") return (a.text || "").slice(0, 70);
  if (n === "cursor_key") return a.keys || "";
  if (n === "think_parallel") return (a.question || "").slice(0, 70);
  if (n === "spawn_subagents") return (a.tasks || []).map(t => t.name).join(", ").slice(0, 80);
  if (n === "remember") return (a.text || "").slice(0, 70);
  if (n === "recall") return a.query || "(all)";
  if (n === "ask_user") return (a.question || "").slice(0, 70);
  if (n === "use_skill" || n === "create_skill") return a.name || "";
  if (n === "git_commit") return (a.message || "").split("\n")[0].slice(0, 70);
  if (n === "git_worktree") return a.action + (a.name ? " " + a.name : "");
  if (n === "create_document") return `${a.kind} → ${a.outPath || ""}`;
  if (n === "analyze_data") return a.file || "";
  if (n === "scaffold_project") return `${a.kind} ${a.name || ""}`;
  if (n === "install_packages") return `${a.manager}: ${(a.packages || []).join(" ")}`.slice(0, 70);
  if (n === "android_create") return `${a.appName || a.dir} (${a.kind || "webview"})`;
  if (n === "android_build") return `${a.dir} ${a.variant || "debug"}`;
  if (n === "delegate_parallel") return (a.tasks || []).length + " parallel tasks";
  return a.path || a.file || a.name || a.target || a.pattern || a.url || "";
}
function logCard(body, name, args) {
  const d = document.createElement("div");
  d.className = "log run";
  d.innerHTML = `<div class="log-h"><span class="cv">▶</span><span class="ic">${ICON[name] || "🔧"}</span>
    <span class="nm">${esc(name)}</span><span class="ar">${esc(argOf(name, args))}</span><span class="ms"></span></div>
    <div class="log-b"><pre></pre></div>`;
  d.querySelector(".log-h").onclick = () => d.classList.toggle("open");
  body.appendChild(d);
  return d;
}
function closeCard(d, result, ms, image) {
  if (!d) return;
  const bad = /^ERROR|BLOCKED|FAIL|exit code: [1-9]/m.test(result || "");
  d.className = "log " + (bad ? "err" : "ok");
  d.querySelector(".ms").textContent = ms > 999 ? (ms / 1000).toFixed(1) + "s" : ms + "ms";
  d.querySelector("pre").textContent = String(result || "").slice(0, 6000);
  if (bad) d.classList.add("open");
  if (image) {
    const f = document.createElement("div");
    f.className = "shot";
    f.innerHTML = `<div class="shot-c">📸 what I see</div><a href="${image}" target="_blank"><img src="${image}" loading="lazy"></a>`;
    d.after(f);
  }
}
function planCard(body, steps) {
  let p = body.querySelector(".plan");
  if (!p) { p = document.createElement("div"); p.className = "plan"; body.appendChild(p); }
  const ic = { pending: "○", active: "◉", done: "✔", failed: "✕" };
  const done = steps.filter((s) => s.status === "done").length;
  p.innerHTML = `<div class="plan-h">Plan <span>${done}/${steps.length}</span>
      <div class="plan-bar"><i style="width:${Math.round(done / steps.length * 100)}%"></i></div></div>` +
    steps.map((s) => `<div class="pstep ${s.status}"><span class="pi">${ic[s.status] || "○"}</span><span>${esc(s.title)}</span></div>`).join("");
  return p;
}
function termCard(body, cmd) {
  const d = document.createElement("div");
  d.className = "term";
  d.innerHTML = `<div class="term-h"><span class="dots"><i></i><i></i><i></i></span><span>${esc(cmd)}</span></div>
    <div class="term-b"><span class="cursor"></span></div>`;
  body.appendChild(d);
  return d;
}

/* ---------------- send ---------------- */
async function send() {
  if (state.busy) return;
  const inp = $("#input");
  const text = inp.value.trim();
  if (!text) return;
  if (!curChat()) newChat();
  const chat = curChat();

  inp.value = ""; inp.style.height = "auto";
  const atts = ATT.slice();
  ATT.length = 0; renderAtts();

  // vision-capable content parts when images are attached
  let payload = text;
  if (atts.length) {
    const imgs = atts.filter((a2) => a2.kind === "image");
    const docs = atts.filter((a2) => a2.kind !== "image");
    let t = text;
    if (docs.length) {
      t += "\n\n" + docs.map((d) => `--- attached file: ${d.name} ---\n${d.text.slice(0, 40000)}`).join("\n\n");
    }
    payload = imgs.length
      ? [{ type: "text", text: t }, ...imgs.map((i) => ({ type: "image_url", image_url: { url: i.data } }))]
      : t;
  }
  chat.msgs.push({ role: "user", content: payload, _atts: atts.map((a2) => ({ name: a2.name, kind: a2.kind, data: a2.kind === "image" ? a2.data : null })) });
  if (chat.title === "New") { chat.title = text.slice(0, 30); renderRail(); }
  saveChats();

  $("#hero")?.remove();
  feed().appendChild(userTurn(text, atts));
  toBottom(true);

  const { turn, body } = aiTurn();
  feed().appendChild(turn);
  const thinking = document.createElement("div");
  thinking.className = "think";
  thinking.innerHTML = `<span class="dots"><i></i><i></i><i></i></span><span class="shimmer">Thinking…</span>`;
  body.appendChild(thinking);
  toBottom(true);

  state.busy = true;
  $("#sendBtn").style.display = "none";
  $("#stopBtn").style.display = "grid";
  $("#statusDot").classList.add("live");
  state.ctrl = new AbortController();

  const t0 = performance.now();
  let acc = "", mdNode = null, reasonNode = null, plan = null;
  const cards = {}, terms = {};
  let steps = 0, tools = 0;

  const setThinking = (label) => {
    if (thinking.isConnected) thinking.querySelector(".shimmer").textContent = label;
  };
  const ensureMd = () => {
    if (!mdNode) { mdNode = document.createElement("div"); mdNode.className = "md"; body.appendChild(mdNode); }
    return mdNode;
  };

  try {
    const res = await fetch("/api/smart", {
      method: "POST", headers: { "Content-Type": "application/json" },
      signal: state.ctrl.signal,
      body: JSON.stringify({
        chatId: chat.id, title: text.slice(0, 60),
        messages: chat.msgs.map((m) => ({ role: m.role, content: m.content })),
        model: state.autoRoute ? undefined : state.model,
        maxSteps: state.maxSteps, freeOnly: state.freeOnly,
      }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const rd = res.body.getReader(), dec = new TextDecoder();
    let buf = "";
    while (true) {
      const { done, value } = await rd.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n\n"); buf = parts.pop();
      for (const p of parts) {
        const l = p.replace(/^data: /, "").trim();
        if (!l) continue;
        let ev; try { ev = JSON.parse(l); } catch { continue; }
        if (ev._i !== undefined) chat._seen = ev._i;

        switch (ev.type) {
          case "routing": setThinking("Deciding how to handle this…"); break;
          case "route": {
            const pill = $("#routePill");
            pill.className = "route-pill show " + ev.route;
            pill.textContent = ev.route === "agent" ? `⚡ agent · ${ev.why}` : `💬 chat · ${ev.why}`;
            setThinking(ev.route === "agent" ? "Planning…" : "Writing…");
            break;
          }
          case "model": case "chain":
            $("#metaRight").textContent = (ev.model || ev.chain?.[0] || "").split("/").pop();
            break;
          case "model_switch":
            $("#metaRight").textContent = ev.model.split("/").pop() + " (failover)";
            break;
          case "step":
            steps = ev.step; setThinking(`Step ${ev.step}…`);
            $("#metaLeft").textContent = `step ${ev.step} · ${tools} tools`;
            break;
          case "plan":
            thinking.remove();
            plan = planCard(body, ev.steps);
            toBottom();
            break;
          case "reasoning":
            if (!reasonNode) {
              reasonNode = document.createElement("div");
              reasonNode.className = "reason";
              reasonNode.innerHTML = `<div class="rh">reasoning</div><span class="rt"></span>`;
              body.insertBefore(reasonNode, thinking.isConnected ? thinking : null);
            }
            reasonNode.querySelector(".rt").textContent += ev.text;
            toBottom();
            break;
          case "tool_start":
            thinking.remove();
            tools++;
            SW.task(ev.subagent ? "sub:" + ev.subagent : "main", ev.name + " " + argOf(ev.name, ev.args));
            cards[ev.id] = logCard(body, ev.name, ev.args);
            setThinking(ev.name);
            toBottom();
            break;
          case "tool_end":
            closeCard(cards[ev.id], ev.result, ev.ms, ev.image);
            $("#metaLeft").textContent = `step ${steps} · ${tools} tools`;
            toBottom();
            break;
          case "batch": {
            const d = document.createElement("div");
            d.className = "log ok";
            d.innerHTML = `<div class="log-h"><span class="cv">▶</span><span class="ic">⚡</span>
              <span class="nm">${ev.n} tools in parallel</span><span class="ar">${esc(ev.names.join(", "))}</span></div>
              <div class="log-b"><pre>${esc(ev.names.join("\n"))}</pre></div>`;
            d.querySelector(".log-h").onclick = () => d.classList.toggle("open");
            body.appendChild(d); toBottom();
            break;
          }
          case "term_open":
            thinking.remove();
            terms[ev.id] = termCard(body, ev.cmd);
            toBottom();
            break;
          case "term_data": {
            const t = terms[ev.id]; if (!t) break;
            const b = t.querySelector(".term-b");
            const sp = document.createElement("span");
            if (ev.stream === "stderr") sp.className = "e";
            sp.textContent = ev.text;
            b.insertBefore(sp, b.querySelector(".cursor"));
            b.scrollTop = b.scrollHeight;
            toBottom();
            break;
          }
          case "term_close": {
            const t = terms[ev.id]; if (!t) break;
            t.querySelector(".cursor")?.remove();
            const x = document.createElement("div");
            x.className = "term-x " + (ev.code === 0 ? "ok" : "bad");
            x.textContent = `exit ${ev.code}${ev.timedOut ? " (timed out)" : ""}`;
            t.appendChild(x);
            break;
          }
          case "critic_on":
            SW.reset(); SW.add("main", "primary agent", "run");
            SW.pulse(true);
            SW.critic({ raw: "🛡 supervisor online — watching every step", cls: "check" });
            break;
          case "thinking":
            setThinking(`Waiting on ${String(ev.model||"").split("/").pop()} · ${Math.round(ev.ms/1000)}s`);
            if (!thinking.isConnected) body.appendChild(thinking);
            SW.critic({ raw: `⏳ step ${ev.step} · waiting ${Math.round(ev.ms/1000)}s on <code>${esc(String(ev.model||"").split("/").pop())}</code>`, cls: "check" });
            break;
          case "trying_model":
            $("#metaRight").textContent = `${String(ev.model).split("/").pop()} (${ev.n}/${ev.of})`;
            break;
          case "critic_check":
            SW.checks++;
            $("#swChecks").textContent = SW.checks;
            SW.critic({ raw: `<span class="ok">▸</span> step ${ev.step} · ${ev.checks} checks on <code>${esc(ev.watching)}</code>`, cls: "check" });
            break;
          case "critic_clear":
            SW.critic({ raw: `<span class="ok">✓</span> step ${ev.step} clean — no loops, no stalls`, cls: "check" });
            break;
          case "step_error": {
            thinking.remove();
            const d = document.createElement("div");
            d.className = "log " + (ev.recovering ? "run" : "err");
            d.innerHTML = `<div class="log-h"><span class="ic">${ev.recovering ? "🔄" : "⚠️"}</span>
              <span class="nm">${ev.recovering ? "internal error — recovering" : "internal error"}</span>
              <span class="ar">${esc(String(ev.error).slice(0, 90))}</span></div>`;
            body.appendChild(d); toBottom();
            SW.critic({ raw: `⚠️ recovered from: ${esc(String(ev.error).slice(0, 70))}`, cls: "fix" });
            break;
          }
          case "critic_thinking":
            SW.add("critic", "CRITIC reviewing · " + (ev.model || "").split("/").pop(), "run");
            $("#swModel").textContent = (ev.model || "").split("/").pop().slice(0, 14);
            SW.critic({ raw: `🧠 deep review by <code>${esc((ev.model||"").split("/").pop())}</code>…`, cls: "think" });
            break;
          case "critic": {
            SW.done("critic", ev.level === "ok" ? "done" : "fail");
            SW.critic(ev);
            if (ev.level === "ok") break;
            thinking.remove();
            const d = document.createElement("div");
            d.className = "critic-card " + (ev.level || "medium");
            d.innerHTML = `<div class="ch">🛡 supervisor ${ev.auto ? "· auto-check" : "· senior review"}${ev.kind ? " · " + esc(ev.kind) : ""}${ev.autofix ? " · 🔧 auto-fixing" : ""}</div>
              <div>${esc(ev.issue || "")}</div>` +
              (ev.guidance ? `<div class="cg"><b>Do instead:</b> ${esc(ev.guidance)}</div>` : "");
            body.appendChild(d); toBottom();
            break;
          }
          case "autofix_start":
            SW.fixes++; $("#swFixes").textContent = SW.fixes;
            SW.critic({ raw: `🔧 auto-fixing with <code>${esc(ev.tool)}</code>`, cls: "fix" });
            SW.add("critic", "CRITIC auto-fixing · " + ev.tool, "run");
            body.insertAdjacentHTML("beforeend",
              `<div class="log run"><div class="log-h"><span class="ic">🔧</span>
               <span class="nm">supervisor auto-fix</span><span class="ar">${esc(ev.tool)}</span></div></div>`);
            toBottom();
            break;
          case "autofix_done":
            SW.done("critic", ev.ok ? "done" : "fail");
            body.querySelectorAll(".log.run").forEach((n) => {
              if (n.textContent.includes("auto-fix")) n.className = "log " + (ev.ok ? "ok" : "err");
            });
            break;
          case "learned": {
            const d = document.createElement("div");
            d.className = "learned";
            d.innerHTML = `<div class="lh">🧠 learned for next time</div><ul>${
              ev.lessons.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>`;
            body.appendChild(d); toBottom();
            break;
          }
          case "subagents_start": {
            thinking.remove();
            const d = document.createElement("div");
            d.className = "swarm";
            d.id = "swarm-" + Date.now();
            const waves = (ev.waves || [ev.names]).map((w, i) =>
              `<div class="sw-wave"><b>wave ${i + 1}</b>${w.map((n) =>
                `<span class="sw-chip" data-a="${esc(n)}">${esc(n)}</span>`).join("")}</div>`).join("");
            d.innerHTML = `<div class="swarm-h">👥 swarm — ${ev.names.length} agents${
              ev.waves && ev.waves.length > 1 ? ` · ${ev.waves.length} waves` : " in parallel"}</div>${waves}`;
            body.appendChild(d);
            SW.swarmEl = d;
            ev.names.forEach((n) => SW.add("sub:" + n, n, "run"));
            toBottom();
            break;
          }
          case "wave_start":
            SW.swarmEl?.querySelectorAll(`.sw-wave`)[ev.wave - 1]?.classList.add("active");
            SW.critic({ raw: `👥 wave ${ev.wave}/${ev.of} — ${ev.names.length} agents, ${ev.concurrency} at a time`, cls: "check" });
            break;
          case "subagent_done": {
            const c = SW.swarmEl?.querySelector(`.sw-chip[data-a="${CSS.escape(ev.name)}"]`);
            if (c) { c.classList.add(ev.ok ? "ok" : "fail"); c.title = `${(ev.ms/1000).toFixed(1)}s`; }
            SW.done("sub:" + ev.name, ev.ok ? "done" : "fail");
            break;
          }
          case "swarm_merge":
            if (SW.swarmEl) SW.swarmEl.insertAdjacentHTML("beforeend",
              `<div class="sw-merge">📦 merged ${ev.moved} file(s) into the workspace${
                ev.skipped ? ` · ${ev.skipped} skipped` : ""}</div>`);
            break;
          case "subagents_end": {
            (ev.results || []).forEach((r) => SW.done("sub:" + r.name, r.ok ? "done" : "fail"));
            if (SW.swarmEl && ev.speedup) SW.swarmEl.insertAdjacentHTML("beforeend",
              `<div class="sw-merge">⚡ ${(ev.ms/1000).toFixed(1)}s wall-clock · ~${ev.speedup}x faster than serial</div>`);
            SW.swarmEl = null;
            const cards2 = body.querySelectorAll(".log.run");
            const last = cards2[cards2.length - 1];
            if (last) { last.className = "log ok"; }
            break;
          }
          case "ask": {
            thinking.remove();
            const d = document.createElement("div");
            d.className = "ask-box";
            d.innerHTML = `<div class="ask-q">❓ ${esc(ev.question)}</div>` +
              (ev.options?.length ? `<div class="ask-opts">${ev.options.map(o =>
                `<button class="ask-o">${esc(o)}</button>`).join("")}</div>` : "");
            d.querySelectorAll(".ask-o").forEach(b => b.onclick = () => { $("#input").value = b.textContent; send(); });
            body.appendChild(d); toBottom();
            break;
          }
          case "artifact": {
            thinking.remove();
            const d = document.createElement("div");
            d.className = "artifact";
            d.innerHTML = `<span class="art-ic">📱</span>
              <div class="art-body"><b>APK ready</b>
                <div class="art-path">${esc(ev.path)}</div>
                <div class="art-meta">${ev.sizeMB} MB · debug-signed · installs on any phone</div></div>
              <a class="art-dl" href="/api/download?path=${encodeURIComponent(ev.path)}" download>Download</a>`;
            body.appendChild(d); toBottom();
            break;
          }
          case "skill":
            body.insertAdjacentHTML("beforeend",
              `<div class="log ok"><div class="log-h"><span class="ic">🎓</span><span class="nm">skill loaded</span>
               <span class="ar">${esc(ev.name)}</span></div></div>`);
            break;
          case "mcp_tools":
            $("#metaRight").textContent = `+${ev.n} MCP tools`;
            break;
          case "hook":
            body.insertAdjacentHTML("beforeend",
              `<div class="log ok"><div class="log-h"><span class="ic">🪝</span><span class="nm">hook</span>
               <span class="ar">${esc(ev.text.slice(0, 90))}</span></div></div>`);
            break;
          case "self_edit":
            body.insertAdjacentHTML("beforeend",
              `<div class="log ${ev.ok ? "ok" : "err"}"><div class="log-h"><span class="ic">🧬</span>
               <span class="nm">self-modified</span><span class="ar">${esc(ev.file)}${ev.ok ? "" : " (reverted)"}</span></div></div>`);
            break;
          case "compacted":
            body.insertAdjacentHTML("beforeend",
              `<div class="log ok"><div class="log-h"><span class="ic">🗜</span>
               <span class="nm">context compacted</span><span class="ar">~${(ev.tokens / 1000).toFixed(0)}k tokens</span></div></div>`);
            break;
          case "delta":
            thinking.remove();
            acc += ev.text;
            ensureMd().innerHTML = md(acc);
            toBottom();
            break;
          case "model_error": {
            const d = document.createElement("div");
            d.className = "log " + (ev.recovering ? "run" : "err");
            d.innerHTML = `<div class="log-h"><span class="ic">${ev.recovering ? "🔄" : "⚠️"}</span>
              <span class="nm">${ev.recovering ? "model failed — switching" : "model error"}</span>
              <span class="ar">${esc(String(ev.error).slice(0, 90))}</span></div>`;
            body.appendChild(d); toBottom();
            break;
          }
          case "error":
            thinking.remove();
            ensureMd().innerHTML = `<div class="err-banner"><span>⚠️</span><div><b>${esc(ev.error)}</b></div></div>`;
            break;
          case "done":
            thinking.remove();
            break;
          case "job_end":
            thinking.remove();
            break;
        }
      }
    }
  } catch (e) {
    thinking.remove();
    if (e.name !== "AbortError") ensureMd().innerHTML = `<div class="err-banner"><span>⚠️</span><div><b>${esc(e.message)}</b></div></div>`;
  }

  thinking.remove();
  const secs = ((performance.now() - t0) / 1000).toFixed(1);
  $("#metaLeft").textContent = `done in ${secs}s${tools ? ` · ${tools} tools` : ""}`;
  if (acc.trim()) { chat.msgs.push({ role: "assistant", content: acc }); saveChats(); addActs(body, acc); }

  state.busy = false;
  state.ctrl = null;
  $("#sendBtn").style.display = "grid";
  $("#stopBtn").style.display = "none";
  $("#statusDot").classList.remove("live");
  SW.done("main", "done");
  toBottom();
}

/* ---------------- models ---------------- */
async function loadModels() {
  try {
    const r = await fetch("/api/models");
    const d = await r.json();
    if (!r.ok || d?.error) throw new Error(d?.error || `HTTP ${r.status}`);
    if (!Array.isArray(d) || !d.length) throw new Error("No models returned");
    state.models = d;
    if (!state.model || !d.some((m) => m.id === state.model)) state.model = d[0].id;
    renderModels();
    $("#modelName").textContent = state.autoRoute ? "auto" : state.model.split("/").pop();
  } catch (e) {
    $("#modelName").textContent = "error";
    showErr("Could not load models", e.message);
  }
}
function renderModels() {
  const q = ($("#modelSearch").value || "").toLowerCase();
  const list = $("#modelList"); list.innerHTML = "";
  state.models
    .filter((m) => !state.freeOnly || m.tier === "free")
    .filter((m) => !q || m.id.toLowerCase().includes(q) || (m.name || "").toLowerCase().includes(q))
    .slice(0, 90)
    .forEach((m) => {
      const d = document.createElement("div");
      d.className = "mi" + (m.id === state.model ? " on" : "");
      d.innerHTML = `<span class="mn">${esc(m.name || m.id)}</span>
        ${m.providerLabel && m.provider !== "xkiro" ? `<span class="tg" style="opacity:.7">${esc(m.provider)}</span>` : ""}
        ${m.vision ? "<span>👁</span>" : ""}${m.reasoning ? "<span>🧠</span>" : ""}
        <span class="tg ${m.tier}" ${m.local ? 'style="color:#3ddc97;border-color:#3ddc9755"' : ""}>${m.tier}</span>`;
      d.onclick = () => {
        state.model = m.id; state.autoRoute = false;
        $("#autoRoute").checked = false;
        store.set("nexus.model", m.id); store.set("nexus.autoRoute", false);
        $("#modelName").textContent = m.id.split("/").pop();
        renderModels(); $("#modelSheet").classList.remove("open");
      };
      list.appendChild(d);
    });
}

/* ---------------- diagnostics / system ---------------- */
function showErr(msg, detail) {
  const f = feed();
  const d = document.createElement("div");
  d.className = "err-banner";
  d.innerHTML = `<span>⚠️</span><div style="flex:1"><b>${esc(msg)}</b>
    ${detail ? `<div class="eb-fix">${esc(detail)}</div>` : ""}</div><button class="ebx">✕</button>`;
  d.querySelector(".ebx").onclick = () => d.remove();
  f.prepend(d);
}
async function loadSystem() {
  try {
    const s = await (await fetch("/api/system")).json();
    const os = await (await fetch("/api/os/status")).json().catch(() => ({}));
    const row = (k, v, ok) => `<div class="r"><span>${esc(k)}</span><b class="${ok === undefined ? "" : ok ? "y" : "n"}">${esc(String(v ?? "—"))}</b></div>`;
    $("#sysBox").innerHTML =
      row("platform", s.platform) + row("shell", (s.shell || "").split(/[\\/]/).pop()) +
      row("cores", s.cpus) + row("memory", s.memGB + " GB") +
      row("full PC access", s.fullAccess ? "ON" : "off", s.fullAccess) +
      row("cursor control", os.available ? "ready" : "not installed", !!os.available) +
      Object.entries(s.toolchain || {}).map(([k, v]) => row(k, v ? String(v).slice(0, 28) : "missing", !!v)).join("");
    $("#fullAccess").checked = !!s.fullAccess;
    $("#railJarvis").classList.toggle("on", !!s.fullAccess);
  } catch {}
}
function streamSSE(url, opts, onEv) {
  return fetch(url, opts).then(async (r) => {
    const rd = r.body.getReader(), dec = new TextDecoder(); let buf = "";
    while (true) {
      const { done, value } = await rd.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      const parts = buf.split("\n\n"); buf = parts.pop();
      for (const p of parts) {
        const l = p.replace(/^data: /, "").trim(); if (!l) continue;
        try { onEv(JSON.parse(l)); } catch {}
      }
    }
  });
}
function logLine(text, cls) {
  const b = $("#logBox");
  const d = document.createElement("div");
  if (cls) d.className = cls;
  d.textContent = text;
  b.appendChild(d);
  while (b.children.length > 300) b.firstChild.remove();
  b.scrollTop = b.scrollHeight;
}
try {
  const es = new EventSource("/api/logs");
  es.onmessage = (m) => {
    let ev; try { ev = JSON.parse(m.data); } catch { return; }
    if (ev.type === "log") logLine(ev.text, ev.level === "error" ? "e" : ev.level === "warn" ? "w" : "");
  };
} catch {}

/* ---------------- wiring ---------------- */
$("#sendBtn").onclick = send;
$("#stopBtn").onclick = async () => {
  const c = curChat();
  if (c) { try { await fetch(`/api/jobs/${encodeURIComponent(c.id)}/stop`, { method: "POST" }); } catch {} }
  state.ctrl?.abort();
  toast("Stopped");
};
$("#newChat").onclick = newChat;
inp.addEventListener("input", () => { inp.style.height = "auto"; inp.style.height = Math.min(inp.scrollHeight, 190) + "px"; });
inp.addEventListener("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });

$("#modelBtn").onclick = () => { $("#modelSheet").classList.add("open"); renderModels(); renderProviders(); renderCloud(); $("#modelSearch").focus(); };
$("#modelSearch").oninput = renderModels;
$("#railSettings").onclick = () => { $("#settingsSheet").classList.add("open"); loadSystem(); };
document.querySelectorAll(".sheet-x").forEach((b) => (b.onclick = () => b.closest(".sheet").classList.remove("open")));
document.querySelectorAll(".sheet").forEach((s) => (s.onclick = (e) => { if (e.target === s) s.classList.remove("open"); }));
document.addEventListener("keydown", (e) => { if (e.key === "Escape") document.querySelectorAll(".sheet.open").forEach((s) => s.classList.remove("open")); });

$("#autoRoute").checked = state.autoRoute;
$("#autoRoute").onchange = (e) => {
  state.autoRoute = e.target.checked; store.set("nexus.autoRoute", state.autoRoute);
  $("#modelName").textContent = state.autoRoute ? "auto" : state.model.split("/").pop();
};
$("#freeOnly").checked = state.freeOnly;
$("#freeOnly").onchange = (e) => { state.freeOnly = e.target.checked; store.set("nexus.freeOnly", state.freeOnly); renderModels(); };
$("#maxSteps").value = state.maxSteps; $("#msVal").textContent = state.maxSteps;
$("#maxSteps").oninput = (e) => { state.maxSteps = +e.target.value; $("#msVal").textContent = state.maxSteps; store.set("nexus.maxSteps", state.maxSteps); };

async function setJarvis(on) {
  if (on && !confirm("Enable JARVIS mode?\n\nI'll be able to read/write files anywhere, launch apps, and control your mouse and keyboard.")) return false;
  const j = await (await fetch("/api/fullaccess", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: on }) })).json();
  $("#fullAccess").checked = j.fullAccess;
  $("#railJarvis").classList.toggle("on", j.fullAccess);
  toast(j.fullAccess ? "🤖 JARVIS mode on — full PC control" : "Restricted to workspace");
  loadSystem();
  return j.fullAccess;
}
$("#fullAccess").onchange = (e) => setJarvis(e.target.checked).then((v) => (e.target.checked = v));
$("#railJarvis").onclick = () => setJarvis(!$("#fullAccess").checked);

$("#railTheme").onclick = () => {
  const t = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = t; store.set("nexus.theme", t);
};
document.documentElement.dataset.theme = store.get("nexus.theme", "dark");

$("#btnDiag").onclick = async () => {
  const h = await (await fetch("/api/health")).json();
  toast(h.upstream ? `✓ ${h.models} models (${h.free} free)` : "✖ " + (h.error || "failed"));
  if (h.upstream) loadModels();
  loadSystem();
};
$("#btnBrowser").onclick = () => {
  toast("Installing Chromium…");
  streamSSE("/api/setup/browser", { method: "POST" }, (ev) => {
    if (ev.type === "data") logLine(ev.text.trim());
    if (ev.type === "done") { toast(ev.ok ? "Browser ready ✓" : "Install failed"); loadSystem(); }
  });
};
$("#btnOsCtl").onclick = () => {
  toast("Installing cursor control…");
  streamSSE("/api/os/install", { method: "POST" }, (ev) => {
    if (ev.type === "data") logLine(ev.text.trim());
    if (ev.type === "done") { toast(ev.ok ? "Cursor control ready ✓" : "Failed — see logs"); loadSystem(); }
  });
};
$("#btnExport").onclick = () => {
  const b = new Blob([JSON.stringify(state.chats, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(b); a.download = "nexus-chats.json"; a.click();
};
$("#btnClear").onclick = () => {
  if (!confirm("Delete all chats?")) return;
  state.chats = []; state.cur = null; saveChats(); renderRail(); renderFeed(); toast("Cleared");
};

/* boot */
// repair anything saved by an older version before touching it
state.chats = (Array.isArray(state.chats) ? state.chats : [])
  .filter((c) => c && typeof c === "object")
  .map((c) => ({ ...c, id: c.id || uid(), title: c.title || "New", msgs: Array.isArray(c.msgs) ? c.msgs : [] }));
state.chats = state.chats.filter((c, i) => c.msgs.length || i === 0);
if (!state.chats.length) newChat(); else { renderRail(); renderFeed(); }
loadModels(); loadSystem();
inp.focus();

/* ================= SIDEBAR ================= */
const rail = $("#rail");
const setRail = (open) => {
  rail.classList.toggle("open", open);
  store.set("nexus.railOpen", open);
};
setRail(store.get("nexus.railOpen", false));
$("#railToggle").onclick = () => setRail(!rail.classList.contains("open"));
$("#chatSearch").oninput = renderRail;
document.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "b") { e.preventDefault(); setRail(!rail.classList.contains("open")); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setRail(true); $("#chatSearch").focus(); }
});

/* ================= ATTACHMENTS ================= */
const MAX_MB = 20;
const TEXTY = /\.(txt|md|csv|json|js|ts|jsx|tsx|py|java|c|cpp|h|go|rs|rb|php|sh|yml|yaml|xml|html|css|sql|toml|ini|env|log)$/i;

function renderAtts() {
  const bar = $("#attachBar");
  bar.innerHTML = "";
  ATT.forEach((a, i) => {
    const d = document.createElement("div");
    d.className = "att";
    d.innerHTML = (a.kind === "image" ? `<img src="${a.data}">` : `<span>📎</span>`) +
      `<span class="an">${esc(a.name)}</span><span class="asz">${(a.size / 1024).toFixed(0)}kb</span>
       <button class="ax" title="remove">✕</button>`;
    d.querySelector(".ax").onclick = () => { ATT.splice(i, 1); renderAtts(); };
    bar.appendChild(d);
  });
}

async function addFiles(files) {
  for (const f of Array.from(files)) {
    if (f.size > MAX_MB * 1024 * 1024) { toast(`${f.name} is over ${MAX_MB}MB`); continue; }
    if (ATT.length >= 10) { toast("Max 10 attachments"); break; }
    const isImg = f.type.startsWith("image/");
    if (isImg) {
      const data = await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result); fr.readAsDataURL(f); });
      ATT.push({ name: f.name, size: f.size, kind: "image", data });
    } else if (TEXTY.test(f.name) || f.type.startsWith("text/")) {
      const text = await f.text();
      ATT.push({ name: f.name, size: f.size, kind: "text", text });
    } else {
      // binary: upload to the workspace so the agent's tools can open it
      const fd = new FormData();
      fd.append("file", f);
      try {
        const r = await (await fetch("/api/upload", { method: "POST", body: fd })).json();
        ATT.push({ name: f.name, size: f.size, kind: "file", text: `(saved to workspace at ${r.path} — use your file tools to open it)` });
      } catch { toast("Upload failed: " + f.name); }
    }
  }
  renderAtts();
}

$("#attachBtn").onclick = () => $("#fileInput").click();
$("#fileInput").onchange = (e) => { addFiles(e.target.files); e.target.value = ""; };
$("#input").addEventListener("paste", (e) => {
  const items = [...(e.clipboardData?.items || [])].filter((i) => i.kind === "file");
  if (items.length) { e.preventDefault(); addFiles(items.map((i) => i.getAsFile()).filter(Boolean)); }
});
const comp = $("#composer");
["dragenter", "dragover"].forEach((ev) => comp.addEventListener(ev, (e) => { e.preventDefault(); comp.classList.add("drag"); }));
["dragleave", "drop"].forEach((ev) => comp.addEventListener(ev, (e) => { e.preventDefault(); comp.classList.remove("drag"); }));
comp.addEventListener("drop", (e) => { if (e.dataTransfer?.files?.length) addFiles(e.dataTransfer.files); });

/* ================= CONNECTORS ================= */
const CONNECTORS = [
  { id: "filesystem", ic: "📁", name: "Files", desc: "Read/write any folder", cmd: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "~"] },
  { id: "github", ic: "🐙", name: "GitHub", desc: "Repos, issues, PRs", cmd: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: ["GITHUB_PERSONAL_ACCESS_TOKEN"] },
  { id: "postgres", ic: "🐘", name: "Postgres", desc: "Query your database", cmd: "npx", args: ["-y", "@modelcontextprotocol/server-postgres"], needsArg: "connection string" },
  { id: "sqlite", ic: "🗃", name: "SQLite", desc: "Local database files", cmd: "npx", args: ["-y", "@modelcontextprotocol/server-sqlite"], needsArg: "db path" },
  { id: "slack", ic: "💬", name: "Slack", desc: "Read & post messages", cmd: "npx", args: ["-y", "@modelcontextprotocol/server-slack"], env: ["SLACK_BOT_TOKEN"] },
  { id: "memory", ic: "🧠", name: "Knowledge graph", desc: "Persistent entity memory", cmd: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] },
  { id: "puppeteer", ic: "🌐", name: "Browser", desc: "Extra web automation", cmd: "npx", args: ["-y", "@modelcontextprotocol/server-puppeteer"] },
  { id: "gdrive", ic: "📄", name: "Google Drive", desc: "Search & read docs", cmd: "npx", args: ["-y", "@modelcontextprotocol/server-gdrive"] },
];

async function renderConnectors() {
  let live = [];
  try { live = (await (await fetch("/api/mcp")).json()).servers || []; } catch {}
  const on = new Set(live.filter((s) => s.ready).map((s) => s.name));
  const box = $("#connList"); box.innerHTML = "";
  CONNECTORS.forEach((c) => {
    const d = document.createElement("button");
    d.className = "conn" + (on.has(c.id) ? " on" : "");
    d.innerHTML = `<span class="conn-ic">${c.ic}</span>
      <span class="conn-b"><div class="conn-n">${c.name}</div><div class="conn-d">${c.desc}</div></span>
      <span class="conn-s">${on.has(c.id) ? "on" : "add"}</span>`;
    d.onclick = () => connect(c);
    box.appendChild(d);
  });
  $("#connStatus").textContent = live.length
    ? live.map((s) => `${s.name}: ${s.ready ? s.tools.length + " tools" : "down"}`).join("\n")
    : "No connectors active yet.";
}

async function connect(c) {
  const args = [...c.args];
  if (c.needsArg) {
    const v = prompt(`${c.name} — enter ${c.needsArg}:`);
    if (!v) return;
    args.push(v);
  }
  const env = {};
  for (const k of c.env || []) {
    const v = prompt(`${c.name} — ${k}:`);
    if (!v) return;
    env[k] = v;
  }
  $("#connStatus").textContent = `Connecting ${c.name}…`;
  try {
    const r = await (await fetch("/api/mcp/add", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: c.id, command: c.cmd, args, env }),
    })).json();
    toast(r.ok ? `${c.name} connected — ${r.tools} tools` : `Failed: ${(r.error || "").slice(0, 60)}`);
    $("#connStatus").textContent = r.ok ? `${c.name}: ${r.tools} tools ready` : String(r.error || "failed");
    renderConnectors();
  } catch (e) { toast("Failed: " + e.message); }
}

$("#railConnect").onclick = () => { $("#connectSheet").classList.add("open"); renderConnectors(); };
$("#mcpAdd").onclick = async () => {
  const name = $("#mcpName").value.trim(), command = $("#mcpCmd").value.trim();
  if (!name || !command) return toast("name and command required");
  const args = $("#mcpArgs").value.trim().split(/\s+/).filter(Boolean);
  const r = await (await fetch("/api/mcp/add", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, command, args }),
  })).json();
  toast(r.ok ? `${name}: ${r.tools} tools` : "Failed");
  renderConnectors();
};

/* ================= SWARM MONITOR ================= */
SW = {
  agents: new Map(), swarmEl: null,
  reset() {
    this.agents.clear(); this.checks = 0; this.flags = 0; this.fixes = 0;
    $("#swChecks").textContent = "0"; $("#swFlags").textContent = "0"; $("#swFixes").textContent = "0";
    this.render(); $("#swCritic").innerHTML = "";
    if (!store.get("nexus.swPinned", false)) return;
  },
  add(id, label, status) {
    const cur = this.agents.get(id) || { started: Date.now(), tools: 0 };
    this.agents.set(id, { ...cur, label, status });
    this.render();
  },
  task(id, t) { const a = this.agents.get(id); if (a) { a.task = t; a.tools = (a.tools || 0) + 1; this.render(); } },
  done(id, status) { const a = this.agents.get(id); if (a) { a.status = status; this.render(); } },
  render() {
    const list = [...this.agents.entries()];
    const live = list.filter(([, a]) => a.status === "run").length;
    $("#swarmN").textContent = live;
    $("#swarmBtn").classList.toggle("busy", live > 0);
    const box = $("#swList");
    if (!list.length) { box.innerHTML = '<div class="sw-empty">Idle — no agents running.</div>'; return; }
    box.innerHTML = list.map(([id, a]) => `
      <div class="sw-agent ${a.status}">
        <div class="sw-n"><span class="sp"></span>${esc(a.label)}</div>
        ${a.task ? `<div class="sw-t">${esc(a.task)}</div>` : ""}
        <div class="sw-m">${a.tools || 0} tools · ${((Date.now() - a.started) / 1000).toFixed(0)}s · ${a.status}</div>
      </div>`).join("");
  },
  checks: 0, flags: 0, fixes: 0,
  pulse(on) { $("#swPulse").classList.toggle("on", !!on); },
  critic(ev) {
    const box = $("#swCritic");
    box.querySelector?.(".sw-empty")?.remove();
    const d = document.createElement("div");
    if (ev.raw) { d.className = "cr " + (ev.cls || "check"); d.innerHTML = ev.raw; }
    else {
      if (ev.level && ev.level !== "ok") { this.flags++; $("#swFlags").textContent = this.flags; }
      d.className = "cr " + (ev.level || "low");
      d.innerHTML = ev.level === "ok" ? `<b>✓ on track</b>`
        : `<b>${ev.auto ? "auto-check" : "review"} · ${esc(ev.kind || "")}</b>${esc(ev.issue || "")}` +
          (ev.guidance ? `<span class="g">→ ${esc(ev.guidance)}</span>` : "");
    }
    box.appendChild(d);
    while (box.children.length > 120) box.firstChild.remove();
    box.scrollTop = box.scrollHeight;
  },
};
setInterval(() => { if (SW.agents.size && $("#swarmPanel").classList.contains("open")) SW.render(); }, 1000);
function swToggle(on) {
  const p = $("#swarmPanel");
  const open = on === undefined ? !p.classList.contains("open") : !!on;
  p.classList.toggle("open", open);
  document.body.classList.toggle("sw-open", open);
}
$("#swarmBtn").onclick = () => swToggle();
$("#swClose").onclick = () => { swToggle(false); store.set("nexus.swPinned", false); $("#swPin").classList.remove("on"); };

/* ================= LOCAL MODEL PROVIDERS ================= */
async function renderProviders() {
  const box = $("#provList");
  if (!box) return;
  try {
    const { providers, presets } = await (await fetch("/api/providers")).json();
    const active = new Set(providers.map((p) => p.id));
    box.innerHTML = presets.map((p) => {
      const on = p.up || active.has(p.id);
      const badge = on ? `connected${p.models ? " · " + p.models : ""}`
        : (p.id === "gemini" ? `<button class="prov-fix" data-fix="gemini">start it</button>` : "offline");
      return `<div class="prov ${on ? "up" : ""}"><span class="pd"></span>
        <span class="pn">${esc(p.label)}</span>
        <span class="pu">${esc(p.baseURL.replace("/v1", ""))}</span>
        <span class="ps">${badge}</span></div>`;
    }).join("");
    box.querySelectorAll("[data-fix=gemini]").forEach((b) => (b.onclick = startGemini));
    const localCount = providers.filter((p) => p.local).length;
    if (localCount) toastOnce(`${localCount} local provider(s) connected`);
  } catch {}
}
async function renderCloud() {
  const box = $("#cloudList");
  if (!box) return;
  try {
    const { providers, cloud } = await (await fetch("/api/providers")).json();
    const active = new Set(providers.map((p) => p.id));
    const reg = new Map(providers.map((p) => [p.id, p]));
    box.innerHTML = (cloud || []).map((c) => {
      const p = reg.get(c.id);
      const on = !!p && p.enabled !== false;
      const known = !!p || c.enabled !== undefined;
      return `<div class="prov ${on ? "up" : ""}"><span class="pd"></span>
        <span class="pn">${esc(c.label)}</span>
        <span class="pu">${esc(c.note || c.envKey)}</span>
        ${known
          ? `<label class="psw" title="${on ? "on" : "off"}">
               <input type="checkbox" data-prov="${c.id}" ${on ? "checked" : ""}><span></span></label>`
          : `<span class="ps"><a href="${c.site}" target="_blank" style="color:inherit">get key</a></span>`}
      </div>`;
    }).join("");
    box.querySelectorAll("[data-prov]").forEach((el) => (el.onchange = async () => {
      const id = el.dataset.prov;
      const r = await (await fetch("/api/providers/toggle", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, enabled: el.checked }),
      })).json();
      toast(`${id} ${r.enabled ? "enabled" : "disabled"}`);
      loadModels(); renderCloud();
    }));
  } catch {}
}
$("#cpAdd") && ($("#cpAdd").onclick = async () => {
  const id = $("#cpId").value.trim(), baseURL = $("#cpUrl").value.trim(), apiKey = $("#cpKey").value.trim();
  if (!id || !baseURL) return toast("id and url required");
  const r = await (await fetch("/api/providers/add", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, label: id, baseURL, apiKey }) })).json();
  toast(r.reachable ? `${id} connected — ${r.models.length} models` : `${id} saved but unreachable`);
  loadModels(); renderProviders(); renderCloud(); renderCloud();
});

let _tOnce = new Set();
function toastOnce(m) { if (_tOnce.has(m)) return; _tOnce.add(m); toast(m); }

$("#btnDetect") && ($("#btnDetect").onclick = async () => {
  toast("Scanning localhost…");
  const r = await (await fetch("/api/providers/detect", { method: "POST" })).json();
  if (r.found?.length) {
    toast(`Found ${r.found.map((f) => f.label).join(", ")}`);
    await loadModels();
  } else toast("No local server running — see 'How to install'");
  renderProviders(); renderCloud();
});

const LOCAL_HELP = `
<h4>1 · Install a runner</h4>
<b>Ollama</b> — easiest, one command:<br>
<a href="https://ollama.com/download" target="_blank">ollama.com/download</a>
&nbsp;·&nbsp; <b>LM Studio</b> (GUI): <a href="https://lmstudio.ai" target="_blank">lmstudio.ai</a>

<h4>2 · Pull a model that matches your GPU</h4>
<table>
<tr><td>8 GB VRAM</td><td><code>ollama pull qwen3-coder:8b</code> — best small coder</td></tr>
<tr><td>12 GB</td><td><code>ollama pull qwen3:14b</code></td></tr>
<tr><td>16 GB</td><td><code>ollama pull devstral-small:24b</code> — built for agents</td></tr>
<tr><td>24 GB</td><td><code>ollama pull qwen3.6:27b</code> — 77% SWE-bench ★</td></tr>
<tr><td>48 GB+</td><td><code>ollama pull qwen3-coder:80b-a3b-q4</code></td></tr>
<tr><td>CPU only</td><td><code>ollama pull phi4-mini</code></td></tr>
</table>

<h4>3 · Start it</h4>
<code>ollama serve</code> &nbsp;(LM Studio: enable the local server on port 1234)

<h4>4 · Click "Detect local servers"</h4>
NEXUS finds it automatically and <b>prefers local models over cloud</b> — no quota, no cost,
nothing leaves your machine.

<h4>For agents specifically</h4>
Pick a model with strong <b>tool calling</b>: <code>devstral-small:24b</code>,
<code>qwen3.6:27b</code>, or <code>qwen3-coder:8b</code>. Avoid tiny models under 7B — they
struggle with multi-step tool use.`;

$("#btnLocalHelp") && ($("#btnLocalHelp").onclick = () => {
  const h = $("#localHelp");
  h.style.display = h.style.display === "none" ? "block" : "none";
  if (!h.innerHTML) h.innerHTML = LOCAL_HELP;
});

renderProviders(); renderCloud();

/* ================= BACKGROUND JOBS: reattach on chat switch ================= */
const LIVE = { es: null, chatId: null };

function detachLive() {
  try { LIVE.es?.close(); } catch {}
  LIVE.es = null; LIVE.chatId = null;
}

/** Reconnect to a chat's job and replay anything missed. */
function attachChat(chatId) {
  detachLive();
  const chat = state.chats.find((c) => c.id === chatId);
  if (!chat) return;

  const since = chat._seen ?? -1;
  let es;
  try { es = new EventSource(`/api/jobs/${encodeURIComponent(chatId)}/stream?since=${since}`); }
  catch { return; }
  LIVE.es = es; LIVE.chatId = chatId;

  // render into the last AI turn, or make one
  let turn = [...feed().querySelectorAll(".turn.ai")].pop();
  let body = turn?.querySelector(".ai-body");
  if (!body) { const t = aiTurn(); feed().appendChild(t.turn); body = t.body; }

  let acc = "", mdNode = null;
  const cards = {}, terms = {};
  const ensureMd = () => {
    if (!mdNode) { mdNode = document.createElement("div"); mdNode.className = "md"; body.appendChild(mdNode); }
    return mdNode;
  };

  $("#statusDot").classList.add("live");
  state.busy = true;
  $("#sendBtn").style.display = "none";
  $("#stopBtn").style.display = "grid";

  es.onmessage = (m) => {
    let ev; try { ev = JSON.parse(m.data); } catch { return; }
    if (ev._i !== undefined) chat._seen = ev._i;

    switch (ev.type) {
      case "no_job":
        detachLive(); resetComposer(); break;
      case "plan": planCard(body, ev.steps); break;
      case "tool_start": cards[ev.id] = logCard(body, ev.name, ev.args);
        SW.task("main", ev.name + " " + argOf(ev.name, ev.args)); break;
      case "tool_end": closeCard(cards[ev.id], ev.result, ev.ms, ev.image); break;
      case "term_open": terms[ev.id] = termCard(body, ev.cmd); break;
      case "term_data": {
        const t = terms[ev.id]; if (!t) break;
        const b = t.querySelector(".term-b");
        const sp = document.createElement("span");
        if (ev.stream === "stderr") sp.className = "e";
        sp.textContent = ev.text;
        b.insertBefore(sp, b.querySelector(".cursor")); break;
      }
      case "term_close": {
        const t = terms[ev.id]; if (!t) break;
        t.querySelector(".cursor")?.remove();
        const x = document.createElement("div");
        x.className = "term-x " + (ev.code === 0 ? "ok" : "bad");
        x.textContent = `exit ${ev.code}`;
        t.appendChild(x); break;
      }
      case "critic":
        if (ev.level === "ok") break;
        body.insertAdjacentHTML("beforeend",
          `<div class="critic-card ${ev.level || "medium"}"><div class="ch">🛡 supervisor</div>
           <div>${esc(ev.issue || "")}</div>${ev.guidance ? `<div class="cg"><b>Do instead:</b> ${esc(ev.guidance)}</div>` : ""}</div>`);
        break;
      case "delta": acc += ev.text; ensureMd().innerHTML = md(acc); break;
      case "error":
        ensureMd().innerHTML = `<div class="err-banner"><span>⚠️</span><div><b>${esc(ev.error)}</b></div></div>`;
        break;
      case "job_end":
        if (acc.trim() && chat.msgs.at(-1)?.role !== "assistant") {
          chat.msgs.push({ role: "assistant", content: acc }); saveChats();
        }
        detachLive(); resetComposer(); refreshJobs();
        break;
    }
    toBottom();
  };
  es.onerror = () => { /* EventSource retries on its own */ };
}

function resetComposer() {
  state.busy = false;
  $("#sendBtn").style.display = "grid";
  $("#stopBtn").style.display = "none";
  $("#statusDot").classList.remove("live");
}

/* mark chats that have a job running */
async function refreshJobs() {
  try {
    const jobs = await (await fetch("/api/jobs")).json();
    const running = new Map(jobs.filter((j) => j.status === "running").map((j) => [j.chatId, j]));
    document.querySelectorAll("#railChats .rc").forEach((el) => {
      const id = el.dataset.id;
      el.classList.toggle("running", running.has(id));
      let dot = el.querySelector(".rc-run");
      if (running.has(id) && !dot) {
        dot = document.createElement("span");
        dot.className = "rc-run";
        dot.title = "task running";
        el.appendChild(dot);
      } else if (!running.has(id) && dot) dot.remove();
    });
    const n = running.size;
    $("#swarmN").textContent = n;
    $("#swarmBtn").classList.toggle("busy", n > 0);
  } catch {}
}
setInterval(refreshJobs, 3000);

/* hook chat switching: detach old, attach new */
const _origRenderFeed = renderFeed;
window.renderFeed = renderFeed = function () {
  _origRenderFeed();
  const c = curChat();
  if (!c) return;
  detachLive();
  resetComposer();
  fetch("/api/jobs").then((r) => r.json()).then((jobs) => {
    if (jobs.some((j) => j.chatId === c.id && j.status === "running")) attachChat(c.id);
  }).catch(() => {});
};
refreshJobs();

/* supervisor panel: pin + auto-open while running */
(() => {
  const pin = $("#swPin"), panel = $("#swarmPanel");
  const setPin = (on) => { store.set("nexus.swPinned", on); pin.classList?.toggle("on", on); if (on) swToggle(true); };
  pin.onclick = () => setPin(!store.get("nexus.swPinned", false));
  setPin(store.get("nexus.swPinned", false));
  const origStart = SW.pulse.bind(SW);
  SW.pulse = (on) => { origStart(on); if (on && store.get("nexus.swAuto", true)) swToggle(true); };
})();

/* start the bundled Gemini bridge from the UI */
async function startGemini() {
  toast("Starting Gemini bridge…");
  const box = $("#localHelp");
  box.style.display = "block";
  box.innerHTML = '<b>Starting Gemini Web bridge…</b><pre id="gemLog" style="max-height:180px;overflow:auto;font-size:11px"></pre>';
  const log = (t) => { const p = $("#gemLog"); if (p) { p.textContent += t; p.scrollTop = p.scrollHeight; } };
  await streamSSE("/api/gemini/start", { method: "POST" }, (ev) => {
    if (ev.type === "data") log(ev.text);
    if (ev.type === "done") {
      if (ev.ok) { toast("Gemini bridge ready ✓"); log("\nREADY — free Gemini models are now available.\n"); }
      else {
        toast("Gemini failed to start");
        log(`\nFAILED: ${ev.error}\n\nMost likely: Python 3 is not installed or not on PATH.\n` +
            `Install from python.org (tick "Add python.exe to PATH"), then click "start it" again.\n`);
      }
      renderProviders(); loadModels();
    }
  });
}
