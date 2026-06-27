// Importance scorer — stage 2 of the lever pipeline (framework v2.3+).
// Reads the scored companies/<slug>/levers.json (from score-elements.mjs) plus the
// post-run inputs (classified.jsonl citations, graded.jsonl wrong_entity), computes
// the importance layer (theory x practice -> blended importance, priority = importance
// x gap), and writes:
//
//   - companies/<slug>/importance.json — the standalone importance matrix (one row
//     per element x applicable job: research / run / blended importance, gap, priority,
//     local_evidence) plus the ranked priorities, verify_first, importance_config.
//     This is the artifact the AEO Lever Scorecard exporter and the fix brief read.
//   - merges importance / local_evidence / priority / verify_first back into
//     levers.json (per element) and priorities / verify_first / importance_config
//     (top-level) so build-report-data.mjs and the stager keep reading levers.json unchanged.
//
//   node score-importance.mjs <slug>

import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FRAMEWORK_VERSION, RUBRIC_VERSION } from "./lib/rubric.mjs";
import { computeImportance, buildImportanceMatrix } from "./lib/importance.mjs";

const slug = process.argv[2];
if (!slug) throw new Error("usage: node score-importance.mjs <slug>");
const root = dirname(fileURLToPath(import.meta.url));
const dir = `${root}/companies/${slug}`;

const load = async (f) => JSON.parse(await readFile(`${dir}/${f}`, "utf8"));
const loadJsonl = async (f) => { try { return (await readFile(`${dir}/${f}`, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

const ctx = await load("context.json");
const profiles = [ctx.audit_profile?.primary, ctx.audit_profile?.secondary].filter(Boolean);
if (!profiles.length) throw new Error("context.json needs audit_profile { primary, secondary? }");

let result;
try { result = await load("levers.json"); }
catch { throw new Error(`levers.json not found in ${dir} — run score-elements.mjs ${slug} first`); }

const classified = await loadJsonl("classified.jsonl");
const graded = await loadJsonl("graded.jsonl");

// 1) compute importance, mutating result (levers.json) in place
computeImportance(result, { classified, graded, profiles });
// The importance stage resolves tiers + signal modes from the live rubric (see
// lib/importance.mjs), so stamp the live versions: the file now reflects them.
result.framework_version = FRAMEWORK_VERSION;
result.rubric_version = RUBRIC_VERSION;
await writeFile(`${dir}/levers.json`, JSON.stringify(result, null, 2) + "\n");

// 2) project the standalone importance matrix
const m = buildImportanceMatrix(result);
const importance = {
  slug, company: ctx.company, profile: ctx.audit_profile,
  computed_at: result.importance_config.computed_at,
  framework_version: FRAMEWORK_VERSION,
  rubric_version: result.rubric_version,
  ...m,
};
await writeFile(`${dir}/importance.json`, JSON.stringify(importance, null, 2) + "\n");

console.log(`importance -> ${dir}/importance.json  (${m.matrix.length} rows)`);
console.log(`merged importance/priorities back into ${dir}/levers.json`);
for (const t of ["discoverability", "assessment"]) {
  const top = (result.priorities?.[t] ?? []).slice(0, 6).map((p) => `${p.element} P${p.priority} (I${p.importance} x gap${p.gap})`).join(" | ");
  console.log(`priorities ${t}: ${top || "none"}`);
}
if (result.verify_first?.length) console.log(`verify first (indeterminate, excluded from priorities): ${result.verify_first.join(", ")}`);
