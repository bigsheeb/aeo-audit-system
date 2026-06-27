# AEO/GEO Audit — methodology (agent grounding)

Operational grounding for every agent in the AEO/GEO audit stack (context gatherer, prompt definer, performance grader, insights stager, report writer). Read this before doing audit work.

**Source of truth.** This file is the fast, local distillation every agent reads at runtime. In the production system the canonical framework is also mirrored to a Notion workspace page; if you keep a copy there, keep the two in sync.

## The one rule: two jobs, never averaged

AEO/GEO is **two separate jobs**. Score them separately; never combine into one number. The report leads with *which job is broken* — that single line is the wedge that turns an audit into a sales conversation.

1. **Discoverability** — "is the brand in the consideration set?" When a buyer asks a model a *category* question (`best <category> vendor for <use case>`), does the brand get named? Moved mostly OFF-site: the reputation graph (Reddit, G2, Wikipedia, press, listicles, podcasts) + content that is itself a citeable source. On-site fixes don't move it.
2. **Assessment / vetting** — "when asked about the brand *by name*, does the model answer cleanly?" Accurate, complete, non-contradictory. Fully operator-controlled: schema markup, claim-style sentences, fetchable HTML, pricing/team clarity, third-party trust signals. Only matters once the brand is named.

Same diagnostic skeleton, opposite prescriptions. A startup with a great site but no mentions has a *discoverability* problem (PR/reputation) — on-site fixes are wasted. A known brand with a JS-heavy site has a *vetting* problem (schema/content hygiene) — off-site work is redundant.

## The three axes (both tracks score on these)

- **Mention Rate** — was the brand named in the answer?
  - Discoverability: the primary KPI. Moved by the reputation graph.
  - Assessment: the floor — did the model return a substantive, correct-entity answer (vs. "I don't know," refusing, or conflating with another company)?
- **Citation Rate** — did the model cite the brand's *own domain* as a source?
  - Discoverability: the ceiling KPI. Rare — models cite the source layer, not vendor sites, unless the site *is* a source (original research, definitive guides, named frameworks, proprietary data).
  - Assessment: the site should be the primary source about the brand; if it isn't, the model is leaning on third parties to describe the brand.
- **Performance Score** — the wedge. How the brand is *portrayed*: accurate, favorable, placed in the right competitive set, described with the right vocabulary. Catches "named but mischaracterized." Everyone ships Mention + Citation Rate; nobody grades the *quality* of what the model says. This is the differentiator.
  - **Mechanics (v2): the judge judges, code scores.** Each prompt carries 2–4 operator-approved criteria (Gate 1, one Notion row each: id / text / weight / kill). The grader emits one pass/partial/fail verdict per criterion with a verbatim quote and a `certain|unsure` confidence — never a number. `grade-compute.mjs` validates every quote against the response, applies the floor gate (brand named + right entity + no kill-criterion failure, else 0), and computes the score: 5 × weighted pass fraction. Unsure or quote-invalid verdicts land in `review-queue.json` for Gate 2 adjudication.
  - **Two numbers, never one:** `blended_avg` (floor failures included — frequency and quality mixed, comparable across audits) and `portrayal_when_named` (only rows where the brand actually appeared — the pure quality axis, orthogonal to Mention Rate). Both live in `metrics.json`; agents copy them, never compute them.

### Diagnostic logic (three axes → three prescriptions)
- **Not named** → not in the consideration set → reputation gap.
- **Named but never linked** → known but not a source → content gap.
- **Named but scored low** → miscategorized in the model's mental map → positioning gap.

## Surfaces under test (v1)

Claude Sonnet, Perplexity Sonar, ChatGPT — all via OpenRouter, **web search ON** (grounded; an ungrounded answer measures stale training memory and returns zero citations), **k runs per prompt per surface** (per-prompt `runs`, operator-set at Gate 1; defaults 3 discoverability / 2 assessment — a single run is a coin flip, not a rate). Per-prompt results are reported as counts ("named in 2 of 5"), pooled track rates as percentages. See `lib/surfaces.mjs`. Gemini dropped for v1 (it was the Google / AI-Overviews proxy — clean add-back later).

## Modes

- **Prospecting mode** (v1) — the operator has NOT engaged the company. Context is whatever scrapers assemble (site, LinkedIn, Crunchbase, press). Powers outbound: "we ran a free audit on you."
- **Gated-audit mode** (later) — the company submitted a source-of-truth doc at intake. Context is operator-supplied. Powers the inbound "free audit" flow.

## Brand identity & disambiguation

Keep two things separate:

- **The context gatherer pins the true entity** (domain + one-line descriptor) so *we* know exactly who we're auditing and the grader can judge against the right company. If it can't be pinned confidently, halt and ask the operator.
- **Prompts stay natural — never seed the domain.** Real buyers don't type URLs. For collision-prone names ("Atlas," "Bridge," "Circle"), use the natural human disambiguator — *"tell me about the company Atlas"* — not a URL.
- **A wrong-entity answer is a signal, not a failure mode to engineer away.** If a model answers about a different company (or the common noun), that mismatch *is* the finding — the brand isn't strongly bound to its name. The grader flags it (`wrong_entity`) and assessment Mention Rate counts it as a miss.

## The four levers (framework v2.3)

The two jobs are the **outcomes**, measured by the surface tests. Everything the brand can fix sorts into four mechanism-ordered levers — before AI can recommend you, it has to **read you, know you, quote you, and hear others vouch for you**:

| Lever | Question | Owner | Primary job |
|---|---|---|---|
| **Access** | Can a machine read you? | Eng | Gate for both |
| **Identity** | Does AI know who you are? | Brand/site | Assessment |
| **Content** | Are you a source worth quoting? | Content | Both |
| **Reputation** | Do trusted third parties vouch for you? | PR/community | Discoverability |

~27 scored elements live under the levers (plus profile-conditional extras), each with a written 0-5 anchor ladder in `lib/rubric.mjs`. An `audit_profile` archetype set at prep (`plg_saas | enterprise_b2b | dev_tool | crypto_infra | consumer | services`) gates which elements apply and which validation sources count — inapplicable elements score N/A and are excluded from rollups, never zeroed.

**Freeze-then-score.** Discovery (scripts + two evidence-gatherer agents) writes facts ledgers — every fact with a URL and check date, never a score. Scoring (`score-levers.mjs`) is a separate pass over the frozen ledgers: mechanical elements computed in code, judged elements decided by a pinned judge at temp 0 against the anchors, with verbatim evidence quotes validated by substring match. Re-running scoring over the same ledgers reproduces the same scores.

**Importance and priority (theory vs practice).** Every element carries two orthogonal numbers: the **audit score** (how strong the company is) and an **importance score** = evidence-tier prior (the external research base: T1/T2/T3) blended with the observed citation signal from this company's own measured answers, practice-led at 25/75 after real-audit calibration. **Priority = importance x (5 - score)** ranks the fix list; indeterminate scores generate no priority (they land in `verify_first`). Client framing is the importance-performance 2x2: Fix now / Defend / Later / Don't overinvest.

**Policies.** Earned only (never seed Reddit, stuff reviews, or buy roundup placement). Honest uncertainty (per-prompt results as k/n counts; run counts and review-queue size disclosed). Never present share-of-voice as a stable ranking. Reddit is measured but never surfaced in report tables or prescribed as a fix.
