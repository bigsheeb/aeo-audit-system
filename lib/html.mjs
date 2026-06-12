// Shared, dependency-free HTML extraction helpers for the site crawler.
// Pure functions (no module-level state) so they can be unit-tested offline.

export const stripTags = (html) => html
  .replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<style[\s\S]*?<\/style>/gi, " ")
  .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ").replace(/<svg[\s\S]*?<\/svg>/gi, " ")
  .replace(/<[^>]+>/g, " ").replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ({ "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'", "&nbsp;": " " }[m]))
  .replace(/\s+/g, " ").trim();

// Read an attribute value from a single tag's source. Handles double-quoted,
// single-quoted, AND unquoted values — the last is valid HTML5 and common in
// minified markup (e.g. `<a href=https://x.com/>`, which is exactly what broke
// nav discovery on qdrant.tech). The leading `\s` keeps `data-href=` from
// shadowing `href=`.
export const tagAttr = (tag, name) => {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return m ? (m[2] ?? m[3] ?? m[4] ?? null) : null;
};

// Map of same-origin internal link path -> first link text seen. Parses each
// <a> tag's open tag, then reads its href under any quoting style. Absolute
// same-origin URLs are normalized to paths; cross-origin / mailto / tel /
// javascript hrefs are dropped. Trailing #fragment and ?query are stripped.
export const internalLinks = (html, origin, domain) => {
  const links = new Map();
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    let href = tagAttr("<a" + m[1] + ">", "href");
    if (!href) continue;
    href = href.trim().replace(/[#?].*$/, "");
    if (!href || /^(mailto:|tel:|javascript:)/i.test(href)) continue;
    if (href.startsWith("//")) href = "https:" + href;
    try {
      const u = href.startsWith("http") ? new URL(href) : new URL(href, origin + "/");
      if (u.hostname.replace(/^www\./, "") !== domain) continue;
      const path = u.pathname.replace(/\/$/, "") || "/";
      if (!links.has(path)) links.set(path, stripTags(m[2]).slice(0, 60));
    } catch {}
  }
  return links;
};

// <loc> URLs from a sitemap urlset or index (unparsed — caller normalizes).
export const sitemapLocs = (xml) => [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => m[1]);
