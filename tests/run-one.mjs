/* Run a single test file in its own process and (optionally) write a JSON result. */
import { pathToFileURL } from "node:url";
import fs from "node:fs";
import path from "node:path";
import { lastSummary, summary } from "./lib.mjs";

const file = process.argv[2];
if (!file) { console.error("usage: node run-one.mjs ./01-static.test.mjs"); process.exit(2); }

let crash = null;
try {
  await import(pathToFileURL(path.resolve(file)).href);
} catch (e) {
  crash = e?.stack || String(e);
  console.error("\n\x1b[31mSUITE CRASHED\x1b[0m\n" + crash);
}

let res = lastSummary();
if (!res && !crash) res = summary();
if (!res) res = { pass: 0, fail: 1, failures: [{ suite: path.basename(file), name: "suite crashed", error: String(crash).split("\n")[0] }], notes: [], findings: [] };
if (crash && res.fail === 0) { res.fail = 1; res.failures.push({ suite: path.basename(file), name: "uncaught exception in suite", error: String(crash).split("\n")[0] }); }

const out = process.env.NEXUS_RESULT_JSON;
if (out) {
  try { fs.writeFileSync(out, JSON.stringify({ file: path.basename(file), ...res })); } catch {}
}
process.exit(res.fail ? 1 : 0);
