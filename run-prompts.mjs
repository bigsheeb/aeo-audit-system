// Prompt tester — deterministic. Reads approved prompts, fires each at every
// surface k times (per-prompt `runs` from Gate 1; defaults 3 discoverability /
// 2 assessment), writes one JSONL row per (prompt x surface x run), prints a
// summary. Failed calls retry once, then land as status:"error" rows so
// denominators stay honest. The full provider payload is persisted per row so
// any run can be audited (which backend grounded it, what was billed).
//
//   node audit/run-prompts.mjs northwind

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SURFACES } from "./lib/surfaces.mjs";
import { querySurface } from "./lib/openrouter.mjs";

const company = process.argv[2] ?? "northwind";
// Refuse to run without a key rather than firing every prompt at an unauthorized
// surface and overwriting raw_responses.jsonl with error rows. This script makes
// live, metered OpenRouter calls — it is not the unit-test runner (`npm test`).
if (!process.env.OPENROUTER_API_KEY) {
  console.error("OPENROUTER_API_KEY is not set. run-prompts.mjs makes live, metered surface calls; set the key first. (For the deterministic test suite, run `npm test`.)");
  process.exit(1);
}
const root = dirname(fileURLToPath(import.meta.url));
const promptsPath = `${root}/companies/${company}/prompts.json`;
const outPath = `${root}/companies/${company}/raw_responses.jsonl`;

const prompts = JSON.parse(await readFile(promptsPath, "utf8"));
await mkdir(dirname(outPath), { recursive: true });

const batch = new Date().toISOString();
const defaultRuns = (track) => (track === "discoverability" ? 3 : 2);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const rows = [];
let ok = 0;
let failed = 0;
for (const p of prompts) {
  const runs = p.runs ?? defaultRuns(p.track);
  for (const surface of SURFACES) {
    for (let run = 1; run <= runs; run++) {
      process.stdout.write(`-> [${p.track}] ${surface.label} ${p.id} r${run} ... `);
      const base = { company, prompt_id: p.id, track: p.track, prompt: p.text, surface: surface.id, run_index: run, batch };
      let lastErr = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const r = await querySurface(p.text, surface);
          rows.push({ ...base, status: "ok", model: r.model, response: r.text, citations: r.citations, ts: new Date().toISOString(), raw: r.raw });
          ok++;
          console.log(`ok - ${r.text.length} chars, ${r.citations.length} citations`);
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          if (attempt === 1) await sleep(2000);
        }
      }
      if (lastErr) {
        failed++;
        rows.push({ ...base, status: "error", error: lastErr.message, ts: new Date().toISOString() });
        console.log(`FAIL - ${lastErr.message}`);
      }
    }
  }
}

await writeFile(outPath, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
console.log(`\nWrote ${rows.length} rows (${ok} ok, ${failed} error) -> ${outPath}`);
if (failed) console.log("Error rows are excluded from classify/metrics denominators. Re-run /audit-run step 2 to retry, or proceed if coverage is acceptable.");
