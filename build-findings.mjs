// Findings renderer — the rich, single-source "how did this company do" doc.
// Deterministic stitch of the run's artifacts into companies/<slug>/findings.md,
// NOT constrained to fixed length caps. Two zones:
//   - Above the fold: the Gate-2 operator summary (verdict, headline numbers,
//     major findings, and an explicit "Inspect before approving" callout drawn
//     from the run's flag inventory).
//   - Below the fold: the full record (both scorecards, lever + element table,
//     importance matrix, the strategist's full fix set, the competitive map).
// Produced at audit-run Gate 2 and pushed to the Findings subpage in Notion.
//   node build-findings.mjs <slug>

import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const slug = process.argv[2];
if (!slug) throw new Error("usage: node build-findings.mjs <slug>");
const root = dirname(fileURLToPath(import.meta.url));
const dir = `${root}/companies/${slug}`;
const load = async (f) => JSON.parse(await readFile(`${dir}/${f}`, "utf8"));
const loadOpt = async (f) => { try { return await load(f); } catch { return null; } };

const ctx = await load("context.json");
const findings = await loadOpt("findings.json");
const metrics = await loadOpt("metrics.json");
const levers = await loadOpt("levers.json");
const importance = await loadOpt("importance.json");
const fixes = await loadOpt("fixes.json");
const reviewQueue = (await loadOpt("review-queue.json")) ?? [];

const company = ctx.company ?? slug;
// Defensive: upstream artifacts are written em-dash-free by spec; strip any stragglers
// so the doc passes prose-lint (which gates on em/en dashes).
// strip em/en dashes and spaced double-hyphens (the prose linter and the house
// voice both reject them); the renderer itself emits none either.
const clean = (s) => String(s ?? "").replace(/[—–]/g, ", ").replace(/\s*--\s*/g, ", ").replace(/\s+$/g, "");
const DASH = "-"; // null-cell placeholder, single hyphen (not an em dash)
const pct = (x) => (x == null ? "n/a" : `${Math.round(x * 100)}%`);
const num = (x) => (x == null ? "n/a" : `${x}`);

const L = [];
const w = (s = "") => L.push(s);

// ---------- header ----------
w(`# AEO/GEO Audit Findings: ${company}`);
w();
w(`**Domain:** ${ctx.domain ?? "n/a"}  ·  **Profile:** ${ctx.audit_profile?.primary ?? "n/a"}${ctx.audit_profile?.secondary ? " + " + ctx.audit_profile.secondary : ""}`);
if (metrics?.grading) w(`**Graded:** ${metrics.grading.rows} responses, judge ${metrics.grading.judge_model}, rubric ${metrics.grading.rubric_version}.`);
w();
w("This is the single source of record for the audit. The top section is the Gate-2 approval summary; the full detail follows below the fold.");
w();

// ---------- ABOVE THE FOLD: Gate-2 operator summary ----------
w("---");
w();
w("## Gate 2: operator summary");
w();
if (findings?.verdict) { w(`**Verdict.** ${clean(findings.verdict)}`); w(); }

const tr = (t) => metrics?.by_track?.[t] ?? {};
const pf = (t) => metrics?.performance?.[t] ?? {};
w("| Track | Mention | Citation (own domain) | Performance (blended) | Portrayal when named |");
w("| --- | --- | --- | --- | --- |");
for (const [t, label] of [["discoverability", "Discoverability"], ["assessment", "Assessment"]]) {
  const b = tr(t), p = pf(t);
  w(`| ${label} | ${pct(b.mention_rate)}${p.n_named != null ? ` (${p.n_named} of ${p.n})` : ""} | ${pct(b.citation_rate)} | ${num(p.blended_avg)} / 5 | ${num(p.portrayal_when_named)} / 5 |`);
}
w();

// Major findings: the broken job + the strategy summary + the top key findings
if (fixes?.broken_job) w(`**The broken job: ${fixes.broken_job}.** ${clean(fixes.summary ?? "")}`);
w();
const topFindings = [
  ...((findings?.discoverability?.key_findings ?? []).slice(0, 2)),
  ...((findings?.assessment?.key_findings ?? []).slice(0, 1)),
];
if (topFindings.length) { w("**Major findings**"); w(); for (const f of topFindings) w(`- ${clean(f)}`); w(); }

// The "inspect before approving" callout, assembled from the flag inventory.
const inspect = [];
if (reviewQueue.length) {
  inspect.push(`**${reviewQueue.length} grading-review item(s)** await adjudication before the scores are final:`);
  for (const r of reviewQueue) inspect.push(`  - ${r.prompt_id} / ${r.surface} / r${r.run_index ?? r.run}, ${r.criterion}: ${clean(r.reason)}${r.note ? ` (${clean(r.note)})` : ""}`);
}
const vf = importance?.verify_first ?? levers?.verify_first ?? findings?.verify_first ?? [];
if (vf.length) inspect.push(`**Verify first** (indeterminate, not scored as gaps, confirm before prescribing): ${vf.join(", ")}.`);
const needsReview = levers?.needs_review ?? [];
if (needsReview.length) inspect.push(`**Needs-review lever elements** (judge failed or evidence unvalidated): ${needsReview.join(", ")}.`);
for (const r of (levers?.risk_register ?? [])) inspect.push(`**Risk (${r.source}):** ${clean(r.note)}`);
if (fixes?.notes) inspect.push(`**Strategist note:** ${clean(fixes.notes)}`);
if (inspect.length) {
  w("**Inspect before approving**");
  w();
  for (const i of inspect) w(`- ${i}`);
  w();
}

// ---------- BELOW THE FOLD: full record ----------
w("---");
w();
w("## Full record");
w();

for (const [t, label] of [["discoverability", "Discoverability"], ["assessment", "Assessment"]]) {
  const fd = findings?.[t]; if (!fd) continue;
  const p = pf(t);
  w(`### ${label} scorecard${fd.diagnosis ? ` (${clean(fd.diagnosis)})` : ""}`);
  w();
  w(`Mention ${pct(fd.mention_rate)} · citation ${pct(fd.citation_rate)} · performance ${num(fd.avg_performance)} / 5 blended, ${num(fd.portrayal_when_named)} / 5 portrayal-when-named${p.n_named != null ? ` (named in ${p.n_named} of ${p.n})` : ""}.`);
  const bysurf = metrics?.performance?.[`${t}_by_surface`];
  if (bysurf) w(`By surface: ${Object.entries(bysurf).map(([s, v]) => `${s} ${v.blended_avg}`).join(" · ")}.`);
  w();
  for (const f of (fd.key_findings ?? [])) w(`- ${clean(f)}`);
  w();
}

// Lever rollups
if (levers?.levers) {
  w("### Lever scores");
  w();
  w("| Lever | Score |");
  w("| --- | --- |");
  for (const [lev, obj] of Object.entries(levers.levers)) w(`| ${lev} | ${obj.score ?? "n/a"} |`);
  if (levers.jobs) w(`\nJob rollups: discoverability ${levers.jobs.discoverability_levers}, assessment ${levers.jobs.assessment_levers}.`);
  w();
}

// Element scores + importance matrix
if (importance?.matrix?.length) {
  w("### Element scores and importance matrix");
  w();
  w("One row per element and job. Research importance is the literature prior (tier); run importance is what this audit observed; blended is the 25/75 weighting. Priority is blended x gap.");
  w();
  w("| Element | Lever | Job | Tier | Score | Research | Run | Blended | Gap | Priority |");
  w("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  const rows = [...importance.matrix].sort((a, b) => (b.priority ?? -1) - (a.priority ?? -1));
  for (const r of rows) {
    w(`| ${r.dimension} | ${r.lever} | ${r.job} | ${r.tier} | ${r.audit_score ?? DASH} | ${r.research_importance} | ${r.run_importance} | ${r.blended_importance} | ${r.gap ?? DASH} | ${r.priority ?? DASH} |`);
  }
  w();
}

// Strategist fixes, full
if (fixes?.fixes?.length) {
  w("### Recommended fixes");
  w();
  w(`The strategist's reasoned, re-ranked fix set (rank 1 = do first). ${fixes.fixes.length} fixes across both jobs.`);
  w();
  for (const f of [...fixes.fixes].sort((a, b) => a.rank - b.rank)) {
    w(`#### ${f.rank}. ${clean(f.title)}`);
    w(`*${f.element} · ${f.lever} · ${f.job} · effort ${f.effort ?? "n/a"}${f.base_priority != null ? ` · base priority ${f.base_priority}` : ""}*`);
    if (Array.isArray(f.covers) && f.covers.length) w(`Covers: ${f.covers.join(", ")}.`);
    w();
    if (f.why) w(`- **Why:** ${clean(f.why)}`);
    if (f.how) w(`- **How:** ${clean(f.how)}`);
    if (f.metric_moved) w(`- **Moves:** ${clean(f.metric_moved)}`);
    if (f.rank_reason) w(`- **Rank note:** ${clean(f.rank_reason)}`);
    if (Array.isArray(f.depends_on) && f.depends_on.filter(Boolean).length) w(`- **Depends on:** ${f.depends_on.filter(Boolean).join(", ")}`);
    w();
  }
}

// Competitive map
if (metrics) {
  w("### Competitive map");
  w();
  const sov = metrics.share_of_voice;
  if (sov) {
    const comps = Object.entries(sov.competitors ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 8);
    w(`Share of voice (category answers): **${company} ${sov.brand}**${comps.length ? ", " + comps.map(([n, c]) => `${n} ${c}`).join(", ") : ""}.`);
    w();
  }
  const tcd = metrics.top_cited_domains?.discoverability;
  if (tcd?.length) {
    w("Top third-party domains the model cites for the category:");
    for (const d of tcd.slice(0, 6)) w(`- ${d.host} (${d.source_type}): cited in ${d.n_answers} answers (${pct(d.rate)})`);
    w();
  }
  const h2h = metrics.comparison?.head_to_head;
  if (h2h) { w(`Head-to-head vs ${(h2h.rival ?? []).join("/")}: ${h2h.win} win / ${h2h.tie} tie / ${h2h.loss} loss (win rate ${pct(h2h.win_rate)}).`); w(); }
  const alt = metrics.comparison?.alternatives_capture;
  if (alt) { w(`Alternatives capture vs ${(alt.rival ?? []).join("/")}: ${pct(alt.capture_rate)} (${alt.n} runs).`); w(); }
}

// Linked docs + metadata
w("### Inputs and linked docs");
w();
w(`- Positioning and entity context: \`companies/${slug}/context.md\``);
w(`- Run-aware fix brief: \`companies/${slug}/fix-context.md\``);
w(`- Machine artifacts: levers.json, importance.json, fixes.json, metrics.json, findings.json`);
w();

await writeFile(`${dir}/findings.md`, L.join("\n") + "\n");
console.log(`findings -> ${dir}/findings.md  (${L.length} lines)`);
