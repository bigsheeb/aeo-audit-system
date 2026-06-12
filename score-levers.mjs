// Lever scorer — framework v2.2. Freeze-then-score: reads the frozen facts
// ledgers (access.json, site-facts.json, onsite-facts.json, offsite-facts.json)
// plus post-run inputs (graded.jsonl for wrong_entity, consideration.json,
// classified.jsonl citations), then scores every applicable element:
//
//   - mech elements: computed here in code, reproducible by construction.
//   - judged elements: pinned judge at temp 0 against the rubric anchors, with
//     verbatim evidence quotes validated by substring match against the facts.
//     A failed validation retries once, then lands in needs_review.
//
// Output: companies/<slug>/levers.json — element scores, lever rollups, the two
// job rollups, risk register, needs_review, and full version/judge metadata.
//
//   node score-levers.mjs <slug>

import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { complete } from "./lib/openrouter.mjs";
import { ELEMENTS, FACTS_SOURCE, VALIDATION_SOURCES, VALIDATION_DOMAINS, IMPORTANCE, LOCAL_SIGNAL, FRAMEWORK_VERSION, RUBRIC_VERSION, applicable } from "./lib/rubric.mjs";

const JUDGE_MODEL = process.env.AUDIT_JUDGE_MODEL ?? "anthropic/claude-sonnet-4.6";
const slug = process.argv[2];
if (!slug) throw new Error("usage: node score-levers.mjs <slug> [--importance-only]");
// --importance-only: recompute the importance/priority layer over the existing
// levers.json (no judge calls). Use after classify re-runs or weight changes.
const importanceOnly = process.argv.includes("--importance-only");
const root = dirname(fileURLToPath(import.meta.url));
const dir = `${root}/companies/${slug}`;

const load = async (f) => JSON.parse(await readFile(`${dir}/${f}`, "utf8"));
const loadOpt = async (f) => { try { return await load(f); } catch { return null; } };
const loadJsonl = async (f) => { try { return (await readFile(`${dir}/${f}`, "utf8")).split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

const ctx = await load("context.json");
const profiles = [ctx.audit_profile?.primary, ctx.audit_profile?.secondary].filter(Boolean);
if (!profiles.length) throw new Error("context.json needs audit_profile { primary, secondary? } — set at prep, reviewed at Gate 1");

const access = await loadOpt("access.json");
const siteFacts = await loadOpt("site-facts.json");
const onsite = await loadOpt("onsite-facts.json");
const offsite = await loadOpt("offsite-facts.json");
const graded = await loadJsonl("graded.jsonl");
const classified = await loadJsonl("classified.jsonl");
const consideration = await loadOpt("consideration.json");
const prompts = (await loadOpt("prompts.json")) ?? [];

const clamp = (x) => Math.max(0, Math.min(5, Math.round(x)));
const round1 = (x) => Math.round(x * 10) / 10;

// ---- mechanical scorers ----
function mechScore(id) {
  if (!access && ["ai_crawler_access", "search_index_presence"].includes(id)) return null;
  switch (id) {
    case "ai_crawler_access": {
      let s = 5; const why = [];
      if (access.robots?.present && !access.robots?.valid) { s -= 1; why.push("robots.txt is not a real file"); }
      for (const [bot, info] of Object.entries(access.bot_rules ?? {})) {
        if (info.allowed) continue;
        if (info.class === "search" || info.class === "user") { s -= 1.5; why.push(`${bot} (${info.class}) robots-blocked`); }
        else if (info.class === "training") { s -= 0.25; why.push(`${bot} (training) blocked — defensible opt-out`); }
      }
      const control = access.ua_probes?.control;
      if (control && !control.blocked) {
        for (const [bot, p] of Object.entries(access.ua_probes)) {
          if (bot === "control" || !p.blocked) continue;
          s -= (access.bot_rules?.[bot]?.class === "training") ? 0.5 : 1.5;
          why.push(`${bot} UA blocked at the edge (HTTP ${p.status ?? "error"})`);
        }
      }
      return { score: clamp(s), rationale: why.length ? why.join("; ") : "no AI search/user bot blocked in robots or at the edge" };
    }
    case "search_index_presence": {
      const ix = access.index_presence ?? {};
      const states = [ix.bing?.indexed, ix.brave?.indexed]; // google recorded, unscored in v1 surfaces
      if (states.includes(false)) return { score: 0, rationale: `absent from a gating index (bing=${ix.bing?.indexed}, brave=${ix.brave?.indexed})` };
      if (states.every((v) => v === true)) return { score: 5, rationale: "present in Bing and Brave" };
      // Unknown is not a gap: an indeterminate check must not generate fix priority.
      return { score: 3, indeterminate: true, rationale: `present where determinable, others indeterminate (bing=${ix.bing?.indexed}, brave=${ix.brave?.indexed}) — verify before prescribing` };
    }
    case "fetchability_no_js": {
      const ps = siteFacts?.elements?.fetchability_no_js?.facts ?? [];
      if (!ps.length) return null;
      const live = ps.filter((p) => p.status === 200);
      const shells = live.filter((p) => p.spa_shell);
      const noBrand = live.filter((p) => !p.brand_in_raw);
      const thin = live.filter((p) => p.text_chars < 800);
      let s = 5; const why = [];
      if (shells.length) { s -= 3; why.push(`SPA shell on ${shells.length} page(s)`); }
      if (noBrand.length) { s -= 1.5; why.push(`brand absent from raw text on ${noBrand.length} page(s)`); }
      else if (thin.length > live.length / 2) { s -= 1; why.push(`thin raw text on ${thin.length}/${live.length} pages`); }
      return { score: clamp(s), rationale: why.length ? why.join("; ") : `full raw-HTML parity signals across ${live.length} sampled pages` };
    }
    case "crawl_coverage": {
      const f = siteFacts?.elements?.crawl_coverage?.facts;
      if (!f) return null;
      let s = 5; const why = [];
      const robotsValid = access?.robots?.valid ?? false;
      if (!f.sitemap_real) { s -= 1.5; why.push("no real XML sitemap"); }
      if (!robotsValid) { s -= 1; why.push("no valid robots.txt (no crawl map pointer)"); }
      const [c, n] = (f.canonical_on_sample ?? "0/1").split("/").map(Number);
      if (n && c / n < 0.5) { s -= 1; why.push(`canonical on only ${f.canonical_on_sample} sampled pages`); }
      if (f.homepage_og_type && !/website|organization/i.test(f.homepage_og_type)) { s -= 0.5; why.push(`homepage og:type=${f.homepage_og_type}`); }
      if (!f.about_page) { s -= 0.5; why.push("no about page discoverable from nav"); }
      return { score: clamp(s), rationale: why.length ? why.join("; ") : "sitemap + canonicals + navigable structure all present" };
    }
    case "entity_schema": {
      const ps = siteFacts?.elements?.entity_schema?.facts ?? [];
      if (!ps.length) return null;
      const types = new Set(ps.flatMap((p) => p.ld_types));
      const sameAs = ps.reduce((a, p) => a + (p.sameAs_count || 0), 0);
      const has = (t) => [...types].some((x) => x.toLowerCase().includes(t));
      let s = 0;
      if (types.size) s = 2;
      if (has("organization")) s = 3;
      if (has("organization") && sameAs > 0) s = 4;
      if (has("organization") && sameAs > 0 && (has("person") || has("product") || has("article") || has("faqpage"))) s = 5;
      return { score: s, rationale: types.size ? `types on sample: ${[...types].join(", ")}; sameAs links: ${sameAs}` : "zero JSON-LD on the sampled pages" };
    }
    case "content_freshness": {
      const f = siteFacts?.elements?.content_freshness?.facts;
      if (!f) return null;
      const latest = [f.latest_date_on_sample, f.latest_post_date].filter(Boolean).sort().at(-1);
      const [d, n] = (f.pages_with_dates ?? "0/1").split("/").map(Number);
      if (!latest && !d) return { score: 0, rationale: "no machine-readable dates anywhere on the sample" };
      const ageDays = latest ? Math.floor((Date.now() - new Date(latest)) / 86400000) : 9999;
      let s; let why;
      if (ageDays <= 180 && d / n >= 0.3) { s = 5; why = `latest dated content ${latest} (${ageDays}d old), dates on ${f.pages_with_dates} pages`; }
      else if (ageDays <= 180) { s = 4; why = `fresh blog (${latest}) but commercial pages mostly undated (${f.pages_with_dates})`; }
      else if (ageDays <= 365) { s = 3; why = `latest dated content ${latest} (${ageDays}d)`; }
      else { s = 2; why = `stale: latest dated content ${latest} (${ageDays}d)`; }
      return { score: s, rationale: why };
    }
    default: return null;
  }
}

// ---- judged scorer ----
const parseJSON = (text) => {
  const cleaned = String(text).replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  const s = cleaned.search(/[{[]/);
  const e = cleaned.lastIndexOf("}");
  if (s === -1 || e < s) throw new Error("no JSON in judge output");
  return JSON.parse(cleaned.slice(s, e + 1));
};
const norm = (s) => String(s).toLowerCase().replace(/\s+/g, " ").trim();

function extraInputs(id) {
  switch (id) {
    case "branded_faq":
      return { assessment_questions: prompts.filter((p) => p.track === "assessment").map((p) => p.text) };
    case "name_binding": {
      const assess = graded.filter((r) => r.track === "assessment");
      const flagged = assess.filter((r) => (r.flags ?? []).some((f) => /wrong_entity|conflat/i.test(f)));
      return { audit_wrong_entity: { rate: `${flagged.length} of ${assess.length} assessment answers flagged wrong_entity/conflation`, rows: flagged.map((r) => ({ prompt_id: r.prompt_id, surface: r.surface, note: (r.rationale ?? "").slice(0, 200) })) } };
    }
    case "comparison_pages": {
      const sov = consideration?.judgments?.filter((j) => j.in_category)?.map((j) => j.name) ?? [];
      return { real_rivals_from_answers: sov, prep_competitors: (ctx.competitors ?? []).map((c) => c.name) };
    }
    case "third_party_validation":
      return { resolved_sources: [...new Set(profiles.flatMap((p) => VALIDATION_SOURCES[p] ?? []))] };
    case "pricing_transparency":
      return { profile_meaning: profiles[0] === "enterprise_b2b" ? "pricing-model clarity (enterprise)" : profiles[0] === "plg_saas" ? "public parseable numbers" : "judge per anchors for primary profile " + profiles[0] };
    case "blog_engine":
      return { last_posts: siteFacts?.elements?.blog_engine?.facts?.last_posts ?? [] };
    default: return {};
  }
}

async function judgeScore(el, facts) {
  const extras = extraInputs(el.id);
  const factsBlob = JSON.stringify({ facts, ...extras }, null, 1).slice(0, 14000);
  const prompt = `You are scoring ONE element of an AEO/GEO audit against a fixed anchored rubric. Company: ${ctx.company} (${ctx.domain}). Audit profile: ${profiles.join(" + ")}. Category terms: ${(ctx.category_terms ?? []).slice(0, 6).join(", ")}.

ELEMENT: ${el.id}
ANCHORS (score strictly against these):
${el.anchors}

FROZEN FACTS (the only evidence you may use; do not assume anything not present here):
${factsBlob}

Rules: choose the integer 0-5 whose anchor best matches the facts. If facts are thin or marked directional/fallback, do not award extreme scores without support. Provide 1-3 evidence quotes COPIED VERBATIM from the facts above. No em dashes anywhere in your output. Your FIRST reasoning sentence must stand alone as a complete deck-ready summary of the verdict in under 180 characters (the deck prints only what fits; later sentences carry the detail).

Return ONLY JSON: {"reasoning": "<2-4 sentences against the anchors; sentence 1 = standalone summary under 180 chars>", "score": <0-5 integer>, "evidence": ["<verbatim substring of the facts>", ...]}`;

  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { text } = await complete(prompt, { model: JUDGE_MODEL, max_tokens: 1200 });
      const out = parseJSON(text);
      const score = Number(out.score);
      if (!Number.isInteger(score) || score < 0 || score > 5) throw new Error(`bad score ${out.score}`);
      const hay = norm(factsBlob);
      const evidence = [].concat(out.evidence ?? []).filter((q) => typeof q === "string" && q.length > 5);
      const valid = evidence.length > 0 && evidence.every((q) => hay.includes(norm(q).slice(0, 180)));
      if (!valid && attempt === 1) continue; // retry once on evidence failure
      return { score, rationale: String(out.reasoning ?? "").replace(/—/g, ", "), evidence, evidence_validated: valid, needs_review: !valid };
    } catch (e) {
      if (attempt === 2) return { score: null, rationale: `judge failed: ${e.message}`, evidence: [], evidence_validated: false, needs_review: true };
    }
  }
}

// ---- importance layer (v2.3): theory (audit score) x practice (observed citations) ----

// Page-role of a vendor-owned citation (own_domain or competitor), by URL path.
// INTERNAL computation only — page-role detail never reaches the client deliverable;
// it just sharpens which own-content element an observed vendor citation evidences.
const pageRole = (c) => {
  let path = ""; try { path = new URL(c.url).pathname.toLowerCase(); } catch {}
  const h = (c.host ?? "").toLowerCase();
  const t = `${c.title ?? ""} ${path}`.toLowerCase();
  if (/\bvs\b|vs\.|versus|alternativ|compar/.test(t)) return "comparison";
  if (/^(docs|developers?|api)\./.test(h) || /\/(docs|api-reference|reference)(\/|$)/.test(path)) return "docs";
  if (/\/(blog|insights?|news|newsroom|posts?)(\/|$)/.test(path)) return "blog_news";
  if (/\/(about|company|team|who-we-are|leadership)(\/|$)/.test(path)) return "company";
  if (/\/pricing/.test(path)) return "pricing";
  if (/\/(case-stud|customers?|success-stor)/.test(path)) return "case_studies";
  if (/(research|reports?|transparen|attestation|whitepaper)/.test(path)) return "research_trust";
  if (/\/(guides?|learn|academy|glossary)(\/|$)/.test(path)) return "guides";
  if (/\/faq/.test(path)) return "faq";
  if (path === "/" || path === "") return "home";
  return "product";
};

function trackSignals(track) {
  const tr = classified.filter((r) => r.track === track);
  const valDomains = [...new Set(profiles.flatMap((p) => (VALIDATION_SOURCES[p] ?? []).flatMap((s) => VALIDATION_DOMAINS[s] ?? [])))];
  const sig = { total: 0, cls: {}, roles: {}, vendor: 0, validation: 0 };
  for (const r of tr) for (const c of r.citations ?? []) {
    sig.total++;
    sig.cls[c.source_type] = (sig.cls[c.source_type] ?? 0) + 1;
    if (c.source_type === "own_domain" || c.source_type === "competitor") {
      sig.vendor++;
      const role = pageRole(c);
      sig.roles[role] = (sig.roles[role] ?? 0) + 1;
    }
    if (valDomains.some((d) => c.host === d || (c.host ?? "").endsWith("." + d))) sig.validation++;
  }
  return sig;
}

function localSignal(id, sig) {
  const classes = LOCAL_SIGNAL[id] ?? [];
  if (classes[0] === "harm:wrong_entity") {
    // name_binding: importance scales with observed harm, not citation share.
    const assess = graded.filter((r) => r.track === "assessment");
    const bad = assess.filter((r) => (r.flags ?? []).some((f) => /wrong_entity|conflat/i.test(f))).length;
    return { share: assess.length ? Math.min(1, (bad / assess.length) * 3) : 0, cited: bad, total: assess.length, classes: ["wrong_entity_rate"] };
  }
  if (!sig.total || !classes.length) return { share: 0, cited: 0, total: sig.total, classes };
  const count = (k) =>
    k === "vendor_all" ? sig.vendor :
    k === "validation_domains" ? sig.validation :
    k.startsWith("role:") ? (sig.roles[k.slice(5)] ?? 0) :
    (sig.cls[k] ?? 0);
  const cited = classes.reduce((a, k) => a + count(k), 0);
  // Normalize relative to the dominant citation class in THIS track's answers.
  const maxCount = Math.max(sig.vendor, ...Object.values(sig.cls), 1);
  return { share: Math.min(1, cited / maxCount), cited, total: sig.total, classes };
}

function computeImportance(result) {
  const sigs = { discoverability: trackSignals("discoverability"), assessment: trackSignals("assessment") };
  const tracksFor = (job) => job === "disc" ? ["discoverability"] : job === "assess" ? ["assessment"] : ["discoverability", "assessment"];
  const prior = (tier) => IMPORTANCE.tier_prior[tier] ?? IMPORTANCE.tier_prior_default;
  const priorities = { discoverability: [], assessment: [] };
  for (const [lever, obj] of Object.entries(result.levers)) {
    for (const [id, e] of Object.entries(obj.elements)) {
      // Unknown is not a gap (also catches pre-v2.3 levers.json in --importance-only).
      const indeterminate = e.indeterminate === true || /indeterminate/i.test(e.rationale ?? "");
      const g = prior(e.tier);
      e.importance = {}; e.local_evidence = {};
      let best = 0;
      for (const track of tracksFor(e.job)) {
        const ls = localSignal(id, sigs[track]);
        const raw = IMPORTANCE.w_global * g + IMPORTANCE.w_local * ls.share;
        const I = Math.round((1 + 4 * raw) * 10) / 10;
        e.importance[track] = I;
        e.local_evidence[track] = ls;
        if (Number.isInteger(e.score) && !indeterminate) {
          const gap = 5 - e.score;
          const P = Math.round(I * gap * 10) / 10;
          priorities[track].push({ element: id, lever, priority: P, importance: I, score: e.score, gap });
          best = Math.max(best, P);
        }
      }
      e.priority = indeterminate ? null : best;
      if (indeterminate) e.verify_first = true;
    }
  }
  for (const t of Object.keys(priorities)) priorities[t] = priorities[t].filter((p) => p.priority > 0).sort((a, b) => b.priority - a.priority);
  result.priorities = priorities;
  result.verify_first = Object.values(result.levers).flatMap((o) => Object.entries(o.elements).filter(([, e]) => e.verify_first).map(([id]) => id));
  result.importance_config = { w_global: IMPORTANCE.w_global, w_local: IMPORTANCE.w_local, computed_at: new Date().toISOString() };
}

// ---- run ----
let result;
if (importanceOnly) {
  result = await load("levers.json");
  console.log(`importance-only: recomputing over existing levers.json (scored ${result.scored_at})`);
} else {
  result = {
    slug, company: ctx.company, profile: ctx.audit_profile,
    judge_model: JUDGE_MODEL, scored_at: new Date().toISOString(),
    levers: { access: { elements: {} }, identity: { elements: {} }, content: { elements: {} }, reputation: { elements: {} } },
    not_applicable: [], needs_review: [], missing_facts: [],
  };

  for (const el of ELEMENTS) {
    if (!applicable(el, profiles)) { result.not_applicable.push(el.id); continue; }
    let scored;
    if (el.check === "mech") {
      scored = mechScore(el.id);
      if (!scored) { result.missing_facts.push(el.id); continue; }
      scored = { ...scored, basis: "mechanical" };
    } else {
      const src = FACTS_SOURCE[el.id] === "onsite" ? onsite : offsite;
      const facts = src?.elements?.[el.id] ?? siteFacts?.elements?.[el.id] ?? null;
      if (!facts) { result.missing_facts.push(el.id); continue; }
      process.stdout.write(`judging ${el.id} ... `);
      scored = { ...(await judgeScore(el, facts)), basis: "judged" };
      console.log(scored.score === null ? "FAILED" : `${scored.score}/5${scored.needs_review ? " (needs review)" : ""}`);
      if (scored.needs_review) result.needs_review.push(el.id);
    }
    result.levers[el.lever].elements[el.id] = { job: el.job, tier: el.tier, ...scored };
  }

  // rollups: lever means + the two job rollups (gate counts toward both)
  const scoredEls = [];
  for (const [lever, obj] of Object.entries(result.levers)) {
    const vals = Object.values(obj.elements).map((e) => e.score).filter((s) => Number.isInteger(s));
    obj.score = vals.length ? round1(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
    for (const [id, e] of Object.entries(obj.elements)) scoredEls.push({ id, ...e });
  }
  const jobMean = (pred) => {
    const vals = scoredEls.filter(pred).map((e) => e.score).filter((s) => Number.isInteger(s));
    return vals.length ? round1(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
  };
  result.jobs = {
    discoverability_levers: jobMean((e) => ["disc", "both", "gate"].includes(e.job)),
    assessment_levers: jobMean((e) => ["assess", "both", "gate"].includes(e.job)),
  };

  // risk register: low community/press scores with negative narratives surface here via offsite facts
  result.risk_register = (offsite?.risk_register ?? []).concat(
    scoredEls.filter((e) => e.score === 0 || e.score === 1)
      .filter((e) => ["reddit", "community_forums", "third_party_validation"].includes(e.id))
      .map((e) => ({ source: e.id, note: e.rationale }))
  );
}

computeImportance(result);
result.framework_version = FRAMEWORK_VERSION;
result.rubric_version = result.rubric_version ?? RUBRIC_VERSION;

await writeFile(`${dir}/levers.json`, JSON.stringify(result, null, 2) + "\n");
console.log(`\nlevers -> ${dir}/levers.json`);
for (const [lever, obj] of Object.entries(result.levers)) {
  console.log(`${lever}: ${obj.score ?? "n/a"}  [${Object.entries(obj.elements).map(([id, e]) => `${id} ${e.score ?? "?"}`).join(", ")}]`);
}
console.log(`jobs: disc-levers ${result.jobs?.discoverability_levers} | assess-levers ${result.jobs?.assessment_levers}`);
for (const t of ["discoverability", "assessment"]) {
  const top = (result.priorities?.[t] ?? []).slice(0, 6).map((p) => `${p.element} P${p.priority} (I${p.importance} x gap${p.gap})`).join(" | ");
  console.log(`priorities ${t}: ${top || "none"}`);
}
if (result.verify_first?.length) console.log(`verify first (indeterminate, excluded from priorities): ${result.verify_first.join(", ")}`);
if (result.not_applicable?.length) console.log(`n/a (profile): ${result.not_applicable.join(", ")}`);
if (result.missing_facts?.length) console.log(`missing facts: ${result.missing_facts.join(", ")}`);
if (result.needs_review?.length) console.log(`needs review: ${result.needs_review.join(", ")}`);
