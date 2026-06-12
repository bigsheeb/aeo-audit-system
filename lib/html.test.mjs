// Regression tests for the shared HTML extraction helpers.
//   node --test lib/html.test.mjs
// No network, no deps — fixtures capture the real failure modes.

import { test } from "node:test";
import assert from "node:assert/strict";
import { internalLinks, tagAttr, sitemapLocs } from "./html.mjs";

const ORIGIN = "https://qdrant.tech";
const DOMAIN = "qdrant.tech";

// The qdrant.tech regression: minified HTML5 with UNQUOTED, absolute same-origin
// hrefs. The old quoted-only regex matched zero links here, collapsing the page
// sample to the homepage and scoring a false content_freshness=0.
test("internalLinks parses unquoted absolute same-origin hrefs (qdrant.tech)", () => {
  const html = `
    <a data-metric-loc=banner href=https://qdrant.tech/vector-space-day-sf-26>Event</a>
    <a href=https://qdrant.tech/>Home</a>
    <a class="link link_sm" href=https://qdrant.tech/about-us>About</a>
    <a href=https://qdrant.tech/pricing>Pricing</a>
    <a href=https://qdrant.tech/blog>Blog</a>
    <a href=https://qdrant.tech/articles>Articles</a>
  `;
  const links = internalLinks(html, ORIGIN, DOMAIN);
  for (const p of ["/about-us", "/pricing", "/blog", "/articles"]) {
    assert.ok(links.has(p), `expected nav path ${p}`);
  }
  assert.ok(links.has("/"), "expected homepage path");
});

test("internalLinks handles quoted, root-relative, and protocol-relative hrefs", () => {
  const html = `
    <a href="/about">About</a>
    <a href='/pricing/'>Pricing</a>
    <a href="https://qdrant.tech/blog?ref=nav#top">Blog</a>
    <a href="//qdrant.tech/docs">Docs</a>
  `;
  const links = internalLinks(html, ORIGIN, DOMAIN);
  assert.deepEqual(
    [...links.keys()].sort(),
    ["/about", "/blog", "/docs", "/pricing"],
  );
});

test("internalLinks drops cross-origin, mailto/tel/js, and fragment-only links", () => {
  const html = `
    <a href="https://github.com/qdrant/qdrant">GitHub</a>
    <a href="mailto:hi@qdrant.tech">Email</a>
    <a href="tel:+15551234">Call</a>
    <a href="javascript:void(0)">JS</a>
    <a href="#section">Anchor</a>
  `;
  const links = internalLinks(html, ORIGIN, DOMAIN);
  assert.equal(links.size, 0);
});

test("internalLinks treats www and apex as the same origin", () => {
  const html = `<a href=https://www.qdrant.tech/about-us>About</a>`;
  assert.ok(internalLinks(html, ORIGIN, DOMAIN).has("/about-us"));
});

test("tagAttr reads quoted and unquoted values, ignores data-* shadows", () => {
  assert.equal(tagAttr(`<a href="/x">`, "href"), "/x");
  assert.equal(tagAttr(`<a href='/y'>`, "href"), "/y");
  assert.equal(tagAttr(`<a href=/z>`, "href"), "/z");
  assert.equal(tagAttr(`<a data-href="/decoy" href=/real>`, "href"), "/real");
  assert.equal(tagAttr(`<a class="x">`, "href"), null);
});

test("sitemapLocs extracts <loc> URLs from a urlset", () => {
  const xml = `<urlset><url><loc>https://qdrant.tech/about-us/</loc></url><url><loc> https://qdrant.tech/pricing/ </loc></url></urlset>`;
  assert.deepEqual(sitemapLocs(xml), [
    "https://qdrant.tech/about-us/",
    "https://qdrant.tech/pricing/",
  ]);
});
