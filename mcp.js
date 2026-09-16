/* Model Context Protocol client — connect any MCP server as extra agent tools.
   Supports stdio servers (the common case) over JSON-RPC 2.0. */
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import fss from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IS_WIN } from "./shell.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = path.join(__dirname, "mcp.json");

const servers = new Map();   // name -> { proc, tools, seq, pending, ready }

export async function loadConfig() {
  try { return JSON.parse(await fs.readFile(CONFIG, "utf8")); }
  catch { return { mcpServers: {} }; }
}
export async function saveConfig(cfg) {
  await fs.writeFile(CONFIG, JSON.stringify(cfg, null, 2), "utf8");
}

function rpc(srv, method, params = {}, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const id = ++srv.seq;
    const t = setTimeout(() => { srv.pending.delete(id); reject(new Error(`${method} timed out`)); }, timeout);
    srv.pending.set(id, {
      resolve: (v) => { clearTimeout(t); resolve(v); },
      reject: (e) => { clearTimeout(t); reject(e); },
    });
    try { srv.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); }
    catch (e) { clearTimeout(t); srv.pending.delete(id); reject(e); }
  });
}

export async function connect(name, spec) {
  if (servers.has(name)) return servers.get(name);
  const cmd = spec.command;
  const args = spec.args || [];
  const full = IS_WIN ? [cmd, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ") : null;
  const proc = IS_WIN
    ? spawn(full, { cwd: spec.cwd || __dirname, shell: true, windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...(spec.env || {}) } })
    : spawn(cmd, args, { cwd: spec.cwd || __dirname, windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...(spec.env || {}) } });
  const srv = { name, proc, tools: [], seq: 0, pending: new Map(), ready: false, err: "" };
  proc.on("error", (e) => { srv.err = e.message; for (const p of srv.pending.values()) p.reject(e); srv.pending.clear(); });
  servers.set(name, srv);

  let buf = "";
  proc.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!line) continue;
      let msg; try { msg = JSON.parse(line); } catch { continue; }
      const p = srv.pending.get(msg.id);
      if (p) { srv.pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message || "mcp error")) : p.resolve(msg.result); }
    }
  });
  proc.stderr.on("data", (d) => { srv.err = (srv.err + d.toString()).slice(-800); });
  proc.on("exit", () => { servers.delete(name); });

  try {
    await rpc(srv, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      clientInfo: { name: "nexus", version: "8.0.0" },
    }, 25000);
    try { proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n"); } catch {}
    const list = await rpc(srv, "tools/list", {}, 20000);
    srv.tools = list?.tools || [];
    srv.ready = true;
  } catch (e) {
    srv.err = e.message;
    try { proc.kill(); } catch {}
    servers.delete(name);
    throw new Error(`MCP "${name}" failed: ${e.message}${srv.err ? " | " + srv.err.slice(0, 200) : ""}`);
  }
  return srv;
}

/** Connect every server in mcp.json. Returns a status report. */
export async function connectAll(onLog = () => {}) {
  const cfg = await loadConfig();
  const out = [];
  for (const [name, spec] of Object.entries(cfg.mcpServers || {})) {
    if (spec.disabled) { out.push({ name, ok: false, skipped: true }); continue; }
    try {
      const s = await connect(name, spec);
      onLog(`MCP "${name}" connected — ${s.tools.length} tools\n`);
      out.push({ name, ok: true, tools: s.tools.length });
    } catch (e) {
      onLog(`MCP "${name}" failed: ${e.message}\n`);
      out.push({ name, ok: false, error: e.message });
    }
  }
  return out;
}

/** MCP tools converted to OpenAI function-tool schemas, namespaced mcp__<server>__<tool>. */
export function toolSchemas() {
  const out = [];
  for (const [name, srv] of servers) {
    if (!srv.ready) continue;
    for (const t of srv.tools) {
      out.push({
        type: "function",
        function: {
          name: `mcp__${name}__${t.name}`.slice(0, 64),
          description: `[MCP:${name}] ${t.description || t.name}`.slice(0, 900),
          parameters: t.inputSchema && typeof t.inputSchema === "object"
            ? t.inputSchema : { type: "object", properties: {} },
        },
      });
    }
  }
  return out;
}

export function isMcpTool(name) { return String(name).startsWith("mcp__"); }

export async function callTool(fullName, args) {
  const m = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(fullName);
  if (!m) throw new Error("bad mcp tool name " + fullName);
  const [, server, tool] = m;
  const srv = servers.get(server);
  if (!srv?.ready) throw new Error(`MCP server "${server}" is not connected`);
  const r = await rpc(srv, "tools/call", { name: tool, arguments: args || {} }, 120000);
  const parts = r?.content || [];
  const text = parts.map((p) => (p.type === "text" ? p.text : p.type === "image" ? "[image]" : JSON.stringify(p))).join("\n");
  return text || JSON.stringify(r).slice(0, 4000);
}

export function status() {
  return [...servers.values()].map((s) => ({ name: s.name, ready: s.ready, tools: s.tools.map((t) => t.name) }));
}
export function disconnectAll() {
  for (const s of servers.values()) { try { s.proc.kill(); } catch {} }
  servers.clear();
}

/** Seed a starter config so the feature is discoverable. */
export async function ensureConfig() {
  if (fss.existsSync(CONFIG)) return;
  await saveConfig({
    _comment: "Add MCP servers here. Restart NEXUS (or call reload) to connect them.",
    _examples: {
      filesystem: { command: "npx", args: ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"], disabled: true },
      github: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "" }, disabled: true },
      postgres: { command: "npx", args: ["-y", "@modelcontextprotocol/server-postgres", "postgresql://..."], disabled: true },
    },
    mcpServers: {},
  });
}
