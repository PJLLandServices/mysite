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
const LOGO_WHITE = fs.readFileSync(path.join(ASSETS_DIR, "logo-white.datauri.txt"), "utf8").trim();

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
      <h3 class="scope-h in">Included</h3>
      <ul>
${inc}
      </ul>
    </div>
    <div class="scope-col out">
      <h3 class="scope-h out">Not included</h3>
      <ul>
${exc}
      </ul>
    </div>
  </div>
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

${renderTerms(data.terms || {})}

${renderClose(data.close || {})}

</body>
</html>`;
}

module.exports = { renderSprinklerProposal, esc };
