---
description: Phase 3 of the AEO/GEO audit. Fills the Canva master with a company's approved data to compile the per-prospect deck, then stops. Publishing the deck to the site is a separate /audit-publish step. Take <slug> as $ARGUMENTS. Requires Gate 2 (Status: Reporting) and the Canva MCP connected.
---

# /audit-report

Phase 3. Turns approved findings into the per-prospect Canva deck. Replaces the old HTML report-writer.

The fill is a clean find-and-replace: the master holds `[[token]]` placeholders, `build-deck.mjs` produces the per-company values, and each token is swapped for its value on a clone. Tokens are unique, so there is no position-guessing and no collision between repeated numbers.

## Step 0 — Ground + preconditions

Read `.claude/context/aeo-audit-framework.md`. Then check, and STOP if any fails:
- The company's **AEO Audits** row Status = `Reporting` (Gate 2 approved).
- `companies/<slug>/findings.json` and `companies/<slug>/deck-overrides.json` both exist (from `/audit-run`). If `deck-overrides.json` is missing, the audit predates the deck step — re-run the insights-stager.
- The Canva MCP is connected.

## Master setup (one-time, operator)

The Canva master ("AI Visibility Report", 14 pages, whose design id you resolve at runtime via `search-designs`) is the template every prospect clones. Each dynamic element's text must be its `[[token]]` placeholder — the exact field names emitted in `companies/<slug>/canva-fill.json` (lowercase; a `[[Company]]`-style case mismatch silently never fills). Token map by slide: `company` + `audit_date` (1), example prompts (3), scoreboard rates + `disc_gap`/`assess_gap` insights + `run_disclosure` footer (6), share-of-voice + cited-domain rows with their insights (7), `dim_*` counts (9), `score_access/identity/content/reputation` lever rollups (10), `best_lever/dim/rationale_1..4` (11), `worst_lever/dim/rationale_1..4` (12), `fix_label_1..3` + `fix_1..3` (13), static CTA closer (14). The fill may emit fields a given master doesn't carry — unmatched tokens are skipped harmlessly. Rules for the master:
- Keep all share-of-voice rows **neutral** (no baked accent color). The fill paints the audited brand's row, because its rank changes per company.
- Scoreboard insight lines stay `Insight: [[disc_gap]]` and `Insight: [[assess_gap]]` (static prefix + token).
- Every rate/score cell, including ones that may be blank for some companies, should carry its `[[token]]` so the cell styling is consistent.
- Best/worst table rows can legitimately fill as "N/A" when a company's scores skew one direction — by design, not a fill failure.

## Step 1 — Build the fill data

`node build-deck.mjs <slug>` → writes `companies/<slug>/canva-fill.json` (aborts if any REQUIRED value is missing — the four insight lines and the three fixes; warns on any field over its slide-frame character cap — tighten the offending line in `deck-overrides.json` if so). Then gate the copy:

`node prose-lint.mjs companies/<slug>/deck-overrides.json` — an em dash fails it (exit 1). Fix the line and rebuild.

## Step 2 — Clone the master

`search-designs` for "AI Visibility Report" → the master design id. `copy-design(master_id, page_numbers [1..14])` → the clone (14 pages; any parked reference pages beyond 14 stay out of every clone). **Never edit the master itself** — always work on the clone.

## Step 3 — Open the clone

`start-editing-transaction(clone_id)` → the element map (`element_id` + current text per page). Keep the returned `transaction_id` and `pages` array for the next two calls.

## Step 4 — Fill every token

Load `companies/<slug>/canva-fill.json`. In one bulk `perform-editing-operations`, for each field whose value is **non-empty**: find the element whose text contains `[[field]]` and apply `find_and_replace_text(element_id, find "[[field]]", replace value)`.
- `[[company]]` appears in several elements (cover title, cover subhead, scoreboard title) — replace it in each that contains it.
- Leave tokens with an empty `""` value unreplaced — those are padding rows and stay blank.
- This is create-only on the clone; the master is untouched.

## Step 5 — Highlight the audited brand's row

If exactly one `sov_label_N` equals `company`, the element that held `[[sov_label_N]]` is the brand's share-of-voice row. `format_text(color "#A3D9A5")` on that brand cell and its matching `[[sov_pct_N]]` cell. If the company is not in the share-of-voice list (zero category mentions), skip — no highlight.

## Step 6 — Review, then commit

`get-design-thumbnail` for the data-heavy pages (5 scoreboard, 6 share-of-voice) and show them. Sanity-check the numbers and the brand highlight. Then `commit-editing-transaction` — edits are draft and lost until committed.

## Step 7 — Finish (hand off to publish)

Compiling the deck is the end of `/audit-report`. Print the clone's edit URL, view URL, and `design_id`, and STOP. Leave the **AEO Audits** row at Status `Reporting`.

Publishing is the separate `/audit-publish` agent: it exports the deck to PNGs, builds the `audit.lobogrowth.com/<slug>` landing page, pushes to Netlify, and sets Report URL + Status `Published`. Do NOT export or touch the site here. Canva export URLs expire in ~24h, so the export belongs with the publish step that downloads them immediately.

## Notes

- To iterate copy, edit `deck-overrides.json` and re-run from Step 1 — do not re-clone to tweak wording.
- If the master still holds literal values instead of `[[token]]` placeholders, Step 4 finds nothing. Convert the master once per the placeholder map; the manual element-ID fill is not reliable to automate.
- Caps live in `build-deck.mjs` (`LIMITS`); they warn, they don't block.
