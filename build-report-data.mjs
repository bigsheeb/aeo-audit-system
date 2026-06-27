// Report-data builder — deterministic, key-free, no deps. Produces
// companies/<slug>/report-data.json: the flat token -> string dataset that
// build-report.mjs renders into the in-page HTML report. (Formerly build-deck.mjs
// -> canva-fill.json, named for a retired Canva master; the deck path is gone and
// the report is plain HTML.) Only the tokens build-report actually renders are
// emitted; the rest of the legacy token set is dropped.
//
//   node build-report-data.mjs <slug>
//
// Two kinds of token:
//   - mechanical (rates, scores, SOV, cited domains, dimension counts, best/worst
//     tables, fix labels) resolve straight from the company JSONs (metrics,
//     levers, prompts, classified).
//   - editorial one-liners (gap callouts, insights, fix prose) come from
//     companies/<slug>/deck-overrides.json (insights-stager) so they stay tight
//     and on-voice. fix_target_1..3 pin which elements the fixes address.
// Missing REQUIRED values abort (exit 1) — the report never ships with a hole.
// Run prose-lint.mjs on deck-overrides.json as the copy gate.

import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const slug = process.argv[2];
if (!slug) throw new Error("usage: node build-report-data.mjs <slug>");
const root = dirname(fileURLToPath(import.meta.url));
const dir = `${root}/companies/${slug}`;
const load = async (f) => JSON.parse(await readFile(`${dir}/${f}`, "utf8"));
const loadOpt = async (f) => { try { return await load(f); } catch { return {}; } };

const [ctx, metrics, findings, reputation, content, site, prompts, overrides] = await Promise.all([
  load("context.json"), load("metrics.json"), load("findings.json"),
  load("reputation.json"), load("content.json"), load("site.json"),
  load("prompts.json"), loadOpt("deck-overrides.json"),
]);
// v2.3 lever/element data (new master, slides 3/9/10/11/12). Optional so the
// builder still works for pre-v2.2 companies that only have the three buckets.
const levers = await loadOpt("levers.json");
const classifiedRows = await (async () => {
  try { return (await readFile(`${dir}/classified.jsonl`, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
})();

const pct = (x) => `${Math.round(x * 100)}%`;
const perf = (x) => `${x.toFixed(2)}`;
const deDash = (s) => s.replace(/\s*—\s*/g, ", ");
const firstPrompt = (track) => deDash((prompts.find((p) => p.track === track)?.text || "").trim());

const scoreList = (dims, labels) =>
  Object.entries(labels)
    .map(([k, label]) => ({ label, score: dims[k]?.score }))
    .filter((d) => d.score != null)
    .sort((a, b) => b.score - a.score || a.label.localeCompare(b.label))
    .map((d) => `${d.label} ${d.score}`)
    .join(", ");

const repLabels = { press: "Press", directories: "Directories", wikipedia: "Wikipedia", podcasts_bylines: "Podcasts", reddit: "Reddit", review_site: "Review sites", listicles: "Listicles" };
const contentLabels = { original_research_data: "Original research", definitive_guides: "Definitive guides", named_frameworks: "Named frameworks", backlinks_syndication: "Backlinks", publishing_cadence: "Cadence" };
const siteLabels = { fetchability_no_js: "Fetchable without JS", llms_txt: "llms.txt", schema_markup: "Schema", claim_sentence_density: "Claim density", team_about_clarity: "About and team", internal_linking: "Internal links", faq_presence: "FAQ", pricing_clarity: "Pricing" };

const sovRanked = () => [[ctx.company, metrics.share_of_voice.brand], ...Object.entries(metrics.share_of_voice.competitors)]
  .sort((a, b) => b[1] - a[1] || (a[0] === ctx.company ? -1 : b[0] === ctx.company ? 1 : a[0].localeCompare(b[0])));
const sovTable = () => sovRanked().map(([name, n]) => `${name} ${n}`).join(", ");

const srcLabel = { own_domain: "you", competitor: "competitor", listicle: "listicle", news_press: "press", reference: "reference", explainer: "explainer", reddit: "Reddit", review_site: "review site", wikipedia: "Wikipedia", directory: "directory", video: "video", press_or_other: "third-party", other: "other" };
const topCited = () =>
  (metrics.top_cited_domains?.discoverability || []).slice(0, 3)
    .map((d) => `${d.host} ${pct(d.rate)} (${srcLabel[d.source_type] || d.source_type})`)
    .join(", ");

const editorial = ["disc_gap", "assess_gap", "cited_insight", "sov_insight", "rep_summary", "content_summary", "site_summary", "rep_top_fix", "content_top_fix", "site_top_fix"];

const tokens = {
  company: ctx.company,
  audit_date: overrides.audit_date,
  disc_example_prompt: firstPrompt("discoverability"),
  assess_example_prompt: firstPrompt("assessment"),
  disc_mention: pct(metrics.by_track.discoverability.mention_rate),
  disc_citation: pct(metrics.by_track.discoverability.citation_rate),
  // Deck numbers come from the deterministic metrics compute, never from the
  // stager's prose. Fallback to findings only for pre-upgrade companies.
  disc_performance: perf(metrics.performance?.discoverability?.blended_avg ?? findings.discoverability.avg_performance),
  assess_mention: pct(metrics.by_track.assessment.mention_rate),
  assess_citation: pct(metrics.by_track.assessment.citation_rate),
  assess_performance: perf(metrics.performance?.assessment?.blended_avg ?? findings.assessment.avg_performance),
  sov_table: sovTable(),
  top_cited_domains: topCited(),
  rep_scores: scoreList(reputation.dimensions, repLabels),
  content_scores: scoreList(content.dimensions, contentLabels),
  site_scores: scoreList(site.dimensions, siteLabels),
  ...Object.fromEntries(editorial.map((k) => [k, overrides[k]])),
};

// Resolved token dataset — flat field -> string. Built as a superset (joined list
// strings + exploded per-item fields) for validation; the write step below emits
// only the subset build-report.mjs renders. All formatting is done here.
const padN = (a, n) => a.concat(Array(Math.max(0, n - a.length)).fill("")).slice(0, n);
const ranked = sovRanked();
const nDisc = metrics.share_of_voice.n_discoverability || 1;
const cited = (metrics.top_cited_domains?.discoverability || []).slice(0, 6);
const scoreFields = (dims, labels, prefix) =>
  Object.fromEntries(Object.keys(labels).filter((k) => dims[k]?.score != null).map((k) => [`${prefix}_score_${k}`, String(dims[k].score)]));

// ---- v2.3 tokens for the new master (slides 3, 9, 10, 11, 12) ----
const LEVER_LABEL = { access: "Access", identity: "Identity", content: "Content", reputation: "Reputation" };
const DIM_LABEL = {
  ai_crawler_access: "AI Crawler Access", search_index_presence: "Search Index Presence",
  fetchability_no_js: "Bot Fetchability", crawl_coverage: "Crawl Coverage",
  company_home: "Company Home", offering_home: "Canonical Offerings", branded_faq: "Branded FAQ",
  entity_schema: "Entity Schema", name_binding: "Name Binding", directory_consistency: "Directory Consistency",
  wikipedia_wikidata: "Wikipedia & Wikidata",
  original_research_data: "Original Research", category_guides: "Category Guides",
  comparison_pages: "Comparison Pages", case_studies: "Case Studies", content_engine: "Content Engine",
  answer_structure: "Answer Structure",
  pricing_transparency: "Pricing Transparency", developer_docs: "Developer Docs",
  press_earned_media: "Earned Press", category_pub_mentions: "Category Publications", review_sites: "Review Sites",
  reddit: "Reddit", podcasts: "Podcasts", youtube: "YouTube", executive_social: "Executive Social",
  community_forums: "Community Forums",
};
// Character caps enforced on generated rationale text so it fits its slide frame.
// rationale: slides 11/12 best/worst tables — ~648px cells render ~55 chars/line,
// and each row cleanly holds 2 lines before it crosses the grid line into the next
// row (rows ~125px apart). 110 keeps the longest rationale at ~2 lines. The text
// rows have no per-row shape to pin (unlike slide 3 cards), so this cap IS the fix.
// fix: slide 13 cards.
const CAPS = { rationale: 110, fix: 160 };
// Sentence-boundary trim: pack whole sentences up to the cap (greedy), accept any
// boundary past 25% of the cap so a short clean first sentence beats a long
// mid-thought "..." cut. Word-boundary "..." only when even sentence 1 overruns.
const trimAt = (s, n) => {
  s = String(s ?? "").trim();
  if (s.length <= n) return s;
  const cut = s.slice(0, n + 1);
  const end = Math.max(...[". ", "! ", "? ", "; "].map((b) => cut.lastIndexOf(b)));
  if (end >= Math.ceil(n / 4)) return cut.slice(0, end + 1).trim().replace(/[;,]$/, "");
  return (s.slice(0, n - 3).replace(/\s+\S*$/, "") + "...").trim();
};

const els = [];
for (const [lev, obj] of Object.entries(levers.levers ?? {})) {
  for (const [id, e] of Object.entries(obj.elements ?? {})) {
    if (!Number.isInteger(e.score)) continue;
    const imp = Math.max(0, ...Object.values(e.importance ?? {}));
    els.push({ id, lever: LEVER_LABEL[lev] ?? lev, label: DIM_LABEL[id] ?? id, score: e.score,
      rationale: e.rationale ?? "", importance: imp, priority: e.priority ?? 0, verify_first: e.verify_first === true });
  }
}
// Operator call 2026-06-11: reddit is measured internally but never surfaced on
// deck tables or fixes (unobservable too often, and the fix is a rabbit hole).
const DECK_EXCLUDED = new Set(["reddit"]);
const deckEls = els.filter((e) => !DECK_EXCLUDED.has(e.id));

// Direction guards: the best table only carries genuinely good scores (>=4) and
// the worst table only genuinely bad ones (<=2). Mid scores (3) headline neither.
// When a client skews one way, unfilled rows render "N/A" instead of borrowing
// findings from the wrong direction.
const best4 = deckEls.filter((e) => e.score >= 4)
  .sort((a, b) => b.score - a.score || b.importance - a.importance).slice(0, 4);
const worst4 = deckEls.filter((e) => !e.verify_first && e.score <= 2)
  .sort((a, b) => a.score - b.score || b.priority - a.priority).slice(0, 4);
const dimCount = (label) => els.filter((e) => e.lever === label).length;
// Lever rollup scores (slide 10 scoreboard). One decimal on the 0-5 scale;
// empty for pre-v2.2 companies without levers.json, matching the dim_* pattern.
const leverScore = (k) => (typeof levers.levers?.[k]?.score === "number" ? levers.levers[k].score.toFixed(1) : "");

// Top-3 fixes by priority (importance x gap), deduped by element, max across the two tracks.
const prio = [...(levers.priorities?.discoverability ?? []), ...(levers.priorities?.assessment ?? [])]
  .filter((p) => !DECK_EXCLUDED.has(p.element));
const fixTop = [...new Map(prio.sort((a, b) => b.priority - a.priority).map((p) => [p.element, p])).values()].slice(0, 3);

const nPrompts = (t) => prompts.filter((p) => p.track === t).length;
const nResponses = (t) => classifiedRows.filter((r) => r.track === t).length;
const surfacesSeen = [...new Set(classifiedRows.map((r) => r.surface))];

const reportData = {
  company: tokens.company, audit_date: tokens.audit_date,
  disc_example_prompt: tokens.disc_example_prompt, assess_example_prompt: tokens.assess_example_prompt,
  disc_mention: tokens.disc_mention, disc_citation: tokens.disc_citation, disc_performance: tokens.disc_performance,
  assess_mention: tokens.assess_mention, assess_citation: tokens.assess_citation, assess_performance: tokens.assess_performance,
  disc_gap: tokens.disc_gap, assess_gap: tokens.assess_gap, cited_insight: tokens.cited_insight, sov_insight: tokens.sov_insight,
  rep_summary: tokens.rep_summary, content_summary: tokens.content_summary, site_summary: tokens.site_summary,
  rep_top_fix: tokens.rep_top_fix, content_top_fix: tokens.content_top_fix, site_top_fix: tokens.site_top_fix,
  // fixes: the stager pins elements via fix_target_N and writes fix_N prose; the
  // label always derives from the same element as the text. Fallbacks: builder's
  // own priority ranking (fixTop) with the element rationale as placeholder text,
  // then the legacy three-bucket fixes for pre-v2.2 companies.
  ...Object.fromEntries([1, 2, 3].flatMap((n) => {
    const el = els.find((e) => e.id === overrides[`fix_target_${n}`])
      ?? (fixTop[n - 1] ? els.find((e) => e.id === fixTop[n - 1].element) : null);
    const legacy = [tokens.rep_top_fix, tokens.content_top_fix, tokens.site_top_fix][n - 1];
    return [
      [`fix_${n}`, overrides[`fix_${n}`] ?? (el ? deDash(trimAt(el.rationale, CAPS.fix)) : legacy)],
      [`fix_label_${n}`, el ? `${el.lever} - ${el.label}` : ""],
    ];
  })),
  // v2.3 tokens: prompt/response counts (slide 3), dimension counts (slide 9), lever scores (slide 10), best/worst tables (slides 11-12), fixes (slide 13)
  disc_prompt_number: String(nPrompts("discoverability") || ""),
  assess_prompt_number: String(nPrompts("assessment") || ""),
  disc_response_number: String(nResponses("discoverability") || ""),
  assess_response_number: String(nResponses("assessment") || ""),
  run_disclosure: classifiedRows.length ? `${classifiedRows.length} responses across ${surfacesSeen.length} AI surfaces` : "",
  dim_access: String(dimCount("Access") || ""), dim_identity: String(dimCount("Identity") || ""),
  dim_content: String(dimCount("Content") || ""), dim_reputation: String(dimCount("Reputation") || ""),
  dim_total: String(els.length || ""),
  score_access: leverScore("access"), score_identity: leverScore("identity"),
  score_content: leverScore("content"), score_reputation: leverScore("reputation"),
  ...Object.fromEntries([0, 1, 2, 3].flatMap((i) => {
    const e = best4[i]; // N/A fill when fewer than 4 elements clear the >=4 bar
    return [
      [`best_lever_${i + 1}`, e?.lever ?? "N/A"], [`best_dim_${i + 1}`, e?.label ?? "N/A"],
      [`best_score_${i + 1}`, e ? String(e.score) : "N/A"], [`best_rationale_${i + 1}`, overrides[`best_rationale_${i + 1}`] ?? (e ? deDash(trimAt(e.rationale, CAPS.rationale)) : "N/A")],
    ];
  })),
  ...Object.fromEntries([0, 1, 2, 3].flatMap((i) => {
    const e = worst4[i]; // N/A fill when fewer than 4 elements sit at <=2
    return [
      [`worst_lever_${i + 1}`, e?.lever ?? "N/A"], [`worst_dim_${i + 1}`, e?.label ?? "N/A"],
      [`worst_score_${i + 1}`, e ? String(e.score) : "N/A"], [`worst_rationale_${i + 1}`, overrides[`worst_rationale_${i + 1}`] ?? (e ? deDash(trimAt(e.rationale, CAPS.rationale)) : "N/A")],
    ];
  })),
  sov_table: tokens.sov_table, top_cited_domains: tokens.top_cited_domains,
  rep_scores: tokens.rep_scores, content_scores: tokens.content_scores, site_scores: tokens.site_scores,
  ...Object.fromEntries(padN(ranked.map(([n]) => n), 8).map((n, i) => [`sov_label_${i + 1}`, n])),
  ...Object.fromEntries(padN(ranked.map(([, v]) => String(v)), 8).map((v, i) => [`sov_value_${i + 1}`, v])),
  ...Object.fromEntries(padN(ranked.map(([, v]) => Math.round((v / nDisc) * 100) + "%"), 8).map((p, i) => [`sov_pct_${i + 1}`, p])),
  ...Object.fromEntries(padN(cited.map((d) => d.host), 6).map((h, i) => [`cited_host_${i + 1}`, h])),
  ...Object.fromEntries(padN(cited.map((d) => `${pct(d.rate)} · ${srcLabel[d.source_type] || d.source_type}`), 6).map((m, i) => [`cited_meta_${i + 1}`, m])),
  ...Object.fromEntries(padN(cited.map((d) => pct(d.rate)), 6).map((r, i) => [`cited_rate_${i + 1}`, r])),
  ...scoreFields(reputation.dimensions, repLabels, "rep"),
  ...scoreFields(content.dimensions, contentLabels, "content"),
  ...scoreFields(site.dimensions, siteLabels, "site"),
};

// Character caps from the Canva master frames (inspection-based, tunable). Warn on overflow.
const LIMITS = {
  company: 30, audit_date: 20,
  disc_example_prompt: 130, assess_example_prompt: 130,
  disc_gap: 130, assess_gap: 130, cited_insight: 160, sov_insight: 130,
  fix_1: CAPS.fix, fix_2: CAPS.fix, fix_3: CAPS.fix,
  fix_label_1: 44, fix_label_2: 44, fix_label_3: 44,
  rep_summary: 110, content_summary: 110, site_summary: 110,
  rep_top_fix: 160, content_top_fix: 160, site_top_fix: 160,
  ...Object.fromEntries([1, 2, 3, 4].flatMap((n) => [
    [`best_rationale_${n}`, CAPS.rationale], [`worst_rationale_${n}`, CAPS.rationale],
  ])),
};
const over = Object.keys(LIMITS)
  .filter((k) => typeof reportData[k] === "string" && reportData[k].length > LIMITS[k])
  .map((k) => `${k} ${reportData[k].length}/${LIMITS[k]}`);
if (over.length) console.warn(`! over character cap (clips in fixed frames): ${over.join(", ")}`);

// The report never ships with a hole: these must resolve from deck-overrides.json
// (editorial) or levers.json (fix fallbacks) before the report renders.
const REQUIRED = ["company", "audit_date", "disc_gap", "assess_gap", "cited_insight", "sov_insight", "fix_1", "fix_2", "fix_3"];
const missing = REQUIRED.filter((k) => !reportData[k]);
if (missing.length) {
  console.error(`Missing required report values: ${missing.join(", ")} — fill deck-overrides.json (or run score-levers.mjs for fix fallbacks).`);
  process.exit(1);
}

// Emit only the tokens build-report.mjs renders. The retired Canva master
// consumed a much larger flat token set (exploded SOV/cited forms, per-dimension
// sub-scores, prompt/response counts); the in-page HTML report reads ~86 of them.
// Dropping the rest keeps report-data.json to exactly what ships. Validation
// (LIMITS/REQUIRED above) still runs against the full resolved set.
const KEEP = new Set(["company", "logo", "run_disclosure", "audit_date", "disc_example_prompt", "assess_example_prompt", "disc_mention", "disc_citation", "disc_performance", "disc_gap", "assess_mention", "assess_citation", "assess_performance", "assess_gap", "sov_insight", "cited_insight", "dim_total", "score_access", "score_identity", "score_content", "score_reputation"]);
const KEEP_RE = /^(sov_label|sov_pct|cited_host|cited_rate)_\d+$|^(best|worst)_(lever|dim|score|rationale)_\d+$|^fix_\d+$|^fix_label_\d+$/;
const emit = Object.fromEntries(Object.entries(reportData).filter(([k]) => KEEP.has(k) || KEEP_RE.test(k)));

await writeFile(`${dir}/report-data.json`, JSON.stringify(emit, null, 2) + "\n");
console.log(`report-data -> ${dir}/report-data.json  (${Object.keys(emit).length} fields, ${over.length} over cap)`);
