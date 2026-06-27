# CLAUDE.md — AEO/GEO Audit System

Guidance for working in this repo with Claude Code. Full methodology lives in
`.claude/context/aeo-audit-framework.md`; read it before doing audit work.

## What it does

Audits how AI search (ChatGPT, Perplexity, Claude) discovers, names, and
describes a company, then ships a client deliverable. Two jobs, scored
separately and **never averaged**: **Discoverability** (named in category
answers?) and **Assessment** (described accurately when asked by name?). The
report leads with which one is broken, then scores the four levers the company
can pull (Access / Identity / Content / Reputation) and ranks fixes by
importance x gap.

## Run it — 3 commands, 2 gates

- `/audit-prep <Company> <domain>` → research + pin entity + audit_profile + draft prompts with per-criterion rubric → **Gate 1** (approve prompts + criteria)
- `/audit-run <slug>` → surfaces (k runs/prompt) + evidence ledgers + classify + judge-then-score grading + lever scoring + importance → **Gate 2** (review findings + adjudicate the review queue)
- `/audit-report <slug>` → render the in-page HTML report (`build-report-data` → `build-report` → `report.html`)

Each command stops at its gate; nothing auto-advances.

## Layout

- Deterministic harness (Node, native `fetch`, no deps):
  `run-prompts.mjs` (k runs per prompt x surface, retries, error rows) ·
  `classify.mjs` (mention/citation tagging, citation-role taxonomy, answer-derived
  consideration set) · `access-checks.mjs` (AI-bot robots rules, live UA probes,
  Bing/Brave index presence) · `site-checks.mjs` (frozen page sample + scripted
  onsite facts) · `grade-compute.mjs` (validates grader quotes, floor-gates,
  computes Performance Scores in code) · `compute-metrics.mjs` ·
  `score-elements.mjs` (scores ~28 anchored lever elements) ·
  `score-importance.mjs` (research prior x observed signal, priority ranking;
  `score-levers.mjs` is a back-compat shim that runs both) ·
  `build-findings.mjs` (Gate 2 `findings.md`) · `build-audit-log.mjs` (per-element
  rows for the optional Notion Audit Log) · `build-report-data.mjs` (report data contract
  → `report-data.json`) · `build-report.mjs` (renders the in-page HTML report) ·
  `prose-lint.mjs` (AI-tell linter, hard-fails em dashes).
- `lib/` — `surfaces.mjs`, `openrouter.mjs` (surface adapter + pinned judge
  calls), `rubric.mjs` (the framework encoded: elements, anchors, profiles,
  importance weights), `content-engine.mjs` (decomposed Content-lever scorer),
  `importance.mjs` (importance scoring: prior x observed signal), `dataforseo.mjs`
  (optional SERP/mentions data, degrades to agent search).
- `companies/<slug>/` — per-company data. The repo ships only the synthetic
  `northwind/` example; real client runs are gitignored.
- `.claude/agents/audit-*` — the LLM judgment agents (context gatherer, prompt
  definer, on/off-site evidence, performance grader, fix brief + fix strategist,
  insights stager) · `.claude/commands/audit-*` — the phase commands
  (prep / run / report) · `.claude/context/` — framework + deck style.

## Prereqs

- `OPENROUTER_API_KEY` in `.env` (see `.env.example`) — surface queries +
  pinned-judge calls run through OpenRouter.
- Optional: `BRAVE_SEARCH_API_KEY` (free tier) for a reliable Brave
  index-presence check; `DATAFORSEO_LOGIN`/`DATAFORSEO_PASSWORD` for
  API-backed mention/SERP facts (everything degrades gracefully without them).
- A Notion workspace is optional: the production system parks the two gates
  there, but the audit runs end to end on local files without it.

## Notes

- Never average the two tracks. The wedge is the per-answer Performance Score,
  graded judge-then-score: the grader emits per-criterion verdicts + verbatim
  quotes (never a number); `grade-compute.mjs` validates quotes, applies the
  floor gate (named + right entity + no kill-criterion fail), and computes the
  score in code. Two numbers per track: `blended_avg` and `portrayal_when_named`.
- Freeze-then-score: evidence gatherers write facts ledgers (URL + date, never
  scores); `score-levers.mjs` scores over the frozen ledgers, mechanically where
  possible, judged at temp 0 against written anchors where not.
- Importance x gap ranks every fix; indeterminate checks land in `verify_first`
  and are never prescribed. Reddit is measured but never surfaced on deck
  tables or prescribed as a fix.
- Brand disambiguation: prep pins the entity on the domain and halts if it
  can't; collision-prone names use "the company X" phrasing — a wrong-entity
  answer is a finding, not a bug.
- `companies/northwind/` is a fully synthetic example. Every figure is invented.
