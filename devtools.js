/* Developer superpowers: git workflows, worktrees, deliverable generation, data analysis */
import fs from "node:fs/promises";
import fss from "node:fs";
import path from "node:path";
import os from "node:os";
import { runStream, IS_WIN } from "./shell.js";

const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`;

/* ---------------- git ---------------- */
export async function git(args, cwd, timeout = 60) {
  const r = await runStream(`git ${args}`, { cwd, timeout });
  return { ok: r.code === 0, out: (r.stdout || "").trim(), err: (r.stderr || "").trim(), code: r.code };
}

export async function gitStatus(cwd) {
  const [st, br, log] = await Promise.all([
    git("status --porcelain=v1 -b", cwd),
    git("branch --show-current", cwd),
    git("log --oneline -8", cwd),
  ]);
  if (!st.ok) return "Not a git repository (or git unavailable).";
  const files = st.out.split("\n").slice(1).filter(Boolean);
  return `branch: ${br.out || "(detached)"}\nchanged files: ${files.length}\n` +
    (files.length ? files.slice(0, 60).join("\n") + "\n" : "(clean)\n") +
    `\nrecent commits:\n${log.out || "(none)"}`;
}

export async function gitDiff(cwd, { staged = false, file = "", stat = false } = {}) {
  const r = await git(`diff ${staged ? "--staged" : ""} ${stat ? "--stat" : ""} ${file ? "-- " + q(file) : ""}`.trim(), cwd, 90);
  const out = r.out || "(no changes)";
  return out.length > 30000 ? out.slice(0, 30000) + "\n…[truncated]" : out;
}

/** Stage + commit with a conventional-commit message. */
export async function gitCommit(cwd, { message, all = true, files = [] }) {
  if (all) await git("add -A", cwd);
  else for (const f of files) await git(`add ${q(f)}`, cwd);
  const staged = await git("diff --staged --name-only", cwd);
  if (!staged.out) return "Nothing staged — no commit made.";
  const tmp = path.join(os.tmpdir(), `cm-${Date.now()}.txt`);
  await fs.writeFile(tmp, message, "utf8");
  const r = await git(`commit -F ${q(tmp)}`, cwd);
  await fs.rm(tmp, { force: true });
  return r.ok ? `Committed:\n${staged.out}\n\n${r.out}` : `Commit failed: ${r.err || r.out}`;
}

/** Isolated worktree so parallel agents never collide — Cursor/Claude Code style. */
export async function worktreeAdd(cwd, { name, branch }) {
  const root = (await git("rev-parse --show-toplevel", cwd)).out || cwd;
  const dir = path.join(path.dirname(root), `${path.basename(root)}-${name}`);
  const b = branch || `nexus/${name}`;
  let r = await git(`worktree add ${q(dir)} -b ${q(b)}`, cwd, 90);
  if (!r.ok && /already exists/i.test(r.err)) r = await git(`worktree add ${q(dir)} ${q(b)}`, cwd, 90);
  return r.ok ? `Worktree ready at ${dir} on branch ${b}` : `Failed: ${r.err || r.out}`;
}
export async function worktreeList(cwd) {
  const r = await git("worktree list", cwd);
  return r.out || "(none)";
}
export async function worktreeRemove(cwd, dir) {
  const r = await git(`worktree remove ${q(dir)} --force`, cwd, 60);
  return r.ok ? `Removed worktree ${dir}` : `Failed: ${r.err}`;
}

/* ---------------- python helper ---------------- */
const PY = () => process.env.NEXUS_PYTHON || (IS_WIN ? "python" : "python3");

async function runPy(code, cwd, timeout = 180) {
  const f = path.join(os.tmpdir(), `nx-${Date.now()}.py`);
  await fs.writeFile(f, code, "utf8");
  const r = await runStream(`${PY()} ${q(f)}`, { cwd, timeout });
  await fs.rm(f, { force: true });
  return r;
}

export async function ensurePyDeps(pkgs, onLog = () => {}) {
  const probe = await runStream(`${PY()} -c "import ${pkgs[0].split("==")[0].replace(/-/g, "_")}"`, { timeout: 25 });
  if (probe.code === 0) return { ok: true, already: true };
  onLog(`Installing ${pkgs.join(", ")}…\n`);
  const r = await runStream(`${PY()} -m pip install --user ${pkgs.join(" ")}`, { timeout: 600, onData: ({ text }) => onLog(text) });
  return { ok: r.code === 0, out: (r.stderr || r.stdout || "").slice(-600) };
}

/* ---------------- deliverables (Manus-style outputs) ---------------- */
export async function makeDocument({ kind, outPath, title = "", content = "", rows = null }, cwd, onLog = () => {}) {
  const need = { docx: ["python-docx"], xlsx: ["openpyxl"], pptx: ["python-pptx"], pdf: ["reportlab"] }[kind];
  if (!need) return `Unsupported kind "${kind}". Use docx, xlsx, pptx or pdf.`;
  const dep = await ensurePyDeps(need, onLog);
  if (!dep.ok) return `Could not install ${need.join(", ")}: ${dep.out}`;

  const payload = JSON.stringify({ outPath, title, content, rows });
  const scripts = {
    docx: `
import json,sys
from docx import Document
from docx.shared import Pt
d=json.loads(sys.argv[1]); doc=Document()
if d["title"]: doc.add_heading(d["title"],0)
for block in d["content"].split("\\n"):
    s=block.rstrip()
    if not s: continue
    if s.startswith("### "): doc.add_heading(s[4:],3)
    elif s.startswith("## "): doc.add_heading(s[3:],2)
    elif s.startswith("# "): doc.add_heading(s[2:],1)
    elif s.startswith(("- ","* ")): doc.add_paragraph(s[2:],style="List Bullet")
    else: doc.add_paragraph(s)
doc.save(d["outPath"]); print("wrote",d["outPath"])`,
    xlsx: `
import json,sys
from openpyxl import Workbook
from openpyxl.styles import Font,PatternFill
d=json.loads(sys.argv[1]); wb=Workbook(); ws=wb.active; ws.title=(d["title"] or "Sheet1")[:31]
rows=d["rows"] or [r.split(",") for r in d["content"].strip().split("\\n") if r.strip()]
for r in rows: ws.append(r)
if rows:
    for c in ws[1]:
        c.font=Font(bold=True,color="FFFFFF"); c.fill=PatternFill("solid",fgColor="4463F2")
    for col in ws.columns:
        w=max(len(str(c.value or "")) for c in col)+2
        ws.column_dimensions[col[0].column_letter].width=min(w,60)
    ws.freeze_panes="A2"
wb.save(d["outPath"]); print("wrote",d["outPath"])`,
    pptx: `
import json,sys
from pptx import Presentation
from pptx.util import Inches,Pt
d=json.loads(sys.argv[1]); p=Presentation()
slides=[s for s in d["content"].split("---") if s.strip()]
t=p.slides.add_slide(p.slide_layouts[0]); t.shapes.title.text=d["title"] or "Presentation"
if len(t.placeholders)>1: t.placeholders[1].text="Generated by NEXUS"
for s in slides:
    lines=[l for l in s.strip().split("\\n") if l.strip()]
    if not lines: continue
    sl=p.slides.add_slide(p.slide_layouts[1])
    sl.shapes.title.text=lines[0].lstrip("# ").strip()
    body=sl.placeholders[1].text_frame; body.clear()
    for i,l in enumerate(lines[1:8]):
        para=body.paragraphs[0] if i==0 else body.add_paragraph()
        para.text=l.lstrip("-* ").strip(); para.font.size=Pt(18)
p.save(d["outPath"]); print("wrote",d["outPath"])`,
    pdf: `
import json,sys
from reportlab.lib.pagesizes import LETTER
from reportlab.lib.styles import getSampleStyleSheet
from reportlab.platypus import SimpleDocTemplate,Paragraph,Spacer
d=json.loads(sys.argv[1]); st=getSampleStyleSheet(); story=[]
if d["title"]: story+=[Paragraph(d["title"],st["Title"]),Spacer(1,14)]
for block in d["content"].split("\\n"):
    s=block.strip()
    if not s: story.append(Spacer(1,8)); continue
    if s.startswith("# "): story.append(Paragraph(s[2:],st["Heading1"]))
    elif s.startswith("## "): story.append(Paragraph(s[3:],st["Heading2"]))
    else: story.append(Paragraph(s.replace("&","&amp;").replace("<","&lt;"),st["BodyText"]))
SimpleDocTemplate(d["outPath"],pagesize=LETTER).build(story); print("wrote",d["outPath"])`,
  };

  const f = path.join(os.tmpdir(), `mk-${Date.now()}.py`);
  await fs.writeFile(f, scripts[kind], "utf8");
  const r = await runStream(`${PY()} ${q(f)} ${q(payload)}`, { cwd, timeout: 180 });
  await fs.rm(f, { force: true });
  return r.code === 0
    ? `Created ${outPath}\n${(r.stdout || "").trim()}`
    : `Failed: ${(r.stderr || r.stdout).slice(-900)}`;
}

/* ---------------- data analysis ---------------- */
export async function analyzeData({ file, question = "", chart = null, outPath = "" }, cwd, onLog = () => {}) {
  const dep = await ensurePyDeps(["pandas", "matplotlib"], onLog);
  if (!dep.ok) return `Could not install pandas/matplotlib: ${dep.out}`;
  const code = `
import sys, json, pandas as pd
f = ${JSON.stringify(file)}
if f.endswith((".xlsx",".xls")): df = pd.read_excel(f)
elif f.endswith(".json"): df = pd.read_json(f)
elif f.endswith(".parquet"): df = pd.read_parquet(f)
else: df = pd.read_csv(f)
print("SHAPE:", df.shape[0], "rows x", df.shape[1], "cols")
print("\\nCOLUMNS:"); print(df.dtypes.to_string())
print("\\nHEAD:"); print(df.head(8).to_string())
print("\\nNUMERIC SUMMARY:"); 
try: print(df.describe().to_string())
except Exception as e: print("n/a", e)
print("\\nMISSING VALUES:"); print(df.isna().sum().to_string())
obj = df.select_dtypes(include="object")
if len(obj.columns):
    print("\\nTOP CATEGORIES:")
    for c in list(obj.columns)[:5]:
        print(" ", c, "->", dict(df[c].value_counts().head(5)))
import json as _json
chart = _json.loads(${JSON.stringify(JSON.stringify(chart ?? null))})
out = ${JSON.stringify(String(outPath || ""))}
if chart and out:
    import matplotlib; matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    plt.figure(figsize=(10,5))
    k = chart.get("kind","bar"); x = chart.get("x"); y = chart.get("y")
    if k == "hist": df[y or x].plot(kind="hist", bins=chart.get("bins",25))
    elif k == "line": df.plot(x=x, y=y, kind="line")
    elif k == "scatter": df.plot(x=x, y=y, kind="scatter")
    else:
        d = df.groupby(x)[y].sum().sort_values(ascending=False).head(20) if (x and y) else df[x or df.columns[0]].value_counts().head(20)
        d.plot(kind="bar")
    plt.title(chart.get("title","")); plt.tight_layout(); plt.savefig(out, dpi=120)
    print("\\nCHART:", out)
`;
  const r = await runPy(code, cwd, 240);
  return r.code === 0 ? (r.stdout || "").slice(0, 14000) : `Analysis failed:\n${(r.stderr || "").slice(-1200)}`;
}

/* ---------------- project scaffolding ---------------- */
export async function scaffold({ kind, name, dir }, cwd, onLog = () => {}) {
  const cmds = {
    "next": `npx --yes create-next-app@latest ${q(name)} --ts --tailwind --eslint --app --no-src-dir --use-npm --yes`,
    "vite-react": `npm create vite@latest ${q(name)} -- --template react-ts`,
    "vite-vue": `npm create vite@latest ${q(name)} -- --template vue-ts`,
    "express": `mkdir ${q(name)} && cd ${q(name)} && npm init -y && npm i express`,
    "fastapi": `mkdir ${q(name)} && cd ${q(name)} && ${PY()} -m venv .venv && ${PY()} -m pip install fastapi uvicorn`,
    "python": `mkdir ${q(name)} && cd ${q(name)} && ${PY()} -m venv .venv`,
  };
  if (!cmds[kind]) return `Unknown template "${kind}". Options: ${Object.keys(cmds).join(", ")}`;
  const r = await runStream(cmds[kind], { cwd: dir || cwd, timeout: 900, onData: ({ text }) => onLog(text) });
  return r.code === 0 ? `Scaffolded ${kind} project "${name}"` : `Failed:\n${(r.stderr || r.stdout).slice(-1200)}`;
}

/* ---------------- multi-shell / multi-language terminal ---------------- */
const SHELL_SPECS = {
  bash:       { probe: "bash --version",       win: "bash" },
  sh:         { probe: "sh --version",         win: null },
  zsh:        { probe: "zsh --version",        win: null },
  powershell: { probe: "powershell -Command $PSVersionTable.PSVersion.ToString()", win: "powershell" },
  pwsh:       { probe: "pwsh -v",              win: "pwsh" },
  cmd:        { probe: "cmd /c ver",           win: "cmd" },
  python:     { probe: (IS_WIN ? "python" : "python3") + " --version" },
  node:       { probe: "node --version" },
  deno:       { probe: "deno --version" },
  ruby:       { probe: "ruby --version" },
  perl:       { probe: "perl --version" },
  php:        { probe: "php --version" },
  go:         { probe: "go version" },
  sqlite:     { probe: "sqlite3 --version" },
};

/** What shells/runtimes actually exist here. */
export async function detectShells() {
  const out = {};
  await Promise.all(Object.entries(SHELL_SPECS).map(async ([name, spec]) => {
    if (!IS_WIN && spec.win === null && /powershell|pwsh|cmd/.test(name)) { out[name] = null; return; }
    const r = await runStream(spec.probe, { timeout: 15 });
    out[name] = r.code === 0 ? (r.stdout || r.stderr).trim().split("\n")[0].slice(0, 60) : null;
  }));
  out._platform = process.platform;
  out._default = IS_WIN ? "powershell" : "bash";
  return out;
}


/** Build a single command string that runs `code` under the requested shell. */
export function buildShellCmd(shell, code) {
  code = typeof code === "string" ? code : (code == null ? "" : String(code));
  if (!code.trim()) return "echo 'ERROR: no code supplied to run_in'; exit 2";
  shell = shell && SHELL_SPECS[shell] ? shell : (IS_WIN ? "powershell" : "bash");
  const b64 = Buffer.from(code, "utf8").toString("base64");
  switch (shell) {
    case "auto":       return code;
    case "bash":       return `bash -lc ${q(code)}`;
    case "sh":         return `sh -c ${q(code)}`;
    case "zsh":        return `zsh -c ${q(code)}`;
    // base64 avoids every quoting/escaping trap across platforms
    case "powershell": return `powershell -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(code, "utf16le").toString("base64")}`;
    case "pwsh":       return `pwsh -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(code, "utf16le").toString("base64")}`;
    case "cmd":        return `cmd /c ${q(code)}`;
    case "python":     return `${PY()} -c "import base64;exec(base64.b64decode('${b64}').decode())"`;
    case "node":       return `node -e "eval(Buffer.from('${b64}','base64').toString())"`;
    case "deno":       return `deno eval ${q(code)}`;
    case "ruby":       return `ruby -e ${q(code)}`;
    case "perl":       return `perl -e ${q(code)}`;
    case "php":        return `php -r ${q(code.replace(/^<\?php/, ""))}`;
    case "go":         return `go run ${q(code)}`;
    case "sqlite":     return `sqlite3 ${q(code)}`;
    default:           return code;
  }
}

const SCRIPT_EXT = { bash: "sh", powershell: "ps1", python: "py", node: "js", ruby: "rb", perl: "pl", php: "php" };
const SCRIPT_RUN = {
  bash: (f) => `bash ${q(f)}`,
  powershell: (f) => `powershell -NoProfile -ExecutionPolicy Bypass -File ${q(f)}`,
  python: (f) => `${PY()} ${q(f)}`,
  node: (f) => `node ${q(f)}`,
  ruby: (f) => `ruby ${q(f)}`,
  perl: (f) => `perl ${q(f)}`,
  php: (f) => `php ${q(f)}`,
};

/** Write a multi-line script to a temp file and run it — no quoting problems, ever. */
export async function runScript({ lang, code, args = "", cwd, timeout = 300 }, onData) {
  // infer the language when it is missing or wrong, instead of failing
  if (!lang || !SCRIPT_EXT[lang]) {
    const c = code || "";
    lang = /^#!.*\bpython|^\s*(import |from .+ import|def |print\()/m.test(c) ? "python"
      : /^#!.*\bnode|console\.|require\(|=>/m.test(c) ? "node"
      : /\$PSVersionTable|Get-ChildItem|Write-Host|\$env:/i.test(c) ? "powershell"
      : /^#!.*\bruby|\bputs\b/m.test(c) ? "ruby"
      : /^<\?php/.test(c) ? "php"
      : IS_WIN ? "powershell" : "bash";
  }
  const ext = SCRIPT_EXT[lang];
  if (!ext) return { code: 127, stdout: "", stderr: `unsupported lang "${lang}". Use: ${Object.keys(SCRIPT_EXT).join(", ")}` };
  const f = path.join(os.tmpdir(), `nx-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`);
  await fs.writeFile(f, code, "utf8");
  if (!IS_WIN && lang === "bash") { try { await fs.chmod(f, 0o755); } catch {} }
  const cmd = SCRIPT_RUN[lang](f) + (args ? " " + args : "");
  const r = await runStream(cmd, { cwd, timeout, onData });
  await fs.rm(f, { force: true });
  return r;
}
