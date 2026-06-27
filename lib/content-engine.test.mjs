// Regression tests for the content_engine durability fixes (framework v2.6+):
// maturity is judged from ARCHIVE DEPTH, not the sampled-window span, so a
// prolific site whose recent sample spans only a few months is not mis-flagged
// "nascent"; and a genuinely thin archive still gates.
import test from "node:test";
import assert from "node:assert/strict";
import { frequencyFacet } from "./content-engine.mjs";

const NOW = new Date("2026-06-26").getTime();
const MONTH = 2.592e9;
const monthsAgo = (n) => new Date(NOW - n * MONTH).toISOString().slice(0, 10);

test("deep archive + short fresh window is NOT nascent (the prolific-site bug)", () => {
  // 6 substantive posts all within the last ~3 months, but the site has a deep
  // archive (hundreds of items). Old code: months_active < 6 -> nascent -> cap 2.
  const dates = [0.2, 0.6, 1, 1.5, 2, 2.8].map(monthsAgo);
  const f = frequencyFacet(dates, NOW, 318);
  assert.equal(f.nascent, false, "a 318-item archive must not read as nascent");
  assert.ok(f.score >= 4, `prolific recent cadence should score high, got ${f.score}`);
});

test("thin archive still gates as nascent", () => {
  const dates = [1, 2].map(monthsAgo);
  const f = frequencyFacet(dates, NOW, 3); // only 3 live items discovered
  assert.equal(f.nascent, true);
  assert.ok(f.score <= 2);
});

test("no archive signal falls back to sample count for the nascent decision", () => {
  // archiveSize undefined -> use sample length; 2 posts -> nascent.
  assert.equal(frequencyFacet([monthsAgo(1), monthsAgo(2)], NOW).nascent, true);
  // ...but a full sample (>= NASCENT_COUNT) is not nascent even without archive size.
  const many = [0.2, 0.6, 1, 1.5, 2, 2.8].map(monthsAgo);
  assert.equal(frequencyFacet(many, NOW).nascent, false);
});

test("deep archive but no trustworthy dates -> not nascent, neutral cadence", () => {
  // When dates are unreliable the caller passes [] but keeps archiveSize: the
  // element must not be gated to 2 (archive is deep) nor rewarded a fake cadence.
  const f = frequencyFacet([], NOW, 318);
  assert.equal(f.nascent, false);
  assert.equal(f.score, 2, "no dated posts -> neutral 2 on a deep archive, not 0/nascent");
});
