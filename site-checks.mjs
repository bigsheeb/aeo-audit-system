// Site checks — deterministic onsite facts for the v2.2 scoring framework.
// Captures the FROZEN PAGE SAMPLE (canonical Notion page, section 3) and emits
// scripted facts for: fetchability_no_js, crawl_coverage, entity_schema,
// content_engine (per-post date, byline, heading structure, marketing density,
// excerpt), branded_faq (presence half), pricing (presence half), answer_structure
// (structure facts), llms_txt (footnote). The onsite evidence agent reads this
// file first and layers the judgment-needing inventories on top.
//
// Sample = homepage + about/company + pricing (if any) + up to 4 nav-prominent
// pages + blog index + last 12 posts. Sampled URLs are recorded; re-runs reuse
// the recorded sample if present (freeze semantics).
//
//   node site-checks.mjs <slug> [domain-override]

import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stripTags, internalLinks, sitemapLocs, tagAttr } from "./lib/html.mjs";

const slug = process.argv[2];
if (!slug) throw new Error("usage: node site-checks.mjs <slug> [domain]");
const root = dirname(fileURLToPath(import.meta.url));
const dir = `${root}/companies/${slug}`;

const ctx = JSON.parse(await readFile(`${dir}/context.json`, "utf8"));
const domain = (process.argv[3] || ctx.domain || "").replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
if (!domain) throw new Error("no domain");
const origin = `https://${domain}`;

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const TIMEOUT = 20000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html,*/*" }, redirect: "follow", signal: AbortSignal.timeout(TIMEOUT) });
    const html = await r.text();
    return { status: r.status, ok: r.ok, html, final_url: r.url, bytes: html.length };
  } catch (e) {
    return { status: null, ok: false, html: "", final_url: url, bytes: 0, error: e.message };
  }
}

// ---- HTML extraction helpers (no deps) ----
// stripTags / internalLinks / sitemapLocs live in lib/html.mjs (shared + tested).

const headings = (html) => [...html.matchAll(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi)]
  .map((m) => `h${m[1]}: ${stripTags(m[2]).slice(0, 120)}`).slice(0, 20);

const ldTypes = (html) => {
  const types = new Set(); let sameAs = 0;
  for (const m of html.matchAll(/<script[^>]*application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const collect = (o) => {
        if (!o || typeof o !== "object") return;
        if (Array.isArray(o)) return o.forEach(collect);
        if (o["@type"]) [].concat(o["@type"]).forEach((t) => types.add(t));
        if (o.sameAs) sameAs += [].concat(o.sameAs).length;
        Object.values(o).forEach(collect);
      };
      collect(JSON.parse(m[1]));
    } catch {}
  }
  return { types: [...types], sameAs_count: sameAs };
};

const meta = (html, name) => html.match(new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']*)["']`, "i"))?.[1]
  ?? html.match(new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${name}["']`, "i"))?.[1] ?? null;

const pageDates = (html) => {
  const out = new Set();
  for (const m of html.matchAll(/datetime=["'](\d{4}-\d{2}-\d{2})/g)) out.add(m[1]);
  for (const m of html.matchAll(/"date(?:Published|Modified)"\s*:\s*"(\d{4}-\d{2}-\d{2})/g)) out.add(m[1]);
  for (const m of html.matchAll(/\b(20\d{2})-(\d{2})-(\d{2})\b/g)) out.add(m[0]);
  return [...out].filter((d) => d >= "2015-01-01" && d <= "2027-12-31").sort().slice(-5);
};

const faqSignals = (html) => ({
  faqpage_schema: /FAQPage/i.test(html),
  question_itemtype: /itemtype=["'][^"']*Question/i.test(html),
  faq_class: /class=["'][^"']*faq/i.test(html),
  details_blocks: (html.match(/<details[\s>]/gi) || []).length,
});

// ---- per-post extraction (content_engine facts) ----
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };
// Publish date as prose ("June 3, 2026") near the top — Webflow-style blogs rarely
// emit machine-readable datetime, so the visible header date is the reliable signal.
const proseDate = (text) => {
  const m = text.slice(0, 2000).match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(20\d{2})\b/i);
  if (!m) return null;
  const mo = MONTHS[m[1].toLowerCase()];
  return mo ? `${m[3]}-${String(mo).padStart(2, "0")}-${String(+m[2]).padStart(2, "0")}` : null;
};
// Machine-readable publish date — far more reliable than prose scanning, which a
// site-wide dated promo banner near the top of every page can poison. Prefer
// OpenGraph article:published_time, JSON-LD datePublished, itemprop, or a <time>
// element; fall back to prose only when none are present.
const isoDay = (s) => String(s || "").match(/(20\d{2})-(\d{2})-(\d{2})/)?.[0] ?? null;
const structuredDate = (html) =>
  isoDay(html.match(/<meta[^>]+(?:property|name|itemprop)=["'](?:article:published_time|datePublished|publishdate|publish_date|publish-date)["'][^>]+content=["']([^"']+)["']/i)?.[1]) ??
  isoDay(html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name|itemprop)=["'](?:article:published_time|datePublished)["']/i)?.[1]) ??
  isoDay(/"datePublished"\s*:\s*"([^"]+)"/i.exec(html)?.[1]) ??
  isoDay(html.match(/<time[^>]+datetime=["']([^"']+)["']/i)?.[1]);
const MKT = /\b(industry[- ]?leading|best[- ]in[- ]class|world[- ]?class|cutting[- ]?edge|state[- ]of[- ]the[- ]art|next[- ]?gen(?:eration)?|revolutionary|game[- ]?chang(?:ing|er)|seamless(?:ly)?|frictionless|turnkey|robust|leverages?|empower(?:s|ing)?|unlock(?:s|ing)?|mission[- ]?critical|end[- ]to[- ]end|innovat(?:ive|ion)|transformat(?:ive|ion)|bleeding[- ]?edge|paradigm|synerg\w*|holistic|unparalleled|premier|enterprise[- ]?grade|powerful|effortless|supercharge\w*)\b/gi;
const marketingDensity = (text) => {
  const words = text.split(/\s+/).filter(Boolean).length;
  const hits = (text.match(MKT) || []).length;
  return { hits, per_1k: words ? Math.round((hits / (words / 1000)) * 10) / 10 : 0, words };
};
// Byline presence: structured (author meta / Article.author / rel=author) or a
// conservative visible "written by" / "By First Last" that is not the company.
// A real byline = structured author markup (author meta / Article.author /
// rel=author) or an explicit "written by NAME". The bare "By First Last" pattern
// is deliberately NOT used: it false-positives on "led by / backed by NAME" in
// funding and partnership posts, and a citeable byline a model trusts is the
// structured kind anyway.
const bylineOf = (html, text, company) => {
  const metaAuthor = html.match(/<meta[^>]+name=["']author["'][^>]+content=["']([^"']+)["']/i)?.[1];
  const ldAuthor = /"author"\s*:\s*\{[^]*?"name"\s*:\s*"([^"]+)"/i.exec(html)?.[1] || /"author"\s*:\s*"([^"]{2,})"/i.exec(html)?.[1];
  const relAuthor = /rel=["']author["']/i.test(html);
  const written = text.slice(0, 1500).match(/\b(?:written|story|words)\s+by\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/i);
  const cand = (metaAuthor || ldAuthor || (written ? written[1] : null) || "").trim() || null;
  const tok = (company || "").replace(/[^a-z0-9]/gi, "");
  const isCompany = cand && tok && new RegExp(tok, "i").test(cand.replace(/[^a-z0-9]/gi, ""));
  const present = Boolean((metaAuthor || ldAuthor || relAuthor || written) && !isCompany);
  return { present, author: present ? cand : null };
};
// Drop the leading nav/chrome by slicing from where the post title appears.
// Drop the leading nav/chrome. The <title> echoes the post H1, so the title text
// appears twice: once at the very top (page title) and again as the body heading
// after the nav. Slice from the SECOND occurrence to skip the nav.
const cleanExcerpt = (text, title) => {
  const head = (title || "").split("|")[0].trim();
  if (head) {
    const first = text.indexOf(head);
    const second = first >= 0 ? text.indexOf(head, first + head.length) : -1;
    if (second > 0 && second < text.length - 200) return text.slice(second, second + 1200);
    if (first > 0 && first < text.length - 200) return text.slice(first, first + 1200);
  }
  return text.slice(0, 1200);
};

function analyzePage(url, res) {
  const html = res.html;
  const text = stripTags(html);
  const ld = ldTypes(html);
  return {
    url, status: res.status, bytes: res.bytes, final_url: res.final_url,
    text_chars: text.length,
    text_ratio: res.bytes ? Math.round((text.length / res.bytes) * 1000) / 1000 : 0,
    spa_shell: res.bytes > 0 && text.length < 600 && /<div[^>]+id=["'](root|app|__next)/i.test(html),
    title: html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim().slice(0, 150) ?? null,
    canonical: /<link[^>]+rel=["']canonical/i.test(html),
    og_type: meta(html, "og:type"),
    ld_types: ld.types, sameAs_count: ld.sameAs_count,
    headings: headings(html),
    intro_excerpt: text.slice(0, 600),
    brand_in_raw: new RegExp(`\\b${ctx.company}\\b`, "i").test(text),
    dates: pageDates(html),
    faq: faqSignals(html),
  };
}

// ---- discover the sample ----
console.log(`site-checks: ${domain}`);
const home = await get(origin + "/");
if (!home.ok) console.warn(`! homepage ${home.status ?? home.error}`);
const nav = internalLinks(home.html, origin, domain);
const homeNavKeys = new Set(nav.keys());

// sitemap (fetched up front so it can backfill nav discovery). AI crawlers
// execute no JS, so a JS-rendered menu — or markup the link parser can't reach —
// leaves the homepage with too few internal links to find about/pricing/blog.
// When that happens, mine the sitemap for the named pages instead of letting
// the sample collapse to the homepage alone.
const sm = await get(origin + "/sitemap.xml");
const smIndex = !sm.ok ? await get(origin + "/sitemap_index.xml") : null;
const sitemapReal = (r) => r?.ok && /<(urlset|sitemapindex)/i.test(r.html);
const smOk = sitemapReal(sm) ? sm : sitemapReal(smIndex) ? smIndex : null;

async function sitemapPaths(r) {
  let urls = sitemapLocs(r.html);
  if (/<sitemapindex/i.test(r.html)) {            // index → fetch a couple child sitemaps
    const children = urls.slice(0, 2);
    urls = [];
    for (const c of children) { const cr = await get(c); if (cr.ok) urls.push(...sitemapLocs(cr.html)); }
  }
  const paths = [];
  for (const u of urls) {
    try {
      const url = new URL(u);
      if (url.hostname.replace(/^www\./, "") !== domain) continue;
      paths.push(url.pathname.replace(/\/$/, "") || "/");
    } catch {}
  }
  return [...new Set(paths)];
}

const NAV_MIN = 5;
if (nav.size < NAV_MIN && smOk) {
  const paths = await sitemapPaths(smOk);
  for (const p of paths) if (!nav.has(p)) nav.set(p, "");
  if (nav.size > homeNavKeys.size) console.warn(`! homepage nav thin (${homeNavKeys.size} links); backfilled ${nav.size - homeNavKeys.size} paths from sitemap`);
}

const pick = (re) => [...nav.keys()].find((p) => re.test(p));
const aboutPath = pick(/^\/(about|company|who-we-are|about-us|team)$/i) ?? pick(/about|company/i);
const pricingPath = pick(/^\/pricing/i) ?? pick(/pricing/i);
const blogPath = pick(/^\/(blog|insights|resources|news|newsroom)$/i) ?? pick(/blog|insights|newsroom/i);
const skip = new Set(["/", aboutPath, pricingPath, blogPath, "/privacy", "/terms", "/careers", "/legal", "/cookies", "/contact"]);
// "nav-prominent" pages come from the homepage menu; only fall back to the
// backfilled (sitemap) pool when the homepage yielded no usable nav at all.
const navSource = homeNavKeys.size ? [...homeNavKeys] : [...nav.keys()];
const navPages = navSource.filter((p) => !skip.has(p) && !/privacy|terms|careers|legal|cookie|contact|login|signin|search/i.test(p)).slice(0, 4);

// Reuse a previously frozen sample when present.
let prior = null;
try { prior = JSON.parse(await readFile(`${dir}/site-facts.json`, "utf8")); } catch {}
let sampleUrls;
if (prior?.sample?.urls?.length) {
  sampleUrls = prior.sample.urls.filter((u) => !u.is_post).map((u) => u.url);
  console.log(`reusing frozen sample (${sampleUrls.length} pages) from ${prior.captured_at}`);
} else {
  sampleUrls = [...new Set(["/", aboutPath, pricingPath, ...navPages, blogPath].filter(Boolean).map((p) => origin + (p === "/" ? "/" : p)))];
}

const pages = [];
for (const url of sampleUrls) {
  process.stdout.write(`-> ${url} ... `);
  const res = await get(url);
  pages.push(analyzePage(url, res));
  console.log(`${res.status} (${res.bytes}b, text ${pages.at(-1).text_chars})`);
  await sleep(200);
}

if (pages.length <= 1) {
  console.warn(`!! sample collapsed to ${pages.length} page (no about/pricing/blog/nav pages discovered). crawl_coverage and content_engine facts will be unreliable. Check homepage nav parsing and sitemap.xml.`);
}

// content engine: discover MULTIPLE content surfaces, freshness-gate them, and
// pool the most-recent items into one dated stream. A single-blog-path crawl is
// brittle on real sites: content spreads across /articles, /resources, /blog, a
// thin /newsroom press feed, campaign hubs (e.g. /ai-plays), and often a STALE
// legacy blog.<domain> subdomain whose huge dead archive would win on raw volume.
// We rank by FRESH, dated items so an old archive can never set the cadence, and
// degrade to the single freshest surface for simple one-blog sites.
const CONTENT_FRESH_MONTHS = 18;             // an item is "live" if dated within this window
const CONTENT_MONTH_MS = 2.592e9;            // 30 days
const SAMPLE_PER_SURFACE = 6, MAX_SURFACES = 5;
const apexHost = origin.replace(/^https?:\/\//, "");
const bareHost = (h) => h.replace(/^www\./, "");
// post-like links from an index page: same registrable host (www/apex folded),
// deeper than the index path, excluding taxonomy/pagination/feed paths.
const postLinksFrom = (html, indexUrl) => {
  const idx = new URL(indexUrl);
  const idxSegs = idx.pathname.replace(/\/$/, "").split("/").filter(Boolean); // [] for a root index, ["articles"] for /articles
  const out = new Set();
  for (const m of html.matchAll(/<a\b([^>]*)>/gi)) {
    let href = tagAttr("<a" + m[1] + ">", "href");
    if (!href) continue;
    href = href.trim().replace(/[#?].*$/, "");
    if (!href || /^(mailto:|tel:|javascript:)/i.test(href)) continue;
    if (href.startsWith("//")) href = "https:" + href;
    try {
      const u = href.startsWith("http") ? new URL(href) : new URL(href, idx.origin + "/");
      if (bareHost(u.host) !== bareHost(idx.host)) continue;               // same site (fold www/apex); keeps blog.* distinct
      const segs = u.pathname.replace(/\/$/, "").split("/").filter(Boolean);
      if (segs.length <= idxSegs.length) continue;                         // must be deeper than the index
      // must live UNDER the index path (prefix match) — not just anywhere deeper on the
      // site, else a /articles index would scoop up /platform/* mega-nav links.
      if (idxSegs.some((seg, i) => (segs[i] || "").toLowerCase() !== seg.toLowerCase())) continue;
      const child = segs[idxSegs.length];
      if (/^(category|categories|tag|tags|author|authors|page|topics?|search|rss|feed|subscribe)$/i.test(child || "")) continue;
      out.add(u.origin + "/" + segs.join("/"));
    } catch {}
  }
  return [...out];
};

// candidate content indexes: a fixed seed of common content paths, plus any
// nav/sitemap path that looks content-y, plus common content subdomains (probed
// but never trusted over a fresh apex surface — the legacy-blog trap).
const CONTENT_SEED = ["/articles", "/blog", "/resources", "/insights", "/news", "/newsroom", "/learn", "/guides", "/library", "/stories", "/playbooks", "/plays", "/ai-plays", "/academy"];
const navContent = [...nav.keys()].filter((p) => /(^|\/)(blog|articles?|resources?|insights?|news|newsroom|learn|guides?|librar|stories|playbook|plays|academy)(\/|$)/i.test(p));
const contentCandidates = [...new Set([
  ...CONTENT_SEED.map((p) => origin + p),
  ...navContent.map((p) => origin + p),
  `https://blog.${domain}/`, `https://resources.${domain}/`,
])];

// probe each candidate index (cheap: one GET each); record reachable surfaces.
const surfacesFound = [];
for (const idx of contentCandidates) {
  const r = await get(idx);
  if (!r.ok) continue;
  const links = postLinksFrom(r.html, idx);
  if (!links.length) continue;
  const isSub = bareHost(new URL(idx).host) !== bareHost(apexHost);
  surfacesFound.push({ index: idx, host: new URL(idx).host, isSub, links });
  console.log(`-> content surface ${idx} ... ${r.status} (${links.length} item links${isSub ? ", subdomain" : ""})`);
}

// deep-sample LEAF posts to get dates/bylines. Prefer apex surfaces; only
// deep-sample a subdomain when no apex surface yielded links (don't pay for a
// dead blog.*). Many content hubs link to SECTION/category pages first (e.g.
// /articles/ai, /guides/build) which are themselves indexes, not posts — and
// they carry a uniform template date that would poison the cadence signal. We
// skip them: an index/section page links to many same-surface siblings, a leaf
// article links to few. This is a universal blog shape, not a per-site hack.
const INDEX_LINK_THRESHOLD = 12, MAX_SCAN_PER_SURFACE = 14;
const apexSurfaces = surfacesFound.filter((s) => !s.isSub);
const toSample = (apexSurfaces.length ? apexSurfaces : surfacesFound)
  .sort((a, b) => b.links.length - a.links.length).slice(0, MAX_SURFACES);
let pooled = [];
for (const s of toSample) {
  let kept = 0;
  for (const url of s.links.slice(0, MAX_SCAN_PER_SURFACE)) {
    if (kept >= SAMPLE_PER_SURFACE) break;
    const res = await get(url);
    if (!res.ok) { await sleep(120); continue; }
    if (postLinksFrom(res.html, s.index).length > INDEX_LINK_THRESHOLD) { await sleep(120); continue; } // a section/index page, not a post
    const a = analyzePage(url, res);
    const text = stripTags(res.html);
    pooled.push({
      url: a.url, status: a.status, title: a.title, surface: s.index,
      date: structuredDate(res.html) ?? proseDate(text) ?? a.dates.at(-1) ?? null,
      byline: bylineOf(res.html, text, ctx.company),
      headings_count: a.headings.length,
      marketing_density: marketingDensity(text),
      word_count: text.split(/\s+/).filter(Boolean).length,
      excerpt: cleanExcerpt(text, a.title),
    });
    kept++;
    await sleep(150);
  }
}

// freshness gate: a subdomain surface with ZERO in-window dated items is treated
// as stale/legacy and dropped from the pool entirely (so a dead archive's volume
// can never set cadence). Order the pool newest-first; undated items sort last.
const nowMs = Date.now();
const inWindow = (d) => { const t = new Date(d).getTime(); return !Number.isNaN(t) && t >= nowMs - CONTENT_FRESH_MONTHS * CONTENT_MONTH_MS; };
const staleHosts = new Set(
  toSample.filter((s) => s.isSub && !pooled.some((p) => p.surface === s.index && inWindow(p.date))).map((s) => s.host)
);
pooled = pooled.filter((p) => { try { return !staleHosts.has(new URL(p.url).host); } catch { return true; } });
const ts = (p) => { const t = p.date ? new Date(p.date).getTime() : NaN; return Number.isNaN(t) ? -Infinity : t; };
pooled.sort((a, b) => ts(b) - ts(a));

const posts = pooled.slice(0, 15);
// trust guard: if one date dominates the dated sample, the "date" is almost
// certainly a site-wide template/banner stamp (not per-post publish dates), so
// downstream must not read cadence from it. Reported; the scorer degrades.
const datedPosts = posts.filter((p) => p.date);
const modalDateCount = Object.values(datedPosts.reduce((c, p) => ((c[p.date] = (c[p.date] || 0) + 1), c), {})).reduce((m, n) => Math.max(m, n), 0);
const datesReliable = !(datedPosts.length >= 4 && modalDateCount / datedPosts.length >= 0.6);
const liveSurfaces = surfacesFound.filter((s) => !staleHosts.has(s.host));
// archive_size = total distinct items discovered across LIVE surfaces — an
// estimate of true archive depth used downstream for the maturity/nascent call
// (so a deep, prolific engine is never mistaken for a brand-new blog).
const archiveSize = liveSurfaces.reduce((n, s) => n + s.links.length, 0);
const freshWindowCount = posts.filter((p) => inWindow(p.date)).length;
const chosenBlogIndex = toSample.find((s) => !staleHosts.has(s.host))?.index ?? null;
const contentSurfaces = surfacesFound.map((s) => ({ index: s.index, subdomain: s.isSub, item_links: s.links.length, stale: staleHosts.has(s.host) }));
console.log(`content surfaces: ${liveSurfaces.length} live / ${surfacesFound.length} found | archive~${archiveSize} | pooled ${posts.length} (fresh ${freshWindowCount})${staleHosts.size ? ` | excluded stale: ${[...staleHosts].join(", ")}` : ""}`);

// llms.txt (sitemap was fetched up front for nav backfill)
const llms = await get(origin + "/llms.txt");
const llmsReal = llms.ok && !/<(!doctype|html)/i.test(llms.html.slice(0, 200));

// ---- assemble facts per element ----
const aboutPage = pages.find((p) => aboutPath && p.url.endsWith(aboutPath));
const pricingPage = pages.find((p) => pricingPath && p.url.endsWith(pricingPath));

const facts = {
  slug, domain, captured_at: prior?.captured_at ?? new Date().toISOString(), updated_at: new Date().toISOString(),
  sample: {
    urls: [
      ...pages.map((p) => ({ url: p.url, status: p.status })),
      ...posts.map((p) => ({ url: p.url, status: p.status, is_post: true })),
    ],
    about_found: Boolean(aboutPage), pricing_found: Boolean(pricingPage), blog_found: Boolean(chosenBlogIndex),
  },
  elements: {
    fetchability_no_js: {
      facts: pages.map((p) => ({ url: p.url, text_chars: p.text_chars, text_ratio: p.text_ratio, spa_shell: p.spa_shell, brand_in_raw: p.brand_in_raw, status: p.status })),
      note: "raw-HTML heuristics (visible-text volume, SPA-shell markers, brand presence in raw text); AI crawlers execute no JS",
    },
    crawl_coverage: {
      facts: {
        sitemap_real: Boolean(smOk),
        sitemap_status: sm.status,
        canonical_on_sample: pages.filter((p) => p.canonical).length + "/" + pages.length,
        homepage_og_type: pages[0]?.og_type ?? null,
        nav_paths_found: [...nav.keys()].slice(0, 25),
        about_page: aboutPage?.url ?? null, pricing_page: pricingPage?.url ?? null, blog_index: chosenBlogIndex,
      },
    },
    entity_schema: {
      facts: pages.map((p) => ({ url: p.url, ld_types: p.ld_types, sameAs_count: p.sameAs_count })),
    },
    branded_faq: {
      facts: pages.map((p) => ({ url: p.url, ...p.faq })),
    },
    answer_structure: {
      facts: pages.map((p) => ({ url: p.url, title: p.title, headings: p.headings, intro_excerpt: p.intro_excerpt })),
    },
    pricing_transparency: {
      facts: { pricing_page: pricingPage ? { url: pricingPage.url, intro_excerpt: pricingPage.intro_excerpt, headings: pricingPage.headings } : null },
    },
    llms_txt: { facts: { present: llmsReal, status: llms.status }, footnote: true },
    content_engine: {
      facts: {
        blog_index: chosenBlogIndex,
        sampled: posts.length,
        archive_size: archiveSize,
        fresh_window_count: freshWindowCount,
        fresh_window_months: CONTENT_FRESH_MONTHS,
        dates_reliable: datesReliable,
        surfaces: contentSurfaces,
        posts: posts.map((p) => ({
          url: p.url, title: p.title, date: p.date, byline: p.byline, surface: p.surface,
          headings_count: p.headings_count, marketing_density: p.marketing_density,
          word_count: p.word_count, excerpt: p.excerpt,
        })),
      },
      note: "multi-surface freshness-gated pool (stale subdomains excluded); frequency + bylines computed in score-elements (lib/content-engine.mjs) using archive_size for maturity; press|substantive + perspective/icp/structure/show-dont-tell judged there",
    },
  },
};

await writeFile(`${dir}/site-facts.json`, JSON.stringify(facts, null, 2) + "\n");
console.log(`\nsite-facts -> ${dir}/site-facts.json`);
console.log(`sample: ${pages.length} pages + ${posts.length} posts | sitemap_real=${facts.elements.crawl_coverage.facts.sitemap_real} | llms.txt=${llmsReal}`);
console.log(`schema types on sample: ${[...new Set(pages.flatMap((p) => p.ld_types))].join(", ") || "none"}`);
console.log(`content_engine posts: ${posts.length} | dated ${posts.filter((p) => p.date).length} | bylined ${posts.filter((p) => p.byline?.present).length}`);
