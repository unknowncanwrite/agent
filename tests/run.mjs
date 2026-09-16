/* NEXUS test runner.
 *
 *   node tests/run.mjs            # every suite (01..05) in order
 *   node tests/run.mjs 04         # only suites whose filename contains "04"
 *   node tests/run.mjs security   # substring match anywhere in the name
 *
 * Each suite runs in its own process (the product has module-level state).
 * Exit code 0 = no failed assertions. Findings are reported, not failures.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const pattern = process.argv[2] || "";

const files = fs.readdirSync(HERE)
  .filter((f) => f.endsWith(".test.mjs"))
  .sort()
  .filter((f) => !pattern || f.includes(pattern) || f.toLowerCase().includes(pattern.toLowerCase()));

if (!files.length) { console.error(`no suite matches "${pattern}"`); process.exit(2); }

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nexus-results-"));
const all = [];
let failed = 0;

for (const f of files) {
  const jsonPath = path.join(tmp, f + ".json");
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HERE, "run-one.mjs"), path.join(HERE, f)], {
      env: { ...process.env, NEXUS_RESULT_JSON: jsonPath },
      stdio: ["ignore", "inherit", "inherit"],
    });
    child.on("exit", (c) => resolve(c ?? 1));
  });
  if (code !== 0) failed++;
  try { all.push(JSON.parse(fs.readFileSync(jsonPath, "utf8"))); }
  catch { all.push({ file: f, pass: 0, fail: 1, failures: [{ suite: f, name: "no result written (hard crash)", error: "runner lost the suite" }], findings: [], notes: [] }); }
}

const sum = (k) => all.reduce((n, r) => n + (Array.isArray(r[k]) ? r[k].length : r[k] || 0), 0);
const pass = sum("pass"), fail = sum("fail");
const findings = all.flatMap((r) => (r.findings || []).map((x) => ({ ...x, file: r.file })));
const failures = all.flatMap((r) => (r.failures || []));
const notes = all.flatMap((r) => r.notes || []);

const SEV = { critical: "CRITICAL", high: "HIGH    ", medium: "MEDIUM  ", low: "LOW     " };
const line = "═".repeat(70);
console.log("\n" + line);
console.log(`\x1b[1mNEXUS TEST RUN\x1b[0m   ${pass} passed, ${fail} failed, ${findings.length} findings`);

if (notes.length) { console.log("\nnotes:"); notes.forEach((n) => console.log("  • " + n)); }

if (failures.length) {
  console.log("\nfailures:");
  failures.forEach((f) => console.log(`  \x1b[31m✗\x1b[0m [${f.suite}] ${f.name}\n     ${String(f.error).split("\n")[0]}`));
}

if (findings.length) {
  console.log(`\nfindings (reported, not failures):`);
  findings
    .sort((a, b) => ["critical", "high", "medium", "low"].indexOf(a.severity) - ["critical", "high", "medium", "low"].indexOf(b.severity))
    .forEach((f) => console.log(`  [${SEV[f.severity] || f.severity}] ${f.name} \x1b[90m(${f.file})\x1b[0m`));
}
console.log(line + "\n");
process.exit(fail ? 1 : 0);
