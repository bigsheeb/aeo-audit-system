---
description: Phase 3 of the AEO/GEO audit. Renders the approved findings into a self-contained in-page HTML report, then stops. Take <slug> as $ARGUMENTS. Requires Gate 2 approved.
---

# /audit-report

Phase 3. Turns approved findings into the client-facing **in-page HTML report**, then stops. Deterministic and key-free — no Canva, no LLM calls.

The report is a single flowing page (cover → method → what we measured → performance score → scoreboard → share of voice → audit scores → strengths → gaps → fixes), rendered from the run's data: `build-report-data.mjs` resolves the company JSONs into `report-data.json` (the flat data contract; emits only the tokens the renderer uses), and `build-report.mjs` renders that into `companies/<slug>/report.html`.

## Step 0 — Ground + preconditions

Read `.claude/context/aeo-audit-framework.md`. Then check, and STOP if any fails:
- Gate 2 is approved (the operator has signed off on the findings).
- `companies/<slug>/findings.json` and `companies/<slug>/deck-overrides.json` both exist (from `/audit-run`). If `deck-overrides.json` is missing, the audit predates the editorial step — re-run the insights-stager.

## Step 1 — Build the report data

`node build-report-data.mjs <slug>` → writes `companies/<slug>/report-data.json`, the flat token dataset (rates, scores, share-of-voice, cited domains, best/worst tables, fixes, insights) resolved from `metrics.json` / `levers.json` / `classified.jsonl` / `deck-overrides.json`. It emits only the tokens `build-report.mjs` renders, and aborts on any missing REQUIRED value.

Gate the editorial copy: `node prose-lint.mjs companies/<slug>/deck-overrides.json` — an em dash fails it (exit 1). Fix the offending line in `deck-overrides.json` and rebuild.

## Step 2 — Render the report

`node build-report.mjs <slug>` → `companies/<slug>/report.html` — the standalone, scoped, flowing report. Every number, table, and insight comes from `report-data.json`; the static copy (method steps, design principles, metric explainers, lever questions) is constant in the renderer. Aborts if a headline value is missing.

## Step 3 — Review

Open `companies/<slug>/report.html` in a browser and sanity-check: the verdict reads right, the scoreboard numbers and the audited brand's share-of-voice rows are correct, the best/worst tables and the three fixes are on-voice, and the page reads cleanly as one vertical scroll on a narrow viewport.

`report.html` is the deliverable. STOP.

## Notes

- To change wording, edit `deck-overrides.json` (insights) and re-run Step 1–2. To change layout, styling, or static copy, edit `build-report.mjs` (the change applies to every future report) and re-run Step 2.
- `build-report.mjs` reproduces the locked report structure; the only per-company variation is the data in `report-data.json` and the brand-row highlight (any share-of-voice row whose label contains the company name renders in the accent color).
- Everything is deterministic and free — re-render as many times as needed.
