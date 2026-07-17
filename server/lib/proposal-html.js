// PJL proposal HTML generator (Proposal HTML brief, 2026-07).
//
// Turns a normalized `proposal` data object (built by proposal-data.js from
// a live quote) into ONE self-contained .html string matching the
// hand-built reference design (PJL-Sprinkler-System-Proposal.html). The
// theme CSS + white logo are copied VERBATIM from that reference and read
// from server/lib/proposal-assets/ at load — same on-disk-asset pattern as
// the PDF font loader and quote-narratives templates — so the output is
// pixel-identical to what Patrick approved by hand; only the content is
// data-driven.
//
// This module is PURE (data → string). It touches no quote store, no
// network, no customer records — that mapping lives in proposal-data.js.
// The generated HTML is what the phone-gated /approve serves once it's
// written into the proposal-docs slot (server.js), so it must stay fully
// self-contained (all CSS inline, logo + hero photo embedded as data URIs;
// only Google Fonts load over the network, exactly as the reference does).
//
// v1 ships the Sprinkler (light) artifact. Lighting (dark) + Combined
// follow; renderLightingProposal / renderCombinedProposal will slot in
// beside renderSprinklerProposal with their own theme assets.

const fs = require("node:fs");
const path = require("node:path");

const ASSETS_DIR = path.join(__dirname, "proposal-assets");
const SPRINKLER_CSS = fs.readFileSync(path.join(ASSETS_DIR, "sprinkler-theme.css"), "utf8");
const LIGHTING_CSS = fs.readFileSync(path.join(ASSETS_DIR, "lighting-theme.css"), "utf8");
const LOGO_WHITE = fs.readFileSync(path.join(ASSETS_DIR, "logo-white.datauri.txt"), "utf8").trim();
// Amber ("lamp") logo — the dark "after dark" lighting theme uses this in the
// hero mark and footer signoff, matching the hand-built lighting reference
// (the white logo is for the light sprinkler theme's green band).
const LOGO_AMBER = fs.readFileSync(path.join(ASSETS_DIR, "logo-amber.datauri.txt"), "utf8").trim();

// ---- helpers ----------------------------------------------------------

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
// Rich fields (count-note, clause bodies, scope items) are admin/template-
// authored — never raw customer input — and carry a tiny inline vocabulary
// (<b>, &nbsp;). They pass through as-is; the adapter is responsible for
// only routing trusted copy here.
function rich(s) { return String(s == null ? "" : s); }

const GLYPH = { large: "g-large", medium: "g-medium", small: "g-small", ring: "g-ring" };
function glyphClass(g) { return GLYPH[g] || "g-small"; }

// ---- hero -------------------------------------------------------------

// When a hero photo is supplied, layer it UNDER a brand scrim so the white
// heading + amber accent stay legible: the house shows through up top, and
// a deep-green gradient grounds the text at the bottom (where the hero's
// flex-end content sits). Base64 data URIs contain no single quotes, so
// url('…') inside the double-quoted style attribute is safe. Falls back to
// the reference's solid green band when no photo is given. In @media print
// the stylesheet's `background:var(--green) !important` still wins, so
// print stays a clean solid band — good for ink + contrast.
function heroPhotoStyle(photo) {
  if (!photo) return "";
  const layers = [
    "linear-gradient(180deg, rgba(15,31,20,0) 0%, rgba(15,31,20,.12) 36%, rgba(20,61,36,.70) 74%, rgba(20,61,36,.94) 100%)",
    "linear-gradient(158deg, rgba(27,77,46,.34) 0%, rgba(20,61,36,.46) 100%)",
    "radial-gradient(58% 52% at 84% 16%, rgba(224,123,36,.22), transparent 60%)",
    `url('${photo}') center/cover no-repeat`
  ];
  return ` style="background:${layers.join(", ")}"`;
}

function renderHero(hero, meta) {
  const facts = (hero.facts || []).map((f) =>
    `      <div class="fact"><span class="fact-k">${esc(f.k)}</span><span class="fact-v">${esc(f.v)}</span></div>`
  ).join("\n");
  return `<header class="hero"${heroPhotoStyle(hero.photo)}>
  <div class="hero-in wrap">
    <p class="eyebrow">${esc(meta.docKicker)}</p>
    <h1>${esc(hero.h1Lead)}<br><em>${esc(hero.h1Accent)}</em></h1>
    <p class="hero-sub">${rich(hero.sub)}</p>
    <div class="facts">
${facts}
    </div>
  </div>
</header>`;
}

// ---- how-it-works cards ----------------------------------------------

function renderSystem(system) {
  const cards = (system.cards || []).map((c) =>
    `    <li class="pr">
      <h3 class="pr-h">${esc(c.title)}</h3>
      <p class="pr-p">${rich(c.body)}</p>
    </li>`
  ).join("\n");
  return `<section class="sec wrap" id="system">
  <h2 class="sec-h">${esc(system.heading)}</h2>
  <p class="sec-lead">${rich(system.lead)}</p>
  <ul class="prs">
${cards}
  </ul>
</section>`;
}

// ---- schedule table (+ payment block, which lives inside the section) --

function renderScheduleRows(rows) {
  return (rows || []).map((r) =>
    `          <tr>
            <td><span class="t-cls-in"><span class="g ${glyphClass(r.glyph)}" aria-hidden="true"></span><span>${esc(r.cls)}</span></span></td>
            <td class="t-spec">${esc(r.detail)}</td>
            <td class="t-num">${esc(r.qty)}</td>
          </tr>`
  ).join("\n");
}

function renderSchedule(schedule, paymentHtml) {
  return `<section class="sec wrap" id="schedule">
  <h2 class="sec-h">${esc(schedule.heading)}</h2>
  <p class="sec-lead">${rich(schedule.lead)}</p>

  <div class="totals">
    <div class="totals-in">
      <table>
        <thead>
          <tr>
            <th>Component</th>
            <th class="h-spec">Detail</th>
            <th class="t-num">Qty</th>
          </tr>
        </thead>
        <tbody>
${renderScheduleRows(schedule.rows)}
        </tbody>
        <tfoot>
          <tr class="f-sub">
            <td colspan="2" class="f-lab">${rich(schedule.subtotalLabel || "Subtotal")}</td>
            <td class="t-num">${esc(schedule.subtotal)}</td>
          </tr>
          <tr>
            <td colspan="2" class="f-lab">HST 13%</td>
            <td class="t-num t-dim">${esc(schedule.hst)}</td>
          </tr>
          <tr class="f-total">
            <td colspan="2" class="f-lab">Total</td>
            <td class="t-num">${esc(schedule.total)}</td>
          </tr>
        </tfoot>
      </table>

      <p class="count-note">${rich(schedule.countNote)}</p>
    </div>
  </div>

${paymentHtml}
</section>`;
}

// Payment block — either a deposit/balance pair (quote ≥ threshold) or the
// single total-due + warranty pair the sprinkler reference uses under it.
function renderPayment(payment) {
  if (payment.mode === "deposit" && payment.deposit) {
    const d = payment.deposit, b = payment.balance;
    return `  <div class="pay">
    <div class="pay-col now">
      <p class="pay-k">${esc(d.label)}</p>
      <p class="pay-v">${esc(d.amount)}</p>
      <p class="pay-when">${esc(d.when)}</p>
      <p class="pay-p">${rich(d.body)}</p>
    </div>
    <div class="pay-col">
      <p class="pay-k">${esc(b.label)}</p>
      <p class="pay-v">${esc(b.amount)}</p>
      <p class="pay-when">${esc(b.when)}</p>
      <p class="pay-p">${rich(b.body)}</p>
    </div>
  </div>`;
  }
  const t = payment.totalDue, w = payment.warranty;
  const warrantyStyle = w && w.valueSmall ? ' style="font-size:clamp(26px,4vw,38px)"' : "";
  return `  <div class="pay">
    <div class="pay-col now">
      <p class="pay-k">${esc(t.label)}</p>
      <p class="pay-v">${esc(t.amount)}</p>
      <p class="pay-when">${esc(t.when)}</p>
      <p class="pay-p">${rich(t.body)}</p>
    </div>
    <div class="pay-col">
      <p class="pay-k">${esc(w.label)}</p>
      <p class="pay-v"${warrantyStyle}>${esc(w.value)}</p>
      <p class="pay-when">${esc(w.when)}</p>
      <p class="pay-p">${rich(w.body)}</p>
    </div>
  </div>`;
}

// ---- scope (includes / excludes) -------------------------------------

function renderScope(scope) {
  const inc = (scope.includes || []).map((li) => `        <li>${rich(li)}</li>`).join("\n");
  const exc = (scope.excludes || []).map((li) => `        <li>${rich(li)}</li>`).join("\n");
  return `<section class="sec wrap" id="scope">
  <h2 class="sec-h">${esc(scope.heading)}</h2>
  <p class="sec-lead">${rich(scope.lead)}</p>

  <div class="scope">
    <div class="scope-col in">
      <h3 class="scope-h in">${esc(scope.inHeading || "Included")}</h3>
      <ul>
${inc}
      </ul>
    </div>
    <div class="scope-col out">
      <h3 class="scope-h out">${esc(scope.outHeading || "Not included")}</h3>
      <ul>
${exc}
      </ul>
    </div>
  </div>
</section>`;
}

// ---- seasonal care (spring opening + fall closing rates) -------------
// Reuses the two-column payment block styling. Rendered only when the
// adapter supplies seasonal data (irrigation proposals with a known zone
// count). Both columns are plain pay-col (neither is a "due now" highlight).
function renderSeasonalCol(c) {
  return `    <div class="pay-col">
      <p class="pay-k">${esc(c.label)}</p>
      <p class="pay-v">${esc(c.value)}</p>
      <p class="pay-when">${esc(c.when)}</p>
      <p class="pay-p">${rich(c.body)}</p>
    </div>`;
}
function renderSeasonal(seasonal) {
  if (!seasonal) return "";
  const note = seasonal.note ? `\n  <p class="count-note">${rich(seasonal.note)}</p>` : "";
  return `<section class="sec wrap" id="seasonal">
  <h2 class="sec-h">${esc(seasonal.heading)}</h2>
  <p class="sec-lead">${rich(seasonal.lead)}</p>
  <div class="pay">
${renderSeasonalCol(seasonal.spring)}
${renderSeasonalCol(seasonal.fall)}
  </div>${note}
</section>`;
}

// ---- terms / fine-print clauses --------------------------------------

function renderClause(c) {
  const title = c.title ? `    <h3 class="clause-h">${esc(c.title)}</h3>\n` : "";
  const points = (c.points && c.points.length)
    ? `\n    <ul>\n${c.points.map((p) => `      <li>${rich(p)}</li>`).join("\n")}\n    </ul>`
    : "";
  return `  <div class="clause">
${title}    ${rich(c.bodyHtml)}${points}
  </div>`;
}

function renderTerms(terms) {
  const clauses = (terms.clauses || []).map(renderClause).join("\n\n");
  return `<section class="sec wrap" id="terms">
  <h2 class="sec-h">${esc(terms.heading)}</h2>

${clauses}
</section>`;
}

// ---- close band -------------------------------------------------------

function renderClose(close) {
  return `<section class="close">
  <div class="wrap">
  <div class="signoff-mark"><img src="${LOGO_WHITE}" alt="PJL Land Services"></div>
  <h2>${esc(close.heading)}</h2>
  <p>${rich(close.body)}</p>
  <p class="sig">${rich(close.sig)}</p>
  </div>
</section>`;
}

// ---- document ---------------------------------------------------------

function renderSprinklerProposal(data) {
  const meta = data.meta || {};
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(meta.title || "Irrigation System Proposal — PJL Land Services")}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Barlow:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
${SPRINKLER_CSS}
</style>
</head>
<body>

<div class="mark"><img src="${LOGO_WHITE}" alt="PJL Land Services"></div>

${renderHero(data.hero || {}, meta)}

${renderSystem(data.system || {})}

${renderSchedule(data.schedule || {}, renderPayment(data.payment || {}))}

${renderScope(data.scope || {})}

${renderSeasonal(data.seasonal)}

${renderTerms(data.terms || {})}

${renderClose(data.close || {})}

</body>
</html>`;
}

// ======================================================================
// Lighting ("after dark") — dark theme. Shares the section markup with the
// sprinkler artifact (renderSystem / renderScope / renderPayment) but uses
// the dark theme CSS, a hero background render, an Each/Line fixture
// schedule, and a CTA close. The 7 rendered "views" are Phase B.
// ======================================================================

const LIGHT_GLYPH = { large: "g-large", medium: "g-medium", small: "g-small", recessed: "g-recessed", ring: "g-ring" };
function lightGlyph(cls) { return LIGHT_GLYPH[String(cls || "").toLowerCase().trim()] || "g-small"; }

function renderLightingHero(hero, meta) {
  const facts = (hero.facts || []).map((f) =>
    `      <div class="fact"><span class="fact-k">${esc(f.k)}</span><span class="fact-v">${esc(f.v)}</span></div>`
  ).join("\n");
  const bg = hero.bgPhoto ? `\n  <div class="hero-bg"><img src="${hero.bgPhoto}" alt=""></div>` : "";
  return `<header class="hero">${bg}
  <div class="mark"><img src="${LOGO_AMBER}" alt="PJL Land Services"></div>
  <div class="hero-in wrap">
    <p class="eyebrow">${esc(meta.docKicker)}</p>
    <h1>${esc(hero.h1Lead)}<br><em>${esc(hero.h1Accent)}</em></h1>
    <p class="hero-sub">${rich(hero.sub)}</p>
    <div class="facts">
${facts}
    </div>
  </div>
</header>`;
}

// Fixture schedule — Class · In-Lite fixture · Qty · Each · Line. Per-fixture
// pricing IS shown here (unlike the sprinkler schedule). Payment block stitched
// inside the section, same as sprinkler.
function renderLightingSchedule(schedule, paymentHtml) {
  const rows = (schedule.rows || []).map((r) =>
    `          <tr>
            <td class="t-cls"><span class="t-cls-in"><span class="g ${lightGlyph(r.glyph)}" aria-hidden="true"></span><span>${esc(r.cls)}</span></span></td>
            <td class="t-fix">${esc(r.fixture)}</td>
            <td class="t-num">${esc(r.qty)}</td>
            <td class="t-num t-dim">${esc(r.each)}</td>
            <td class="t-num t-strong">${esc(r.line)}</td>
          </tr>`
  ).join("\n");
  return `<section class="sec wrap" id="schedule">
  <h2 class="sec-h">${esc(schedule.heading)}</h2>
  <p class="sec-lead">${rich(schedule.lead)}</p>
  <div class="totals">
    <div class="totals-in">
      <table>
        <thead>
          <tr>
            <th>Class</th>
            <th class="h-fix">In-Lite fixture</th>
            <th class="t-num">Qty</th>
            <th class="t-num">Each</th>
            <th class="t-num">Line</th>
          </tr>
        </thead>
        <tbody>
${rows}
        </tbody>
        <tfoot>
          <tr class="f-sub">
            <td colspan="4" class="f-lab">${rich(schedule.subtotalLabel || "Subtotal")}</td>
            <td class="t-num t-strong">${esc(schedule.subtotal)}</td>
          </tr>
          <tr>
            <td colspan="4" class="f-lab">HST 13%</td>
            <td class="t-num t-dim">${esc(schedule.hst)}</td>
          </tr>
          <tr class="f-total">
            <td colspan="4" class="f-lab">Total</td>
            <td class="t-num">${esc(schedule.total)}</td>
          </tr>
        </tfoot>
      </table>

      <p class="count-note">${rich(schedule.countNote)}</p>
    </div>
  </div>

${paymentHtml}
</section>`;
}

function renderLightingClose(close) {
  const cta = close.ctaLabel ? `\n  <a class="cta" href="${esc(close.ctaHref || "#")}">${esc(close.ctaLabel)}</a>` : "";
  return `<section class="close wrap">
  <h2>${esc(close.heading)}</h2>
  <p>${rich(close.body)}</p>${cta}
  <div class="signoff-mark"><img src="${LOGO_AMBER}" alt="PJL Land Services"></div>
  <p class="sig">${rich(close.sig)}</p>
</section>`;
}

// The rendered dusk "views" — Phase B. Returns "" until view data is authored.
function renderLightingViews(views) {
  if (!Array.isArray(views) || !views.length) return "";
  return ""; // Phase B: image + per-view fixture schedule + lightbox + side nav
}

function renderLightingProposal(data) {
  const meta = data.meta || {};
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(meta.title || "Landscape Lighting Proposal — PJL Land Services")}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Barlow:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
${LIGHTING_CSS}
</style>
</head>
<body>

${renderLightingHero(data.hero || {}, meta)}

${renderSystem(data.system || {})}

${renderLightingViews(data.views)}

${renderLightingSchedule(data.schedule || {}, renderPayment(data.payment || {}))}

${renderScope(data.scope || {})}

${renderTerms(data.terms || {})}

${renderLightingClose(data.close || {})}

</body>
</html>`;
}

// ======================================================================
// Combined ("two projects, one property") — dark theme. A bundle page that
// summarises two standalone proposals side by side, then offers three
// options: each project on its own, or both together at a combined rate.
// Its numbers are MERGED from the two child quotes by the adapter; this
// module only lays them out. Uses its own CSS asset + the white logo.
// ======================================================================

const COMBINED_CSS = fs.readFileSync(path.join(ASSETS_DIR, "combined-theme.css"), "utf8");
const COMBINED_GLYPH = { small: "g-small", medium: "g-medium", large: "g-large", recessed: "g-recessed", ring: "g-ring" };
function combinedGlyph(g) { return COMBINED_GLYPH[String(g || "").toLowerCase().trim()] || "g-small"; }

function renderCombinedHero(hero, meta) {
  const facts = (hero.facts || []).map((f) =>
    `      <div class="fact"><span class="fact-k">${esc(f.k)}</span><span class="fact-v">${esc(f.v)}</span></div>`
  ).join("\n");
  return `<div class="mark"><img src="${LOGO_WHITE}" alt="PJL Land Services"></div>

<header class="hero">
  <div class="hero-in wrap">
    <p class="eyebrow">${esc(meta.docKicker)}</p>
    <h1>${esc(hero.h1Lead)}<br><em>${esc(hero.h1Accent)}</em></h1>
    <p class="hero-sub">${rich(hero.sub)}</p>
    <div class="facts">
${facts}
    </div>
  </div>
</header>`;
}

// The two standalone projects, summarised side by side.
function renderCombinedProjects(projects) {
  const cards = (projects.items || []).map((p) =>
    `    <div class="proj">
      <p class="proj-tag"><span class="g ${combinedGlyph(p.glyph)}" aria-hidden="true"></span>&nbsp; ${esc(p.num)}</p>
      <h3 class="proj-h">${esc(p.name)}</h3>
      <p class="proj-q">${esc(p.quote)}</p>
      <p class="proj-p">${rich(p.blurb)}</p>
      <div class="proj-nums">
        <div class="proj-row"><span class="proj-lab">Subtotal</span><span class="proj-val">${esc(p.subtotal)}</span></div>
        <div class="proj-row"><span class="proj-lab">HST 13%</span><span class="proj-val">${esc(p.hst)}</span></div>
        <div class="proj-row tot"><span class="proj-lab">Standalone total</span><span class="proj-val">${esc(p.total)}</span></div>
      </div>
    </div>`
  ).join("\n");
  return `<section class="sec wrap" id="projects">
  <h2 class="sec-h">${esc(projects.heading)}</h2>
  <p class="sec-lead">${rich(projects.lead)}</p>

  <div class="projs">
${cards}
  </div>
</section>`;
}

// One standalone option card (A / B): price + View / Download actions.
function renderOptionCard(o) {
  const view = o.viewHref
    ? `\n          <a class="opt-view" href="${esc(o.viewHref)}"${o.viewNewTab ? ' target="_blank" rel="noopener"' : ""}>${rich(o.viewLabel)}</a>` : "";
  const dl = o.dlHref
    ? `\n          <a class="opt-dl" href="${esc(o.dlHref)}"${o.dlDownload ? ` download="${esc(o.dlDownload)}"` : ""}${o.dlNewTab ? ' target="_blank" rel="noopener"' : ""}>${rich(o.dlLabel)}</a>` : "";
  const actions = (view || dl) ? `\n        <div class="opt-actions">${view}${dl}\n        </div>` : "";
  return `      <div class="opt">
        <p class="opt-tag">${esc(o.tag)}</p>
        <h3 class="opt-h">${esc(o.name)}</h3>
        <p class="opt-sub">${esc(o.sub)}</p>
        <p class="opt-price">${esc(o.price)}</p>
        <p class="opt-price-note">${esc(o.priceNote)}</p>${actions}
      </div>`;
}

function renderCombinedTotalsRows(rows) {
  return (rows || []).map((r) => {
    const trClass = r.kind === "sub" ? ' class="row-sub"'
      : r.kind === "disc" ? ' class="row-disc"'
      : r.kind === "total" ? ' class="row-total"' : "";
    const labDim = r.dim ? " r-dim" : "";
    const numDim = r.dim ? " r-dim" : "";
    const sm = r.sm ? `<span class="sm">${esc(r.sm)}</span>` : "";
    return `            <tr${trClass}>
              <td class="r-lab${labDim}">${esc(r.lab)}${sm}</td>
              <td class="r-num${numDim}">${esc(r.num)}</td>
            </tr>`;
  }).join("\n");
}

function renderCombinedOptions(options, paymentHtml) {
  const best = options.c;
  const badge = best.badge ? `\n        <span class="opt-badge">${rich(best.badge)}</span>` : "";
  return `<section class="sec pricing" id="pricing">
  <div class="wrap">
    <h2 class="sec-h">${esc(options.heading)}</h2>
    <p class="sec-lead">${rich(options.lead)}</p>

    <div class="opts">
${renderOptionCard(options.a)}
${renderOptionCard(options.b)}
      <div class="opt best">
        <p class="opt-tag">${esc(best.tag)}</p>
        <h3 class="opt-h">${esc(best.name)}</h3>
        <p class="opt-sub">${esc(best.sub)}</p>
        <p class="opt-price">${esc(best.price)}</p>
        <p class="opt-price-note">${esc(best.priceNote)}</p>${badge}
      </div>
    </div>

    <div class="totals">
      <div class="totals-in">
        <table>
          <tbody>
${renderCombinedTotalsRows(options.totals)}
          </tbody>
        </table>
      </div>
    </div>

    <p class="save-note">${rich(options.saveNote)}</p>

${paymentHtml}

    <div class="clause">
    ${rich(options.clause)}
    </div>
  </div>
</section>`;
}

// Combined payment: a deposit/balance pair (reuses renderPayment) or, when
// there's no deposit, a single full-width "Total due" panel.
function renderCombinedPayment(payment) {
  if (payment && payment.mode === "deposit" && payment.deposit) return renderPayment(payment);
  const t = (payment && payment.totalDue) || {};
  return `  <div class="pay pay-single">
    <div class="pay-col now">
      <p class="pay-k">${esc(t.label || "Total due")}</p>
      <p class="pay-v">${esc(t.amount || "")}</p>
      <p class="pay-when">${esc(t.when || "Due on completion")}</p>
      <p class="pay-p">${rich(t.body || "")}</p>
    </div>
  </div>`;
}

function renderCombinedClose(close) {
  return `<section class="close wrap">
  <div class="signoff-mark"><img src="${LOGO_WHITE}" alt="PJL Land Services"></div>
  <h2>${esc(close.heading)}</h2>
  <p>${rich(close.body)}</p>
  <p class="sig">${rich(close.sig)}</p>
</section>`;
}

function renderCombinedProposal(data) {
  const meta = data.meta || {};
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(meta.title || "Combined Proposal — PJL Land Services")}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Barlow:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
${COMBINED_CSS}
</style>
</head>
<body>

${renderCombinedHero(data.hero || {}, meta)}

${renderCombinedProjects(data.projects || {})}

${renderCombinedOptions(data.options || {}, renderCombinedPayment(data.payment || {}))}

${renderCombinedClose(data.close || {})}

</body>
</html>`;
}

// ======================================================================
// Smart Controller Upgrade ("off the timer, onto the forecast") — light
// theme selling piece for a Hydrawise HCC upgrade. Reuses the sprinkler
// theme CSS plus a few selling-piece touches (savings stat, hardware
// showcase, credibility). Its four hardware photos are DESIGN-LEVEL shared
// assets (same on every HCC proposal until Patrick swaps one), passed in as
// data.photos[slot] data URIs; an empty slot renders a labeled placeholder.
// ======================================================================

const SMART_CTRL_CSS = `
  .stat { background:var(--green); color:#fff; border-radius:16px; padding:clamp(32px,5vw,54px); margin:0 0 8px; text-align:center; }
  .stat .stat-big { font-family:var(--disp); font-weight:700; font-size:clamp(56px,11vw,104px); line-height:.95; color:#F4CE8E; }
  .stat .stat-big span { font-size:.34em; letter-spacing:.02em; }
  .stat .stat-k { font-family:var(--mono); font-size:12px; letter-spacing:.16em; text-transform:uppercase; opacity:.85; margin:0 0 10px; }
  .stat .stat-sub { font-size:clamp(16px,2vw,20px); max-width:44ch; margin:16px auto 0; opacity:.95; line-height:1.55; }
  .cred { display:flex; gap:14px; align-items:flex-start; padding:22px 24px; border:1px solid #e5e5dd; border-radius:12px; background:#fff; margin-top:18px; }
  .cred .cred-badge { font-family:var(--mono); font-size:11px; letter-spacing:.1em; text-transform:uppercase; color:var(--green); font-weight:600; white-space:nowrap; padding-top:2px; }
  .cred p { margin:0; font-size:15px; line-height:1.6; color:#1a1a1a; }
  .hw { display:grid; grid-template-columns:1fr 1fr; gap:20px; }
  .hw-h { font-family:var(--disp); font-weight:600; text-transform:uppercase; letter-spacing:.02em; font-size:20px; color:var(--green); margin:0 0 6px; }
  .hw-p { margin:0; font-size:14.5px; line-height:1.6; color:#3a3a3a; }
  .hw-photo { border-radius:12px; overflow:hidden; margin-bottom:14px; aspect-ratio:16/10; background:#eef1ea; }
  .hw-photo img { width:100%; height:100%; object-fit:cover; display:block; }
  .ph-slot { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:8px; background:repeating-linear-gradient(45deg,#eef1ea,#eef1ea 12px,#e7ebe3 12px,#e7ebe3 24px); border:1.5px dashed #b9c3ad; border-radius:12px; aspect-ratio:16/10; margin-bottom:14px; color:#6b7a5e; font-family:var(--mono); font-size:12px; letter-spacing:.06em; text-transform:uppercase; text-align:center; padding:16px; }
  .ph-slot .ph-cam { font-size:26px; }
  @media(max-width:720px){ .hw{ grid-template-columns:1fr; } }
`;

// One hardware photo cell: the uploaded image, or a labeled placeholder
// naming which shot goes there (so an un-loaded slot reads as intentional).
function scPhotoCell(photos, slot, label) {
  const uri = photos && photos[slot];
  if (uri) return `<div class="hw-photo"><img src="${uri}" alt="${esc(label)}"></div>`;
  return `<div class="ph-slot"><span class="ph-cam" aria-hidden="true">▢</span><span>${esc(label)}</span></div>`;
}

function renderSmartControllerProposal(data) {
  const meta = data.meta || {};
  const hero = data.hero || {};
  const why = data.why || {};
  const hw = data.hardware || {};
  const inc = data.included || {};
  const sav = data.savings || {};
  const inv = data.investment || {};
  const close = data.close || {};
  const photos = data.photos || {};

  const facts = (hero.facts || []).map((f) =>
    `      <div class="fact"><span class="fact-k">${esc(f.k)}</span><span class="fact-v">${esc(f.v)}</span></div>`).join("\n");
  const whyCards = (why.cards || []).map((c) =>
    `    <li class="pr"><h3 class="pr-h">${esc(c.title)}</h3><p class="pr-p">${rich(c.body)}</p></li>`).join("\n");
  const hwCards = (hw.items || []).map((it) =>
    `    <div class="hw-card">${scPhotoCell(photos, it.slot, it.title)}<h3 class="hw-h">${esc(it.title)}</h3><p class="hw-p">${rich(it.body)}</p></div>`).join("\n");
  const incIn = (inc.includes || []).map((s) => `        <li>${rich(s)}</li>`).join("\n");
  const incOut = (inc.excludes || []).map((s) => `        <li>${rich(s)}</li>`).join("\n");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(meta.title || "Smart Controller Upgrade — PJL Land Services")}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=Barlow:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
${SPRINKLER_CSS}
${SMART_CTRL_CSS}
</style>
</head>
<body>

<div class="mark"><img src="${LOGO_WHITE}" alt="PJL Land Services"></div>

<header class="hero"${heroPhotoStyle(photos.hero)}>
  <div class="hero-in wrap">
    <p class="eyebrow">${esc(meta.docKicker)}</p>
    <h1>${esc(hero.h1Lead)}<br><em>${esc(hero.h1Accent)}</em></h1>
    <p class="hero-sub">${rich(hero.sub)}</p>
    <div class="facts">
${facts}
    </div>
  </div>
</header>

<section class="sec wrap">
  <h2 class="sec-h">${esc(why.heading)}</h2>
  <p class="sec-lead">${rich(why.lead)}</p>
  <ul class="prs">
${whyCards}
  </ul>
</section>

<section class="sec wrap">
  <h2 class="sec-h">${esc(hw.heading)}</h2>
  <p class="sec-lead">${rich(hw.lead)}</p>
  <div class="hw">
${hwCards}
  </div>
</section>

<section class="sec wrap">
  <h2 class="sec-h">${esc(inc.heading)}</h2>
  <p class="sec-lead">${rich(inc.lead)}</p>
  <div class="scope">
    <div class="scope-col in"><h3 class="scope-h in">${esc(inc.inHeading || "Included")}</h3><ul>
${incIn}
    </ul></div>
    <div class="scope-col out"><h3 class="scope-h out">${esc(inc.outHeading || "Good to know")}</h3><ul>
${incOut}
    </ul></div>
  </div>
</section>

<section class="sec wrap">
  <div class="stat">
    <p class="stat-k">${rich(sav.kicker)}</p>
    <div class="stat-big">${esc(sav.big)}<span>${esc(sav.unit)}</span></div>
    <p class="stat-sub">${rich(sav.sub)}</p>
  </div>
</section>

<section class="sec wrap">
  <h2 class="sec-h">${esc(inv.heading)}</h2>
  <div class="pay">
    <div class="pay-col now">
      <p class="pay-k">${esc(inv.priceLabel)}</p>
      <p class="pay-v">${esc(inv.price)}</p>
      <p class="pay-when">${esc(inv.priceNote)}</p>
      <p class="pay-p">${rich(inv.priceBody)}</p>
    </div>
    <div class="pay-col">
      <p class="pay-k">${esc(inv.warrantyLabel)}</p>
      <p class="pay-v" style="font-size:clamp(26px,4vw,38px)">${esc(inv.warrantyValue)}</p>
      <p class="pay-when">${esc(inv.warrantyWhen)}</p>
      <p class="pay-p">${rich(inv.warrantyBody)}</p>
    </div>
  </div>
  <div class="cred"><span class="cred-badge">${esc(inv.credBadge)}</span><p>${rich(inv.credBody)}</p></div>
</section>

<section class="close">
  <div class="wrap">
  <div class="signoff-mark"><img src="${LOGO_WHITE}" alt="PJL Land Services"></div>
  <h2>${esc(close.heading)}</h2>
  <p>${rich(close.body)}</p>
  <p class="sig">${rich(close.sig)}</p>
  </div>
</section>

</body>
</html>`;
}

module.exports = { renderSprinklerProposal, renderLightingProposal, renderCombinedProposal, renderSmartControllerProposal, esc };
