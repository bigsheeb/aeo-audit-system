// Performance score compute — deterministic, key-free. The judge judges; this
// script scores. Joins the grader's per-criterion verdicts (verdicts.jsonl)
// with classified rows + the approved rubric (prompts.json), validates every
// evidence quote against the actual response text, applies the floor gate, and
// computes each row's performance score in code.
//
//   node audit/grade-compute.mjs <slug> --judge "<model-id-that-graded>"
//
// Rules:
//   - QUOTE VALIDATION: a pass/partial verdict needs a verbatim quote that
//     appears in the response (whitespace / quote-mark / markdown normalized).
//     A missing or unmatched quote forces that criterion onto the review queue.
//     Fail verdicts may quote what the answer did instead, or leave quote "".
//   - FLOOR GATE: a row is portrayal-eligible only if the brand was named
//     (classified brand_mentioned), there is no wrong_entity flag, and no
//     kill criterion failed. Floor failures score 0 — mention rate already
//     measures absence; the score measures portrayal.
//   - SCORE: 5 x weighted pass fraction over the prompt's approved criteria
//     (pass 1, partial 0.5, fail/missing 0). Computed here, never by the LLM.
//   - REVIEW QUEUE: any criterion the grader marked confidence "unsure", any
//     invalid quote, and any missing/unknown criterion id lands in
//     review-queue.json for Gate 2 adjudication. To adjudicate: edit
//     verdicts.jsonl, re-run this script + compute-metrics (free).

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const company = process.argv[2];
if (!company) throw new Error("usage: node audit/grade-compute.mjs <slug> [--judge <model>]");
const judgeIdx = process.argv.indexOf("--judge");
const judgeModel = judgeIdx > -1 ? process.argv[judgeIdx + 1] : "unrecorded";
const root = dirname(fileURLToPath(import.meta.url));
const dir = `${root}/companies/${company}`;

const readJsonl = async (f) =>
  (await readFile(`${dir}/${f}`, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l));

const prompts = JSON.parse(await readFile(`${dir}/prompts.json`, "utf8"));
const classified = await readJsonl("classified.jsonl");
// verdicts.jsonl is the grader agent's output; if it is absent the run has not been
// graded yet (the shipped sample carries graded.jsonl, this script's output, not its input).
if (!existsSync(`${dir}/verdicts.jsonl`)) {
  console.error(`Missing ${dir}/verdicts.jsonl — run the audit-performance-grader agent first; it emits the per-criterion verdicts this script validates and scores.`);
  process.exit(1);
}
const verdicts = await readJsonl("verdicts.jsonl");

// Rubric: tolerate both shapes — objects {id,text,weight,kill} (current) and
// bare strings (pre-upgrade prompts.json), which get auto-ids and weight 1.
const rubric = new Map(); // prompt_id -> [criterion]
for (const p of prompts) {
  const list = (p.success_criteria ?? []).map((c, i) =>
    typeof c === "string"
      ? { id: `${p.id}.c${i + 1}`, text: c, weight: 1, kill: false }
      : { id: c.id ?? `${p.id}.c${i + 1}`, text: c.text, weight: c.weight ?? 1, kill: c.kill === true }
  );
  rubric.set(p.id, list);
}
const rubricVersion = createHash("sha256")
  .update(JSON.stringify([...rubric.entries()]))
  .digest("hex").slice(0, 10);

// Quote validation: normalize whitespace, curly quotes, and markdown marks so
// a faithfully copied quote matches even if the grader dropped formatting.
const norm = (s) => String(s).toLowerCase()
  .replace(/[‘’]/g, "'").replace(/[“”]/g, '"')
  .replace(/[*_`>#|]/g, "").replace(/\s+/g, " ").trim();
const quoteInResponse = (quote, response) => {
  const q = norm(quote);
  return q.length > 0 && norm(response).includes(q);
};

const key = (r) => `${r.prompt_id}|${r.surface}|${r.run_index ?? 1}`;
const byKey = new Map(classified.map((r) => [key(r), r]));
const V = { pass: 1, partial: 0.5, fail: 0, missing: 0 };
const round1 = (x) => Math.round(x * 10) / 10;

const graded = [];
const review = [];
let floorFails = 0;

for (const v of verdicts) {
  const row = byKey.get(key(v));
  if (!row) {
    review.push({ ...{ prompt_id: v.prompt_id, surface: v.surface, run_index: v.run_index ?? 1 }, criterion: "(row)", reason: "no matching classified row", note: "" });
    continue;
  }
  const criteria = rubric.get(v.prompt_id) ?? [];
  const got = new Map((v.criteria ?? []).map((c) => [c.id, c]));
  const flags = [...new Set(v.flags ?? [])];

  // Head-to-head verdict (is_comparison prompts only) — passed through to graded,
  // never folded into the Performance Score. Validate its quote like any other.
  let h2h = null;
  if (v.head_to_head && ["win", "tie", "loss"].includes(v.head_to_head.verdict)) {
    const q = v.head_to_head.quote ?? "";
    const qValid = q === "" || quoteInResponse(q, row.response ?? "");
    h2h = { verdict: v.head_to_head.verdict, rival: v.head_to_head.rival ?? null, quote: q, quote_valid: qValid, note: v.head_to_head.note ?? "" };
    if (!qValid) review.push({ prompt_id: v.prompt_id, surface: v.surface, run_index: v.run_index ?? 1, criterion: "(head_to_head)", reason: "quote not found in response", note: v.head_to_head.note ?? "" });
  }

  let wSum = 0, vSum = 0, killFailed = false;
  const detail = [];
  for (const c of criteria) {
    const g = got.get(c.id);
    const verdict = g && V[g.verdict] !== undefined ? g.verdict : "missing";
    const confidence = g?.confidence === "unsure" ? "unsure" : "certain";
    const quote = g?.quote ?? "";
    const quoteValid = verdict === "fail" || verdict === "missing"
      ? (quote === "" || quoteInResponse(quote, row.response ?? ""))
      : quoteInResponse(quote, row.response ?? "");

    const reasons = [];
    if (verdict === "missing") reasons.push("criterion not graded");
    if (!quoteValid) reasons.push("quote not found in response");
    if (confidence === "unsure") reasons.push("grader unsure");
    for (const reason of reasons) {
      review.push({ prompt_id: v.prompt_id, surface: v.surface, run_index: v.run_index ?? 1, criterion: c.id, reason, note: g?.note ?? "" });
    }

    if (c.kill && verdict === "fail") killFailed = true;
    wSum += c.weight;
    vSum += c.weight * V[verdict];
    detail.push({ id: c.id, verdict, confidence, weight: c.weight, kill: c.kill, quote, quote_valid: quoteValid, note: g?.note ?? "" });
  }
  // Verdicts for ids not in the approved rubric: reviewed, never scored.
  for (const [id] of got) {
    if (!criteria.some((c) => c.id === id)) {
      review.push({ prompt_id: v.prompt_id, surface: v.surface, run_index: v.run_index ?? 1, criterion: id, reason: "unknown criterion id (not in approved rubric)", note: "" });
    }
  }

  const portrayalEligible = row.brand_mentioned === true && !flags.includes("wrong_entity") && !killFailed;
  if (!portrayalEligible) floorFails++;
  const score = portrayalEligible && wSum > 0 ? round1(5 * (vSum / wSum)) : 0;

  graded.push({
    prompt_id: v.prompt_id,
    surface: v.surface,
    track: row.track,
    run_index: v.run_index ?? 1,
    performance_score: score,
    portrayal_eligible: portrayalEligible,
    criteria: detail,
    ...(h2h ? { head_to_head: h2h } : {}),
    flags,
    rationale: v.rationale ?? "",
    judge_model: judgeModel,
    rubric_version: rubricVersion,
    graded_at: new Date().toISOString(),
  });
}

// Classified rows the grader never produced a verdict for — surfaced, not silently dropped.
for (const r of classified) {
  if (!verdicts.some((v) => key(v) === key(r))) {
    review.push({ prompt_id: r.prompt_id, surface: r.surface, run_index: r.run_index ?? 1, criterion: "(row)", reason: "classified row has no verdicts", note: "" });
  }
}

await writeFile(`${dir}/graded.jsonl`, graded.map((r) => JSON.stringify(r)).join("\n") + "\n");
await writeFile(`${dir}/review-queue.json`, JSON.stringify(review, null, 2) + "\n");

const avg = (a) => (a.length ? round1(a.reduce((s, x) => s + x, 0) / a.length) : null);
for (const t of ["discoverability", "assessment"]) {
  const tr = graded.filter((r) => r.track === t);
  if (!tr.length) continue;
  const named = tr.filter((r) => r.portrayal_eligible);
  console.log(`${t}: ${tr.length} rows · blended ${avg(tr.map((r) => r.performance_score))} · portrayal-when-named ${avg(named.map((r) => r.performance_score))} (${named.length} named)`);
}
console.log(`graded ${graded.length} rows (rubric ${rubricVersion}, judge ${judgeModel}, ${floorFails} floor failures) -> ${dir}/graded.jsonl`);
console.log(`review queue: ${review.length} item(s) -> ${dir}/review-queue.json`);
if (review.length) for (const r of review.slice(0, 12)) console.log(`  ! ${r.prompt_id}/${r.surface}/r${r.run_index} ${r.criterion}: ${r.reason}`);
if (review.length > 12) console.log(`  ... and ${review.length - 12} more`);
