---
description: Phase 2 of the AEO/GEO audit. Reads approved prompts + criteria, runs the surfaces under test, gathers the evidence ledgers, classifies + grades (judge-then-score), scores the four levers with the importance layer, and stages findings — then parks everything at Gate 2. Take <slug> as $ARGUMENTS. Requires OPENROUTER_API_KEY.
---

# /audit-run

Phase 2. Runs the full audit pipeline for one company and parks findings at Gate 2. **Requires Gate 1 approved and `OPENROUTER_API_KEY` set.**

## Step 0 — Ground + preconditions

Read `.claude/context/aeo-audit-framework.md`. Confirm `OPENROUTER_API_KEY` is set; if not, STOP and tell the operator. Take `<slug>` from `$ARGUMENTS`.

## Step 1 — Sync approved prompts

Pull the operator-approved prompts + per-criterion rubric (id / text / weight / kill, per-prompt `runs`, and the comparison tags `is_comparison`/`named_rival` that drive the head-to-head win/tie/loss verdict) into `companies/<slug>/prompts.json`. In the production system these live in Notion tables the operator edits at Gate 1; locally, editing prompts.json directly is equivalent. If Gate 1 isn't approved, STOP.

## Step 2 — Run the surfaces under test

`node run-prompts.mjs <slug>` → `raw_responses.jsonl`, one row per prompt x surface x run (per-prompt `runs`, defaults 3 discoverability / 2 assessment; failed calls retry once then land as `status:"error"` rows so denominators stay honest). If a surface returns zero citations across the board, flag it (grounding may be off) before continuing.

## Step 3 — Evidence ledgers (parallel, freeze-then-score)

Deterministic checks first:
- `node access-checks.mjs <slug>` → `access.json` (robots rules per AI-bot class, live UA probes, Bing/Brave index presence).
- `node site-checks.mjs <slug>` → `site-facts.json` (frozen page sample + scripted onsite facts: fetchability, crawl coverage, schema, freshness, FAQ/pricing presence, structure excerpts).

Then spawn in parallel: `audit-offsite-evidence` and `audit-onsite-evidence` for `<slug>`. Each writes a facts ledger (`offsite-facts.json`, `onsite-facts.json`) — facts with URLs and dates, never scores.

## Step 4 — Classify + grade (judge-then-score)

1. `node classify.mjs <slug>` → `classified.jsonl` + `consideration.json` (mention/citation tagging, the citation-role taxonomy, and the answer-derived, category-gated consideration set that feeds share-of-voice).
2. Spawn `audit-performance-grader` → `verdicts.jsonl` (one pass/partial/fail verdict per approved criterion, verbatim quote, confidence — never a number).
3. `node grade-compute.mjs <slug> --judge "<model>"` → `graded.jsonl` + `review-queue.json` (validates every quote against the response, applies the floor gate, computes each Performance Score in code; unsure/invalid verdicts queue for Gate 2).
4. `node compute-metrics.mjs <slug>` → `metrics.json` (mention/citation per track + surface, per-prompt k/n counts, blended_avg + portrayal_when_named, criterion failure rates, share-of-voice).

## Step 5 — Score the levers + stage

1. `node score-levers.mjs <slug>` → `levers.json`: the four levers (Access / Identity / Content / Reputation) scored across ~27 elements (mechanical checks in code; judged elements by a pinned judge at temp 0 against anchored rubrics, evidence quotes validated), plus the importance layer (evidence-tier prior x observed citation signal) and the priority ranking (importance x gap).
2. Spawn `audit-insights-stager` → `findings.json` + `deck-overrides.json` (verdict, two scorecards, priority-ranked fixes with `fix_target_1..3`, and the deck-ready editorial lines). Lint: `node prose-lint.mjs companies/<slug>/deck-overrides.json` — an em dash fails it (exit 1); have the stager rewrite the offending line.

## Step 6 — Gate 2

Present the verdict, the two scorecards, the lever scores, the priority ranking, the review queue count, and anything in `verify_first` (indeterminate checks that must not be prescribed). In the production system this is parked in Notion for approval; locally, the operator reviews `findings.json` + `review-queue.json`. To adjudicate a grading call: edit `verdicts.jsonl`, re-run `grade-compute.mjs` + `compute-metrics.mjs` (deterministic, free).

STOP. This is Gate 2. Approve, then run `/audit-report <slug>`.

Halt-with-a-question on any exception (surface failure, empty ledger, entity mismatch) rather than guessing.
