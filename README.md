# AEO/GEO Audit System

An agentic system that audits how AI search — ChatGPT, Perplexity, Claude — **discovers, names, and describes a company**, then ships a client-ready report.

Built by [Lobo Growth](https://lobogrowth.com). This repo is a public showcase of the architecture: the LLM judgment agents, the deterministic measurement harness, and a fully worked **synthetic example** (`companies/northwind/`) so you can see real inputs and outputs without any client data.

> **Why this exists.** "SEO for AI" (AEO = Answer Engine Optimization, GEO = Generative Engine Optimization) is mostly vibes and vanity metrics. This system makes it measurable: it runs real prompts against real answer engines, grades each answer against the brand's own positioning, and separates two failure modes most tools blur together.

![Agent system](agent-system-preview.png)

## The one idea: two jobs, never averaged

A company can fail AI search in two distinct ways, and the fix for each is different:

| Job | Question it answers | "Broken" looks like |
|-----|--------------------|--------------------|
| **Discoverability** | When a buyer asks a *category* question ("best stablecoin payouts API?"), is the company **named** at all? | Competitors fill the answer; the company isn't in the room. |
| **Assessment** | When a buyer asks about the company **by name**, is it described **accurately and favorably**? | Wrong entity, stale facts, miscategorized, hallucinated products. |

The scores are reported **separately and never averaged** — averaging hides which job is broken, and the report leads with that verdict. The wedge metric is a per-answer **Performance Score**: each model answer is graded against the brand's *own* positioning and the prompt's success criteria, not a generic rubric.

## Four levers, scored and ranked (v2.3)

The jobs are outcomes; everything a company can fix sorts into four mechanism-ordered levers — before AI can recommend you, it has to **read you, know you, quote you, and hear others vouch for you**:

| Lever | Question | Owner |
|-------|----------|-------|
| **Access** | Can a machine read you? (bot access, raw-HTML fetchability, the Bing/Brave indexes that gate ChatGPT/Claude search) | Eng |
| **Identity** | Does AI know who you are? (canonical company/offering pages, entity schema, name binding, Wikipedia) | Brand |
| **Content** | Are you a source worth quoting? (original research, category guides, comparison pages, freshness) | Content |
| **Reputation** | Do trusted third parties vouch for you? (earned press, the roundups AI actually cites, validation sources) | PR |

~27 elements with written 0-5 anchor ladders (`lib/rubric.mjs`), gated by a company-archetype profile (enterprise B2B is not judged like PLG SaaS; inapplicable elements are N/A, never zeroed). Three design rules make the numbers defensible:

- **Freeze-then-score.** Evidence gathering writes facts ledgers (every fact carries a URL and check date, never a score); scoring is a separate deterministic pass over the frozen ledgers — mechanical in code where possible, judged at temperature 0 against the anchors where not, with verbatim evidence quotes validated by substring match.
- **Judge-then-score.** The performance grader emits per-criterion pass/partial/fail verdicts with quotes — never a number. `grade-compute.mjs` validates every quote against the response text, applies the floor gate (brand named + right entity + no kill-criterion failure), and computes scores in code. Unsure or quote-invalid verdicts queue for human adjudication.
- **Theory vs practice.** Every element gets an **importance score**: an evidence-tier prior from the published research, blended with the observed citation signal in this company's own measured answers (which roundups did the models actually cite? whose product pages won the category answers?). The blend is practice-led (25/75) after calibration on real audits — a source class cited in 0 of 27 answers should not hold a top-3 priority on the research prior alone. **Priority = importance x gap** ranks the fix list — so the #1 fix is provably the thing AI already uses that the company is weakest at.

See [`.claude/context/aeo-audit-framework.md`](.claude/context/aeo-audit-framework.md) for the full methodology.

## How it runs — 3 phases, 2 human gates

Each phase is a slash command (`.claude/commands/`) that orchestrates agents and then **stops at a gate** for human review. Nothing auto-advances.

```
/audit-prep  <Company> <domain>   research + pin entity + draft test prompts   ── Gate 1: approve prompts
/audit-run   <slug>               query 3 surfaces + 3 audits + grade          ── Gate 2: approve findings
/audit-report <slug>              compile the client report
/audit-publish <slug>             (deployment-specific) push report live
```

## Architecture

**Deterministic harness** (Node, native `fetch`, zero dependencies) — the parts that must be reproducible:

| File | Role |
|------|------|
| `run-prompts.mjs` + `lib/surfaces.mjs`, `lib/openrouter.mjs` | Query Claude, Perplexity, and ChatGPT via OpenRouter (web search on, k runs per prompt, retries + honest error rows) → `raw_responses.jsonl` |
| `classify.mjs` | Tag each answer (brand mentioned? own domain cited?), type every citation (competitor / listicle / press / reference / explainer), and extract the **answer-derived consideration set** that feeds share-of-voice → `classified.jsonl`, `consideration.json` |
| `access-checks.mjs` | Robots rules per AI-bot class (training vs search vs user-fetch), live user-agent probes for edge blocks, Bing + Brave index presence → `access.json` |
| `site-checks.mjs` | Frozen page sample + scripted onsite facts (raw-HTML fetchability, crawl coverage, schema, freshness, FAQ/pricing presence) → `site-facts.json` |
| `grade-compute.mjs` | Validates every grader quote against the response, applies the floor gate, computes Performance Scores in code → `graded.jsonl`, `review-queue.json` |
| `compute-metrics.mjs` | Mention/citation rates, per-prompt k/n counts, blended + portrayal-when-named performance, criterion failure rates, share-of-voice → `metrics.json` |
| `score-levers.mjs` | Scores the four levers across ~27 anchored elements over the frozen facts ledgers; computes importance + the priority ranking → `levers.json` |
| `build-deck.mjs` | Flattens everything into the `[[token]]` dataset the client deck is filled from → `canva-fill.json` |
| `prose-lint.mjs` | High-precision AI-writing-tell linter; hard-fails on em dashes |
| `lib/rubric.mjs` | The framework encoded: element registry, anchor ladders, archetype profiles, importance weights |

**LLM judgment agents** (`.claude/agents/`) — the parts that need reasoning:

| Agent | Job |
|-------|-----|
| `audit-context-gatherer` | Research the company, pin the exact entity + archetype profile, write `context.md` |
| `audit-prompt-definer` | Draft the test prompts + the per-criterion grading rubric (weight/kill) — the Gate 1 artifact |
| `audit-offsite-evidence` | Facts ledger for the Reputation lever + off-site Identity (press, roundups, validation sources, directories, Wikipedia) — facts with URLs, never scores |
| `audit-onsite-evidence` | Facts ledger for the Content lever + on-site Identity (guides, comparisons, case studies, research assets, blog composition) |
| `audit-performance-grader` | **The wedge** — per-criterion verdicts with verbatim quotes; the score itself is computed in code |
| `audit-insights-stager` | Synthesizes everything into the verdict, two scorecards, and the priority-ranked fix list (Gate 2) |
| `audit-report-writer` | Writes the client-facing HTML report, led by the verdict |

The split is deliberate: anything that should be reproducible and cheap is a deterministic script; anything that needs judgment is an agent grounded by a shared methodology file.

## The worked example — `companies/northwind/`

A complete audit of a **fictional** company, **Northwind Pay** (a stablecoin payments API). Every number, finding, and quote is synthetic — see the banner in `companies/northwind/context.md`. Real companies appear only as market-context competitors.

Open [`companies/northwind/report.html`](companies/northwind/report.html) in a browser for the final deliverable. The verdict it lands on: **discoverability is broken, assessment is strong** — Northwind is described accurately when asked by name (4.3/5, named in 100% of answers) but barely surfaces in category questions (1.7/5, named in 3 of 9). The supporting artifacts show every step that produced it: `prompts.json` → `raw_responses.jsonl` → `classified.jsonl` + `consideration.json` → `graded.jsonl` → `metrics.json` → `access.json` + **`levers.json`** (the four-lever scorecard with anchors, importance, and the priority ranking) → `findings.json` + `deck-overrides.json`. A few artifacts predate the current shapes; `levers.json` and `consideration.json` show the v2.3 scoring layer.

## Running it yourself

The agents and commands are designed for [Claude Code](https://claude.com/claude-code). The harness scripts run with plain Node.

```bash
cp .env.example .env          # add your OpenRouter key
npm run test:surfaces         # re-queries the surfaces for the example slug
node classify.mjs northwind   # + consideration-set extraction with the key set
node compute-metrics.mjs northwind
node build-deck.mjs northwind # flattens everything into the deck-fill tokens
```

The `/audit-publish` phase is wired to one specific deployment (Canva + Netlify + a custom host) and is included as a documented stub — phases 1–3 produce all the analysis and a self-contained `report.html`.

## License

MIT — see [LICENSE](LICENSE). Built by Patrick Kemp / [Lobo Growth](https://lobogrowth.com).
