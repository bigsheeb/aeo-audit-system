// content_engine scoring (framework v2.6). A decomposed publishing-quality
// dimension that replaces the old blog_engine + content_freshness elements.
// Six facets, each 0-5, combined by a NORMALIZED weighted mean (so the weights
// need not sum to 1; relative emphasis is what matters), with a nascent-cadence
// gate that caps the element at 2 when real publishing only just started.
//
//   a  frequency          0.10   mech   substantive-post cadence + maturity (+ gate)
//   b  original_perspective 0.30  judged original POV / argument / proprietary insight
//   c  icp_fit             0.30   judged topics map to ICP + category terms
//   d  bylines             0.15   mech   share of substantive posts with an author byline
//   e  structure           0.15   judged communicative titles + clean top summary + headings
//   f  show_dont_tell      0.10   judged specifics/sources vs marketing assertions
//
// frequency + bylines are computed here in code from the site-checks per-post
// facts; the judge classifies each post press|substantive and scores b/c/e/f.
// The judge is injected (the `complete` fn) so this module is unit-testable.

export const CONTENT_ENGINE_WEIGHTS = {
  frequency: 0.10,
  original_perspective: 0.30,
  icp_fit: 0.30,
  bylines: 0.15,
  structure: 0.15,
  show_dont_tell: 0.10,
};

// nascent thresholds: a real (substantive) cadence younger than this, or with
// fewer than this many substantive posts, gates the element at 2.
const NASCENT_MONTHS = 6;
const NASCENT_COUNT = 6;
const MONTH_MS = 2.592e9; // 30 days

const round1 = (x) => Math.round(x * 10) / 10;
const clampInt = (x) => Math.max(0, Math.min(5, Math.round(x)));
// Fold smart punctuation (curly quotes, apostrophes, en/em dashes) to ASCII before
// comparing, so a verbatim quote isn't rejected over a ' vs ' style difference.
const norm = (s) => String(s).toLowerCase()
  .replace(/[‘’′]/g, "'").replace(/[“”″]/g, '"').replace(/[–—]/g, "-")
  .replace(/\s+/g, " ").trim();

const parseJSON = (text) => {
  const cleaned = String(text).replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  const s = cleaned.search(/[{[]/);
  const e = cleaned.lastIndexOf("}");
  if (s === -1 || e < s) throw new Error("no JSON in judge output");
  return JSON.parse(cleaned.slice(s, e + 1));
};

// ---- mech facets ----

// frequency: cadence of SUBSTANTIVE posts + maturity. Returns the 0-5 facet plus
// the cadence stats and a `nascent` flag the caller uses for the element gate.
//
// Maturity is judged from `archiveSize` (the crawler's estimate of the site's
// total live content depth), NOT from the span of the sampled window. We only
// sample the most-recent ~15 items, so the oldest sampled date is a useless
// proxy for site age: a prolific site that ships 12 posts in 3 months would look
// "nascent" (months_active < 6) and get capped, which is backwards. A site is
// nascent only when its whole live archive is genuinely thin (< NASCENT_COUNT).
export function frequencyFacet(subDates, now, archiveSize) {
  const times = (subDates ?? []).map((d) => new Date(d).getTime()).filter((t) => !Number.isNaN(t)).sort((a, b) => a - b);
  const count = times.length;
  const archive = Number.isFinite(archiveSize) ? archiveSize : count; // fall back to sample when crawler gives no depth
  const nascent = archive < NASCENT_COUNT;
  if (!count) return { score: nascent ? 0 : 2, count: 0, months_active: 0, per_month_recent: 0, archive, nascent };
  const monthsActive = Math.max(0, (now - times[0]) / MONTH_MS);
  const recent = times.filter((t) => t >= now - 6 * MONTH_MS).length;
  const perMonthRecent = round1(recent / 6);
  let score;
  if (nascent) score = perMonthRecent >= 1 ? 2 : 1;
  else if (perMonthRecent >= 2) score = 5;       // multiple substantive posts/month, sustained
  else if (perMonthRecent >= 1) score = 4;       // ~monthly+
  else if (perMonthRecent >= 0.5) score = 3;
  else score = 2;                                // a real archive but little fresh substantive output
  return { score: clampInt(score), count, months_active: round1(monthsActive), per_month_recent: perMonthRecent, archive, nascent };
}

// bylines: share of posts carrying an author byline.
export function bylinesFacet(posts) {
  const total = posts.length;
  if (!total) return { score: 0, pct: 0, bylined: 0, total: 0 };
  const bylined = posts.filter((p) => p.byline?.present).length;
  const pct = bylined / total;
  return { score: clampInt(pct * 5), pct: round1(pct), bylined, total };
}

// ---- judged facets (press|substantive classification + b/c/e/f) ----

function buildPrompt(posts, ctx, profiles) {
  const blob = posts.map((p, i) =>
    `[${i + 1}] ${p.title ?? "(untitled)"}\n` +
    `url: ${p.url}\n` +
    `date: ${p.date ?? "unknown"} | byline: ${p.byline?.present ? (p.byline.author || "yes") : "none"} | headings: ${p.headings_count ?? "?"} | marketing_density_per_1k: ${p.marketing_density?.per_1k ?? "?"} | words: ${p.word_count ?? "?"}\n` +
    `excerpt: ${(p.excerpt || "").slice(0, 600)}`
  ).join("\n\n");

  return `You are scoring the CONTENT ENGINE of ${ctx.company} (${ctx.domain}) for an AEO/GEO audit. ICP / category terms: ${(ctx.category_terms ?? []).slice(0, 8).join(", ")}. Audit profile: ${profiles.join(" + ")}.

You are given the last ${posts.length} blog posts below (title, date, mechanical signals, and an excerpt).

${blob}

Do TWO things.

1) CLASSIFY each post by its bracket NUMBER as "press" (company news: funding, partnerships, certifications, hires, product launches, origin story, event recaps) or "substantive" (original argument, analysis, how-to, or perspective written for the category buyer). In the output, list the NUMBERS of the substantive posts.

2) SCORE these four facets 0-5. Be strict: thin or absent evidence scores low; do not reward intent.
- original_perspective: do the substantive posts advance an original point of view, argument, or proprietary insight, versus rehashing generic advice anyone could write?
- icp_fit: do the post topics map to the ICP and category terms above (the buyer's actual problems), versus company-centric or off-topic news?
- structure: are titles clearly communicative (a concrete claim or question, not vague), and do posts open with a clean summary/answer up top backed by real heading structure? Use the heading counts and excerpts.
- show_dont_tell: do posts substantiate claims with specifics, data, and named sources rather than marketing assertions? Treat a high marketing_density with few specifics as low.

Rules: score ONLY on the evidence given; do not assume anything not present. Provide 1-3 evidence quotes COPIED VERBATIM from the excerpts. No em dashes anywhere.

Return ONLY JSON: {"substantive": [<bracket numbers of the substantive posts>], "original_perspective": <0-5 int>, "icp_fit": <0-5 int>, "structure": <0-5 int>, "show_dont_tell": <0-5 int>, "reasoning": "<2-4 sentences; sentence 1 is a standalone verdict under 110 chars ending with a period>", "evidence": ["<verbatim substring of an excerpt>", ...]}`;
}

async function judgeContent({ posts, ctx, profiles, complete, model }) {
  const prompt = buildPrompt(posts, ctx, profiles);
  const hay = norm(posts.map((p) => p.excerpt || "").join(" "));
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { text } = await complete(prompt, { model, max_tokens: 2500 });
      const out = parseJSON(text);
      const facet = (k) => { const n = Number(out[k]); if (!Number.isInteger(n) || n < 0 || n > 5) throw new Error(`bad ${k}=${out[k]}`); return n; };
      const scores = {
        original_perspective: facet("original_perspective"),
        icp_fit: facet("icp_fit"),
        structure: facet("structure"),
        show_dont_tell: facet("show_dont_tell"),
      };
      const subNums = new Set((Array.isArray(out.substantive) ? out.substantive : []).map(Number));
      const classes = {};
      posts.forEach((p, i) => { classes[p.url] = subNums.has(i + 1) ? "substantive" : "press"; });
      const evidence = [].concat(out.evidence ?? []).filter((q) => typeof q === "string" && q.length > 5);
      const valid = evidence.length > 0 && evidence.every((q) => hay.includes(norm(q).slice(0, 180)));
      if (!valid && attempt === 1) continue; // retry once on evidence failure
      return { classes, scores, reasoning: String(out.reasoning ?? "").replace(/—/g, ", "), evidence, evidence_validated: valid };
    } catch (e) {
      if (attempt === 2) { console.error(`content_engine judge error: ${e.message}`); return null; }
    }
  }
  return null;
}

// ---- the element score ----

export async function scoreContentEngine({ facts, ctx, profiles, complete, model, now }) {
  now = now ?? Date.now();
  const posts = facts?.posts ?? [];
  if (!posts.length) return { score: null, rationale: "no blog posts sampled", evidence: [], evidence_validated: false, needs_review: true, facets: {}, facet_detail: {} };

  const judged = await judgeContent({ posts, ctx, profiles, complete, model });
  if (!judged) return { score: null, rationale: "content_engine judge failed", evidence: [], evidence_validated: false, needs_review: true, facets: {}, facet_detail: {} };

  const subPosts = posts.filter((p) => judged.classes[p.url] === "substantive");
  const forBylines = subPosts.length ? subPosts : posts;
  // When the crawler flags dates as unreliable (a site-wide stamp dominating the
  // sample), do NOT read cadence from them — pass no dates so frequency rests on
  // archive depth (maturity) alone rather than a fabricated recent cadence.
  const datesReliable = facts.dates_reliable !== false;
  const freq = frequencyFacet(datesReliable ? subPosts.map((p) => p.date) : [], now, facts.archive_size);
  const byl = bylinesFacet(forBylines);

  const facets = {
    frequency: freq.score,
    original_perspective: judged.scores.original_perspective,
    icp_fit: judged.scores.icp_fit,
    bylines: byl.score,
    structure: judged.scores.structure,
    show_dont_tell: judged.scores.show_dont_tell,
  };

  const W = CONTENT_ENGINE_WEIGHTS;
  let sw = 0, sws = 0;
  for (const k of Object.keys(W)) { sw += W[k]; sws += W[k] * (facets[k] ?? 0); }
  let raw = sws / sw;
  const gated = freq.nascent && raw > 2;
  if (gated) raw = 2;
  const score = clampInt(raw);

  const facetStr = `frequency ${facets.frequency}, original_perspective ${facets.original_perspective}, icp_fit ${facets.icp_fit}, bylines ${facets.bylines}, structure ${facets.structure}, show_dont_tell ${facets.show_dont_tell}`;
  const summary = freq.nascent
    ? `Nascent content engine: only ~${freq.archive} live items discovered, capped at 2.`
    : `Content engine ${score}/5 across ~${freq.archive} live items: weighted on cadence, perspective, ICP fit, bylines, structure, sourcing.`;
  const rationale = `${summary} Facets: ${facetStr}. ${judged.reasoning}`.replace(/—/g, ", ");

  return {
    score,
    rationale,
    evidence: judged.evidence,
    evidence_validated: judged.evidence_validated,
    needs_review: !judged.evidence_validated || !datesReliable,
    facets,
    facet_detail: {
      weighted_mean: round1(sws / sw),
      gated,
      frequency: freq,
      bylines: byl,
      substantive_posts: subPosts.length,
      sampled_posts: posts.length,
      weights: W,
    },
  };
}
