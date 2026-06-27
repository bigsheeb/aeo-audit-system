// Report builder — deterministic, key-free, no deps. Renders the flowing in-page
// AI-visibility report (the vertical successor to the Canva deck) from the same
// data contract the deck used: companies/<slug>/report-data.json (built by
// build-report-data.mjs) + context.json. Writes companies/<slug>/report.html.
//
//   node build-report.mjs <slug>
//
// All report CSS is scoped under `.aeo-report` and the content lives in a single
// `<div class="aeo-report">`, so build-page.mjs can lift the scoped <style> and
// that div straight into templates/landing.html without colliding with the
// wrapper's own styles. report.html is also a complete, standalone-previewable
// page (the <style id="aeo-base"> block paints bg/grain/font for that case;
// build-page.mjs ignores it and lets the landing wrapper provide those).
//
// Static copy (method steps, design principles, metric explainers, lever
// questions, CTA) is constant here. Every number, table, insight, and fix comes
// from report-data.json — change wording in the stager (deck-overrides.json), not
// here.

import { readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const slug = process.argv[2];
if (!slug) throw new Error("usage: node build-report.mjs <slug>");
const root = dirname(fileURLToPath(import.meta.url));
const dir = `${root}/companies/${slug}`;

let cf, ctx;
try {
  cf = JSON.parse(await readFile(`${dir}/report-data.json`, "utf8"));
} catch {
  console.error(`Missing ${dir}/report-data.json — run \`node build-report-data.mjs ${slug}\` first.`);
  process.exit(1);
}
try { ctx = JSON.parse(await readFile(`${dir}/context.json`, "utf8")); } catch { ctx = {}; }

const company = cf.company || ctx.company || slug;

// ---- helpers ----
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
// Terse rubric rationales arrive as fragments ("no AI bot blocked ..."); present
// them as sentences. Full sentences (already capitalized + punctuated) pass through.
const sentence = (s) => {
  s = String(s ?? "").trim();
  if (!s) return s;
  s = s.charAt(0).toUpperCase() + s.slice(1);
  if (!/[.!?]$/.test(s)) s += ".";
  return s;
};
const splitPct = (v) => {
  const m = String(v ?? "").trim().match(/^(-?\d+(?:\.\d+)?)\s*(%?)$/);
  return m ? { n: m[1], u: m[2] || "" } : { n: String(v ?? ""), u: "" };
};
const perf1 = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n.toFixed(1) : String(v ?? ""); };
const metricPct = (v) => { const { n, u } = splitPct(v); return `${esc(n)}<span class="u">${esc(u)}</span>`; };
const metricScore = (v) => `${esc(perf1(v))}<span class="u">/ 5</span>`;

const scoreboardFoot = cf.run_disclosure ? `${cf.run_disclosure}.` : "";

// ---- rows ----
const sovRows = [];
for (let i = 1; i <= 6; i++) {
  const label = cf[`sov_label_${i}`];
  if (!label) continue;
  const brand = company && String(label).toLowerCase().includes(String(company).toLowerCase());
  sovRows.push(`            <tr${brand ? ' class="brand"' : ""}><td class="name">${esc(label)}</td><td class="r">${esc(cf[`sov_pct_${i}`])}</td></tr>`);
}
const citedRows = [];
for (let i = 1; i <= 6; i++) {
  const host = cf[`cited_host_${i}`];
  if (!host) continue;
  citedRows.push(`            <tr><td class="name">${esc(host)}</td><td class="r">${esc(cf[`cited_rate_${i}`])}</td></tr>`);
}
const naRow = (lever, dim) => !lever || lever === "N/A" || !dim || dim === "N/A";
const scoreRows = (prefix, pill) => {
  const out = [];
  for (let i = 1; i <= 4; i++) {
    const lever = cf[`${prefix}_lever_${i}`], dim = cf[`${prefix}_dim_${i}`];
    if (naRow(lever, dim)) continue;
    out.push(`        <tr><td>${esc(lever)}</td><td class="name">${esc(dim)}</td><td class="r"><span class="pill ${pill}">${esc(cf[`${prefix}_score_${i}`])}</span></td><td>${esc(sentence(cf[`${prefix}_rationale_${i}`]))}</td></tr>`);
  }
  return out.join("\n");
};
const fixCards = [];
for (let i = 1; i <= 3; i++) {
  const text = cf[`fix_${i}`];
  if (!text) continue;
  const label = String(cf[`fix_label_${i}`] || "").replace(/\s-\s/g, " · ");
  fixCards.push(`    <div class="fix"><div class="n">${i}</div><div><div class="lbl">${esc(label)}</div><p>${esc(text)}</p></div></div>`);
}

// Lever rollup rows (Access / Identity / Content / Reputation). Questions are static.
const LEVER_ROWS = [
  { key: "access", nm: "Access", q: "Can a bot read you?" },
  { key: "identity", nm: "Identity", q: "Does AI know who you are?" },
  { key: "content", nm: "Content", q: "Are you a source worth citing?" },
  { key: "reputation", nm: "Reputation", q: "Do other sources vouch for you?" },
];
const leverRows = LEVER_ROWS
  .filter((l) => cf[`score_${l.key}`])
  .map((l) => `      <div class="lever-score"><div class="lbl"><span class="nm">${l.nm}</span><span class="mn">${l.q}</span></div><div class="sc">${metricScore(cf[`score_${l.key}`])}</div></div>`)
  .join("\n");

// ---- styles ----
// Standalone-only: paints body bg/grain/font so report.html previews on its own.
// build-page.mjs drops this block (the landing wrapper supplies bg/grain/font).
const AEO_BASE = `
  *{box-sizing:border-box;}
  html{scroll-behavior:smooth;}
  body{margin:0; background:#0F1117; color:#E8EAF0; font-family:"Inter",system-ui,sans-serif; font-weight:400; font-size:16px; line-height:1.65; -webkit-font-smoothing:antialiased; position:relative;}
  body::before{content:""; position:fixed; inset:0; pointer-events:none; z-index:99; opacity:0.022;
    background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='220' height='220'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.82' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");}`;

// Scoped report styles — lifted verbatim into the landing wrapper by build-page.mjs.
const AEO_STYLE = `
  .aeo-report{
    --bg:#0F1117; --bg-card:#16181F; --bg-card-2:#1A1D26;
    --fg:#E8EAF0; --fg-dim:#B0B3BF; --muted:#7A7D8A;
    --accent:#A3D9A5; --accent-dim:rgba(163,217,165,0.12); --accent-border:rgba(163,217,165,0.22);
    --bad:#E2A3A3; --bad-dim:rgba(226,163,163,0.10);
    --border:rgba(255,255,255,0.07); --border-2:rgba(255,255,255,0.12);
    --wrap:1080px;
    color:var(--fg); font-family:"Inter",system-ui,sans-serif; font-weight:400; font-size:16px; line-height:1.65; -webkit-font-smoothing:antialiased;
  }
  .aeo-report *{box-sizing:border-box;}
  .aeo-report .wrap{max-width:var(--wrap); margin:0 auto; padding:0 28px;}
  .aeo-report section{padding:clamp(52px,8vh,92px) 0; border-top:1px solid var(--border);}
  .aeo-report .eyebrow{font-size:11px; font-weight:500; letter-spacing:2.4px; text-transform:uppercase; color:var(--muted); margin:0 0 16px;}
  .aeo-report h1{font-weight:200; font-size:clamp(52px,9vw,104px); letter-spacing:-0.045em; line-height:0.98; margin:0 0 18px;}
  .aeo-report h2{font-weight:300; font-size:clamp(28px,4.4vw,44px); letter-spacing:-0.035em; line-height:1.07; margin:0 0 28px; max-width:18ch;}
  .aeo-report h2.wide{max-width:none;}
  .aeo-report h3{font-weight:500; font-size:18px; letter-spacing:-0.02em; margin:0 0 6px; color:var(--fg);}
  .aeo-report em{font-style:normal; color:var(--accent);}
  .aeo-report p{margin:0 0 16px; color:var(--fg-dim);}
  .aeo-report p.lead{color:var(--fg); font-size:18px; max-width:62ch;}
  .aeo-report .muted{color:var(--muted);} .aeo-report .fg{color:var(--fg);}
  .aeo-report a{color:var(--accent); text-decoration:none;} .aeo-report a:hover{text-decoration:underline;}
  .aeo-report .topbar{display:flex; align-items:center; justify-content:space-between; padding:26px 0 0;}
  .aeo-report .logo{font-weight:700; font-size:13px; letter-spacing:1px; color:var(--fg);}
  .aeo-report .logo span{color:var(--accent);}
  .aeo-report .cover{padding:clamp(44px,7vh,72px) 0 clamp(40px,5vh,56px); position:relative; overflow:hidden; border-top:none;}
  .aeo-report .cover::before{content:""; position:absolute; inset:0; pointer-events:none;
    background:radial-gradient(ellipse 760px 480px at 20% 60%, rgba(163,217,165,0.07), transparent 70%),
               radial-gradient(ellipse 680px 460px at 84% 26%, rgba(43,57,144,0.06), transparent 70%);}
  .aeo-report .cover .wrap{position:relative;}
  .aeo-report .cover .meta{display:flex; gap:48px; margin-top:36px; padding-top:24px; border-top:1px solid var(--border);}
  .aeo-report .cover .meta .k{font-size:11px; letter-spacing:1.5px; text-transform:uppercase; color:var(--muted); margin-bottom:4px;}
  .aeo-report .cover .meta .v{color:var(--fg-dim);}
  .aeo-report .grid{display:grid; gap:18px;}
  .aeo-report .g2{grid-template-columns:1fr 1fr;} .aeo-report .g3{grid-template-columns:repeat(3,1fr);} .aeo-report .g4{grid-template-columns:repeat(4,1fr);}
  .aeo-report .card{background:var(--bg-card); border:1px solid var(--border); border-radius:12px; padding:24px;}
  .aeo-report .num{font-size:11px; font-weight:500; letter-spacing:1.5px; color:var(--muted);}
  .aeo-report ol.steps{margin:18px 0 0; padding-left:20px; color:var(--fg-dim);} .aeo-report ol.steps li{margin:8px 0;} .aeo-report ol.steps li:last-child{margin-bottom:0;}
  .aeo-report ul.principles{list-style:none; margin:14px 0 0; padding:0;}
  .aeo-report ul.principles li{margin:0 0 20px; color:var(--fg-dim); font-size:14.5px; line-height:1.55;}
  .aeo-report ul.principles li:last-child{margin-bottom:0;}
  .aeo-report ul.principles li b{display:block; color:var(--accent); font-weight:500; margin-bottom:3px;}
  .aeo-report ul.principles li .vs{display:block; color:var(--fg-dim); font-size:13.5px;}
  .aeo-report .methodology-link{margin-top:auto; margin-bottom:0;} .aeo-report .methodology-link a{font-size:14px;}
  .aeo-report .prompt{margin-top:16px; padding:16px 18px; background:var(--bg-card-2); border-left:3px solid var(--accent-border); border-radius:0 8px 8px 0;}
  .aeo-report .prompt .q{color:var(--fg); font-style:italic; font-size:15px;}
  .aeo-report .board{background:var(--bg-card); border:1px solid var(--border); border-radius:14px; padding:28px 30px; margin-bottom:18px;}
  .aeo-report .board .row{display:grid; grid-template-columns:repeat(3,1fr); gap:24px;}
  .aeo-report .board .label{font-size:11px; letter-spacing:1.4px; text-transform:uppercase; color:var(--muted); margin-bottom:8px;}
  .aeo-report .board .metric{font-weight:200; font-size:clamp(40px,5vw,56px); letter-spacing:-0.04em; line-height:1;}
  .aeo-report .board .metric .u{font-size:20px; color:var(--muted); font-weight:400; margin-left:3px;}
  .aeo-report .board .cap{display:inline-block; font-size:11px; letter-spacing:1.6px; text-transform:uppercase; color:var(--accent); background:var(--accent-dim); padding:3px 10px; border-radius:3px; margin-bottom:18px;}
  .aeo-report .board .insight{margin:18px 0 0; padding-left:14px; border-left:3px solid var(--accent-border); color:var(--fg-dim); font-size:14.5px;}
  .aeo-report table{width:100%; border-collapse:collapse; font-size:14.5px;}
  .aeo-report caption{text-align:left; font-size:11px; letter-spacing:1.4px; text-transform:uppercase; color:var(--muted); padding-bottom:12px;}
  .aeo-report th{text-align:left; font-weight:500; font-size:11px; letter-spacing:1px; text-transform:uppercase; color:var(--muted); padding:0 12px 11px; border-bottom:1px solid var(--border-2);}
  .aeo-report th.r,.aeo-report td.r{text-align:right;}
  .aeo-report td{padding:12px; border-bottom:1px solid var(--border); color:var(--fg-dim);}
  .aeo-report td.name{color:var(--fg);}
  .aeo-report tr.brand td{background:var(--accent-dim);} .aeo-report tr.brand td.name{color:var(--accent); font-weight:500;}
  .aeo-report .pill{display:inline-block; min-width:24px; text-align:center; padding:2px 9px; border-radius:3px; font-weight:600; font-size:13px;}
  .aeo-report .pill.hi{background:var(--accent-dim); color:var(--accent);} .aeo-report .pill.lo{background:var(--bad-dim); color:var(--bad);}
  .aeo-report .insight-note{margin-top:16px; color:var(--fg-dim); font-size:14px; border-left:3px solid var(--accent-border); padding-left:14px;}
  .aeo-report .insight-note.bad{border-left-color:var(--bad);}
  .aeo-report .lever-score{display:flex; align-items:baseline; gap:32px; padding:16px 0; border-bottom:1px solid var(--border);}
  .aeo-report .lever-score:last-child{border-bottom:none;}
  .aeo-report .lever-score .lbl{display:flex; align-items:baseline; gap:14px; width:340px; flex:none;}
  .aeo-report .lever-score .nm{font-size:17px; color:var(--fg); font-weight:500;}
  .aeo-report .lever-score .mn{color:var(--muted); font-size:14px; font-weight:400;}
  .aeo-report .lever-score .sc{font-weight:200; font-size:38px; letter-spacing:-0.03em; line-height:1;}
  .aeo-report .lever-score .sc .u{font-size:16px; color:var(--muted); font-weight:400; margin-left:3px;}
  .aeo-report .fix{display:grid; grid-template-columns:auto 1fr; gap:22px; background:var(--bg-card); border:1px solid var(--border); border-left:3px solid var(--accent); border-radius:12px; padding:24px 26px; margin-bottom:16px;}
  .aeo-report .fix .n{font-weight:200; font-size:40px; color:var(--accent); line-height:0.9;}
  .aeo-report .fix .lbl{font-size:11px; letter-spacing:1.5px; text-transform:uppercase; color:var(--muted); margin-bottom:8px;}
  .aeo-report .fix p{margin:0; color:var(--fg);}
  .aeo-report .fixfoot{color:var(--muted); font-size:13px; margin-top:6px;}
  .aeo-report .cta{position:relative; overflow:hidden;}
  .aeo-report .cta::before{content:""; position:absolute; inset:0; pointer-events:none;
    background:radial-gradient(ellipse 700px 460px at 28% 60%, rgba(163,217,165,0.07), transparent 70%);}
  .aeo-report .cta .wrap{position:relative;}
  .aeo-report .btn{display:inline-block; background:var(--accent); color:#0c1a0d; font-weight:500; padding:14px 26px; border-radius:3px; font-size:15px; margin-top:6px;}
  .aeo-report .btn:hover{background:#B8E2B9; text-decoration:none;}
  .aeo-report .sig{margin-top:14px; color:var(--muted); font-size:14px;}
  .aeo-report .footnote{color:var(--muted); font-size:12.5px; margin-top:14px;}
  @media(max-width:760px){
    .aeo-report .g2,.aeo-report .g3,.aeo-report .g4{grid-template-columns:1fr;}
    .aeo-report .board .row{grid-template-columns:1fr; gap:20px;}
    .aeo-report .cover .meta{gap:28px; flex-wrap:wrap;}
  }`;

// ---- report body (the .aeo-report div lifted into the wrapper) ----
const BODY = `<div class="aeo-report">

<!-- COVER -->
<header class="cover">
  <div class="wrap">
    <h1>${esc(company)}</h1>
    <p class="lead">Improving how AI models discover and describe ${esc(company)}.</p>
    <div class="meta">
      <div><div class="k">Date</div><div class="v">${esc(cf.audit_date)}</div></div>
    </div>
  </div>
</header>

<!-- METHOD -->
<section>
  <div class="wrap">
    <p class="eyebrow">How this was run</p>
    <h2 class="wide">One audit, <em>run by a multi-agent system.</em></h2>
    <div class="grid g2" style="align-items:stretch;">
      <div style="display:flex; flex-direction:column; padding:24px 0;">
        <p class="lead">Your company was run through a multi-agent system for measuring and improving AI visibility.</p>
        <ol class="steps">
          <li>Measured how LLMs respond to your buyers' prompts.</li>
          <li>Audited you on dimensions that influence LLM responses.</li>
          <li>Made recommendations to improve your performance.</li>
        </ol>
      </div>
      <div class="card">
        <div class="num">Design principles</div>
        <ul class="principles">
          <li><b>Measure what matters.</b><span class="vs">A performance score that goes beyond mention rate diagnostics.</span></li>
          <li><b>Focus on improvement.</b><span class="vs">Online presence audited on 25+ dimensions that influence LLM responses.</span></li>
          <li><b>Reproducible results.</b><span class="vs">All performance and audit scores are quantitative and reproducible run-to-run.</span></li>
        </ul>
      </div>
    </div>
    <p class="footnote">Tested across Claude, Perplexity, and ChatGPT with web search on.</p>
  </div>
</section>

<!-- WHAT WE MEASURED -->
<section>
  <div class="wrap">
    <p class="eyebrow">What we measured</p>
    <h2 class="wide">We measured <em>two types of prompts</em> using <em>three metrics</em>.</h2>
    <div class="grid g2">
      <div class="card">
        <div class="num">01 · Discovery</div>
        <h3 style="margin-top:10px;">Prompts about your <em>category</em></h3>
        <p>Unbranded prompts buyers use while researching options. Tests whether AI names you at all.</p>
        <div class="prompt"><div class="q">"${esc(cf.disc_example_prompt)}"</div></div>
      </div>
      <div class="card">
        <div class="num">02 · Assessment</div>
        <h3 style="margin-top:10px;">Prompts about your <em>company</em></h3>
        <p>Branded prompts buyers use while assessing your products. Tests how accurately AI describes you.</p>
        <div class="prompt"><div class="q">"${esc(cf.assess_example_prompt)}"</div></div>
      </div>
    </div>
    <div class="grid g3" style="margin-top:18px;">
      <div class="card"><div class="num">01</div><h3 style="margin-top:10px;">Mention Rate</h3><p>Share of responses that mention your brand.</p></div>
      <div class="card"><div class="num">02</div><h3 style="margin-top:10px;">Citation Rate</h3><p>Share of responses that cite your own content.</p></div>
      <div class="card"><div class="num">03</div><h3 style="margin-top:10px;">Performance Score</h3><p>A 0 to 5 score of response quality, using a method we developed.</p></div>
    </div>
  </div>
</section>

<!-- PERFORMANCE SCORE -->
<section>
  <div class="wrap">
    <p class="eyebrow">The performance score</p>
    <h2 class="wide">Our performance score <em>measures what matters.</em></h2>
    <div class="grid g2" style="align-items:stretch;">
      <div style="display:flex; flex-direction:column; justify-content:space-between; padding:24px 0;">
        <p class="lead" style="margin:0;">Most industry tools focus on mention rate, which doesn't measure whether a response was accurate or favorable.</p>
        <p style="margin:0;">We score the quality of each LLM response using a reproducible method that allows for immediate interpretation and trending.</p>
      </div>
      <div class="card">
        <div class="num">How the 0 to 5 score is computed</div>
        <ol class="steps">
          <li>Every prompt gets success criteria, drafted by a human</li>
          <li>An agent grades each response against that criteria</li>
          <li>Each criterion gets pass (1), partial (0.5), or fail (0)</li>
          <li>The score is the weighted share of criteria passed</li>
        </ol>
      </div>
    </div>
  </div>
</section>

<!-- SCOREBOARD -->
<section>
  <div class="wrap">
    <p class="eyebrow">The scoreboard</p>
    <h2>${esc(company)}'s AI visibility <em>scoreboard.</em></h2>
    <div class="board">
      <span class="cap">Discovery prompts</span>
      <div class="row">
        <div><div class="label">Mention rate</div><div class="metric">${metricPct(cf.disc_mention)}</div></div>
        <div><div class="label">Citation rate</div><div class="metric">${metricPct(cf.disc_citation)}</div></div>
        <div><div class="label">Performance</div><div class="metric">${metricScore(cf.disc_performance)}</div></div>
      </div>
      <p class="insight">${esc(cf.disc_gap)}</p>
    </div>
    <div class="board">
      <span class="cap">Assessment prompts</span>
      <div class="row">
        <div><div class="label">Mention rate</div><div class="metric">${metricPct(cf.assess_mention)}</div></div>
        <div><div class="label">Citation rate</div><div class="metric">${metricPct(cf.assess_citation)}</div></div>
        <div><div class="label">Performance</div><div class="metric">${metricScore(cf.assess_performance)}</div></div>
      </div>
      <p class="insight">${esc(cf.assess_gap)}</p>
    </div>
    <p class="footnote">${esc(scoreboardFoot)}</p>
  </div>
</section>

<!-- SHARE OF VOICE -->
<section>
  <div class="wrap">
    <p class="eyebrow">Who wins the category answer</p>
    <h2 class="wide">Share of voice, <em>discovery prompts.</em></h2>
    <div class="grid g2" style="align-items:start; gap:40px;">
      <div>
        <table>
          <caption>Most-named providers</caption>
          <thead><tr><th>Provider</th><th class="r">Mention rate</th></tr></thead>
          <tbody>
${sovRows.join("\n")}
          </tbody>
        </table>
        <p class="insight-note">${esc(cf.sov_insight)}</p>
      </div>
      <div>
        <table>
          <caption>Domains AI cites for the category</caption>
          <thead><tr><th>Website domain</th><th class="r">Citation rate</th></tr></thead>
          <tbody>
${citedRows.join("\n")}
          </tbody>
        </table>
        <p class="insight-note">${esc(cf.cited_insight)}</p>
      </div>
    </div>
  </div>
</section>

<!-- AUDIT SCORES -->
<section>
  <div class="wrap">
    <p class="eyebrow">The audit</p>
    <h2 class="wide">Your audit scores on <em>four performance levers.</em></h2>
    <p class="lead" style="margin-bottom:30px;">Four areas influence how LLMs respond to prompts related to your category. We audited your site, social media, industry publications, and your competitors to score where you currently stand.</p>
    <div class="card" style="padding:8px 34px; width:fit-content;">
${leverRows}
    </div>
    <p class="footnote">Agents scored your company on ${esc(cf.dim_total)} dimensions across these four levers.</p>
  </div>
</section>

<!-- BEST -->
<section>
  <div class="wrap">
    <p class="eyebrow">Strengths</p>
    <h2>Where you <em>perform best.</em></h2>
    <table>
      <thead><tr><th>Lever</th><th>Dimension</th><th class="r">Score</th><th>What we found</th></tr></thead>
      <tbody>
${scoreRows("best", "hi")}
      </tbody>
    </table>
    <p class="footnote">Full scores for all ${esc(cf.dim_total)} dimensions available on request.</p>
  </div>
</section>

<!-- WORST -->
<section>
  <div class="wrap">
    <p class="eyebrow">Gaps</p>
    <h2>Where you <em>perform worst.</em></h2>
    <table>
      <thead><tr><th>Lever</th><th>Dimension</th><th class="r">Score</th><th>What we found</th></tr></thead>
      <tbody>
${scoreRows("worst", "lo")}
      </tbody>
    </table>
    <p class="footnote">Full scores for all ${esc(cf.dim_total)} dimensions available on request.</p>
  </div>
</section>

<!-- FIXES -->
<section>
  <div class="wrap">
    <p class="eyebrow">Where to start</p>
    <h2>Your <em>three highest-leverage fixes.</em></h2>
${fixCards.join("\n")}
    <p class="fixfoot">Ranked by the importance of each dimension to your AI visibility.</p>
  </div>
</section>

</div>`;

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AI Visibility Report · ${esc(company)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@200;300;400;500;600;700&display=swap" rel="stylesheet" />
<style id="aeo-base">${AEO_BASE}
</style>
<style id="aeo-report-style">${AEO_STYLE}
</style>
</head>
<body>
${BODY}
</body>
</html>
`;

// A report never ships with a hole in the headline data.
const REQUIRED = { company, audit_date: cf.audit_date, disc_gap: cf.disc_gap, assess_gap: cf.assess_gap };
const missing = Object.entries(REQUIRED).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error(`Missing required report values: ${missing.join(", ")} — check deck-overrides.json / report-data.json.`);
  process.exit(1);
}

await writeFile(`${dir}/report.html`, HTML);
console.log(`report -> ${dir}/report.html  (${sovRows.length} SoV rows, ${citedRows.length} cited, ${fixCards.length} fixes)`);
