// Quote → proposal-data adapter (Proposal HTML brief, 2026-07).
//
// The bridge between a live quote record and the pure HTML generator
// (proposal-html.js). It fills every DYNAMIC value from the quote —
// customer, quote #, property address, dates, line items → schedule rows,
// subtotal/HST/total, and the deposit/balance split — then merges the
// token-resolved copy from the per-service template (proposal-templates.js)
// for the written narrative. Nothing here reaches the network or the quote
// store; the server hands in the already-resolved parties + hero photo.
//
// Design note on the schedule table: the sprinkler artifact deliberately
// shows a Qty-only breakdown with a single lump subtotal (no per-line
// prices) — so rows come straight from the quote's line items (which IS the
// quotation), and the single subtotal/HST/total come from the quote record.
// A `summary` pricing mode (or a line-item-less quote) collapses to one
// "complete system, installed" row, matching how the PDF hides the table in
// that mode.

const fs = require("node:fs");
const path = require("node:path");
const templates = require("./proposal-templates");
const company = require("./company");

const HST_RATE = 0.13;

// pricing.json holds the current-year seasonal rates — same repo-root file +
// deploy-time freshness contract as quote-narratives.js (a price edit ships
// via git push → Render restart). Loaded once per process.
const PRICING = (() => {
  try { return JSON.parse(fs.readFileSync(path.resolve(__dirname, "..", "..", "pricing.json"), "utf8")); }
  catch { return {}; }
})();

// Pricing disclaimer shown under the schedule table. Guaranteed on EVERY
// generated proposal (Patrick, Jul 2026): the per-zone breakdown is shown
// for transparency, but nothing on it is a stand-alone price — this closes
// the door on a customer cherry-picking a line to argue for an à-la-carte
// discount. A template may override it via schedule.countNote; this is the
// floor so the protection can never be forgotten.
const DEFAULT_PRICING_NOTE =
  "Each line above is shown for transparency — but every item is priced only as part of the <b>complete system</b>, never as a stand-alone line. The work is quoted and installed as one integrated build, so no individual item can be removed, swapped, or discounted on its own; any change to the scope re-prices the whole system.";

// ---- formatting -------------------------------------------------------

function fmtMoney(n) {
  const v = Number(n) || 0;
  return "$" + v.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// Money for inline prose: drops the ".00" on whole-dollar amounts ($1,000),
// keeps cents otherwise ($1,000.50). Tables/totals still use fmtMoney.
function fmtMoneyCompact(n) {
  const v = Number(n) || 0;
  if (Number.isInteger(v)) return "$" + v.toLocaleString("en-US");
  return fmtMoney(v);
}

const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];

// "July 12, 2026" from an ISO string. Parses the date parts directly so the
// result doesn't shift across the server's timezone (a quote issued late in
// the day shouldn't render as the day before).
function fmtDate(iso) {
  if (!iso) return "";
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) {
    const [, y, mo, d] = m;
    const month = MONTHS[Number(mo) - 1] || "";
    return `${month} ${Number(d)}, ${y}`;
  }
  const dt = new Date(iso);
  if (Number.isNaN(dt.getTime())) return "";
  return `${MONTHS[dt.getMonth()]} ${dt.getDate()}, ${dt.getFullYear()}`;
}

// Two-digit zero-pad for the hero facts (matches the reference "07").
function pad2(n) {
  const v = Number(n);
  return Number.isFinite(v) ? String(v).padStart(2, "0") : String(n);
}

// ---- quote-derived pieces --------------------------------------------

// The display number shown to the customer: the manual override when set,
// else the internal id with a version tag (v2, v3…) for revisions.
function displayNumber(quote) {
  const versionTag = (Number(quote.version) || 1) > 1 ? ` · v${quote.version}` : "";
  const override = quote.quoteNumberDisplay && String(quote.quoteNumberDisplay).trim();
  return override ? String(quote.quoteNumberDisplay).trim() : `${quote.id}${versionTag}`;
}

// Glyph accents cycle so consecutive rows read differently, echoing the
// reference's large / medium / ring / small rhythm.
const GLYPH_CYCLE = ["large", "medium", "ring", "small"];
function glyphForIndex(i) {
  return GLYPH_CYCLE[Math.min(i, GLYPH_CYCLE.length - 1)] || "small";
}

// A line item's Qty cell: the quantity plus a de-prefixed, display-friendly
// unit ("per_ft" → "ft", "per_zone" → "zones"). "each"/"flat"/"unit" carry
// no meaning as a count label, so those show the bare number ("1"). Count
// units pluralize when qty ≠ 1 ("3 zones", "1 zone"). Mirrors quote-pdf's
// per_ prefix handling but tuned for the customer-facing schedule.
const QTY_UNIT_NOISE = new Set(["each", "flat", "unit", "ea", "lump", "lot", ""]);
const QTY_UNIT_PLURAL = /^(zone|tree|head|hour|day|valve|controller|rotor|light|fixture)$/i;
function qtyText(li) {
  const n = Number(li.qty);
  const q = Number.isFinite(n) ? String(n) : String(li.qty || "");
  let unit = li.unit ? String(li.unit).replace(/^per_/, "").trim() : "";
  if (QTY_UNIT_NOISE.has(unit.toLowerCase())) return q;
  if (Number.isFinite(n) && n !== 1 && QTY_UNIT_PLURAL.test(unit)) unit += "s";
  return `${q} ${unit}`;
}

// Build the schedule rows from the quote's line items. `summary` mode (or a
// quote with no line items) collapses to a single installed-system row so
// the table still reads as a deliverable without exposing a breakdown.
function scheduleRows(quote) {
  const items = Array.isArray(quote.lineItems) ? quote.lineItems : [];
  const mode = quote.pdfOptions && quote.pdfOptions.lineItems;
  if (mode === "summary" || items.length === 0) {
    return [{ glyph: "large", cls: "Complete system", detail: "Designed, supplied & installed", qty: "1" }];
  }
  return items.map((li, i) => ({
    glyph: glyphForIndex(i),
    cls: li.label || li.sourceKey || "Line item",
    detail: li.description ? String(li.description) : "",
    qty: qtyText(li)
  }));
}

// Totals — read the frozen quote figures, falling back to a fresh compute
// for legacy records that pre-date stored totals (mirrors quote-pdf.js).
function totals(quote) {
  const subtotal = Number(quote.subtotal) || 0;
  const hst = Number(quote.hst) || Math.round(subtotal * HST_RATE * 100) / 100;
  const total = Number(quote.total) || Math.round((subtotal + hst) * 100) / 100;
  return { subtotal, hst, total };
}

// Payment block — deposit/balance split when the quote carries an enabled
// deposit, else the total-due + warranty pair. Amounts come from the quote
// record; the surrounding prose comes from the (token-resolved) template.
function payment(quote, t, grandTotal) {
  const dep = quote.deposit;
  if (dep && dep.enabled === true) {
    const valueBit = dep.type === "fixed"
      ? fmtMoney(Number(dep.value) || 0)
      : `${Number(dep.value) || 0}%`;
    const when = `${valueBit} · ${dep.dueLabel || "due at scheduling"}`;
    const depCopy = (t.payment && t.payment.deposit) || {};
    const balCopy = (t.payment && t.payment.balance) || {};
    return {
      mode: "deposit",
      deposit: {
        label: depCopy.label || "Deposit to schedule",
        amount: fmtMoney(dep.amount),
        when,
        body: depCopy.body || ""
      },
      balance: {
        label: balCopy.label || "Balance",
        amount: fmtMoney(dep.balance),
        when: balCopy.when || dep.balanceLabel || "Due on completion",
        body: balCopy.body || ""
      }
    };
  }
  const totalDue = (t.payment && t.payment.totalDue) || {};
  const warranty = (t.payment && t.payment.warranty) || {};
  return {
    mode: "total-due",
    totalDue: {
      label: totalDue.label || "Total due",
      amount: fmtMoney(grandTotal),
      when: totalDue.when || "Due on completion",
      body: totalDue.body || ""
    },
    warranty: {
      label: warranty.label || "Warranty",
      value: warranty.value || "3 years",
      valueSmall: warranty.valueSmall !== false,
      when: warranty.when || "Workmanship, from substantial completion",
      body: warranty.body || ""
    }
  };
}

// ---- seasonal service (spring opening + fall closing) ----------------

// Count the zones a proposal installs, from its line items: catalog zone
// picks contribute their qty (rotor / pop-up / drip), and Site-Builder
// "Zone N — <area>" lines contribute one each. 0 when none are identifiable
// (→ the seasonal block is skipped rather than guessing a tier).
const ZONE_SOURCE_KEYS = new Set(["rotor_zone_per_zone", "popup_spray_zone_per_zone", "drip_zone_per_zone"]);
function countZones(quote) {
  let n = 0;
  for (const li of (Array.isArray(quote.lineItems) ? quote.lineItems : [])) {
    if (ZONE_SOURCE_KEYS.has(li.sourceKey)) n += Number(li.qty) || 0;
    else if (/^zone\s+\d+/i.test(li.label || "")) n += 1;
  }
  return n;
}

// The residential seasonal tier for a zone count, from pricing.json's
// canonical seasonal_tiers table (spring opening + fall closing share one
// price per tier). Ranges look like "1-4", "5-6", "16+". Returns the tier
// object ({ price, custom? }) or null when it can't be resolved.
function seasonalTier(zoneCount) {
  const tiers = PRICING.seasonal_tiers && PRICING.seasonal_tiers.residential;
  if (!Array.isArray(tiers) || !(zoneCount > 0)) return null;
  for (const t of tiers) {
    const band = String(t.zones).match(/^(\d+)-(\d+)$/);
    const open = String(t.zones).match(/^(\d+)\+$/);
    if (band && zoneCount >= +band[1] && zoneCount <= +band[2]) return t;
    if (open && zoneCount >= +open[1]) return t;
  }
  return null;
}

// The "seasonal care" block — current-year spring/fall rates for this
// system's zone count. Rendered only when the template opts in (t.seasonal)
// AND a zone count is known. The top residential tier (16+) is a custom
// quote (price 0) → shown as "By quote" rather than "$0".
function buildSeasonal(t, zones) {
  if (!t.seasonal || !(zones > 0)) return null;
  const tier = seasonalTier(zones);
  if (!tier) return null;
  const custom = !!tier.custom || !(Number(tier.price) > 0);
  const value = custom ? "By quote" : fmtMoney(tier.price);
  return {
    heading: t.seasonal.heading || "Keeping it running",
    lead: t.seasonal.lead || "",
    zones,
    custom,
    spring: { label: "Spring opening", value, when: "per spring visit", body: t.seasonal.springBody || "" },
    fall: { label: "Fall closing", value, when: "per fall visit", body: t.seasonal.fallBody || "" },
    note: t.seasonal.note || ""
  };
}

// ---- system features (drive conditional narrative) -------------------

// Derive which components a system actually has, from its line items, so the
// copy never claims something the job doesn't include — a flow meter that
// wasn't selected, or drip on a no-drip system. All detection keys off the
// wording the Site Builder stamps into each line. "water meter" never trips
// the flow test (needs "flow" before meter/sensor).
function systemFeatures(quote) {
  const text = (Array.isArray(quote.lineItems) ? quote.lineItems : [])
    .map((li) => `${li.label || ""} ${li.description || ""}`).join(" ").toLowerCase();
  const spray = /spray/.test(text);        // Pop-up spray  — Pro-Spray PRS body
  const mp = /rotator/.test(text);          // MP Rotator    — Pro-Spray PRS body ("Rotator", not "Rotary")
  const strip = /strip/.test(text);         // Strip nozzle  — Pro-Spray PRS body
  const gearRotor = /rotary/.test(text);    // Gear rotor (PGP) — NOT pressure-regulated at the head
  const drip = /drip|root[\s-]?zone/.test(text);
  return {
    flowMeter: /flow[\s-]?(meter|sensor)/.test(text),
    drip, spray, mp, strip, gearRotor,
    // Heads that regulate pressure AT the head (30 PSI): spray / MP / strip.
    prsHeads: spray || mp || strip,
    heads: spray || mp || strip || gearRotor
  };
}

// Assemble the scope "included" list: the base items always, plus the
// flow-meter items only when the system has one — inserted right after the
// controller line so it reads naturally (falls back to appending).
function scopeIncludes(scopeTemplate, flow) {
  const base = Array.isArray(scopeTemplate.includes) ? [...scopeTemplate.includes] : [];
  const extra = flow && Array.isArray(scopeTemplate.includesFlowMeter) ? scopeTemplate.includesFlowMeter : [];
  if (!extra.length) return base;
  const at = base.findIndex((x) => /controller/i.test(x));
  return at === -1 ? [...base, ...extra] : [...base.slice(0, at + 1), ...extra, ...base.slice(at + 1)];
}

// The "how the system works" cards: the always-on cards from the template,
// plus ONE water-delivery card built to match what's actually installed —
// pressure-regulated heads (turf) and/or drip (beds). Inserted before the
// closing card so the delivery message sits in the middle. No drip mention on
// a no-drip job; pressure regulation advertised whenever there are heads.
function buildSystemCards(system, f) {
  const cards = Array.isArray(system.cards) ? [...system.cards] : [];
  const del = system.delivery;
  if (del) {
    const parts = [];
    if (f.prsHeads) parts.push(del.spraySentence);                         // 30 PSI at the head
    if (f.drip) parts.push(del.dripSentence);                              // drip pressure regulator
    if (!f.prsHeads && !f.drip && f.gearRotor) parts.push(del.rotorSentence); // gear-rotor-only fallback
    if (parts.length) {
      const title = (f.prsHeads && f.drip) ? del.titleBoth
        : f.prsHeads ? del.titleSpray
        : f.drip ? del.titleDrip
        : del.titleRotor;
      cards.splice(Math.max(0, cards.length - 1), 0, { title, body: parts.filter(Boolean).join(" ") });
    }
  }
  return cards;
}

// ---- lighting (dark theme) -------------------------------------------

// A line item is a transformer (power supply), not a light fixture, when its
// label/description names a transformer or an In-Lite HUB model.
function isTransformerLine(li) {
  const t = `${li.label || ""} ${li.description || ""}`.toLowerCase();
  return /transformer|\bhub[\s-]?\d+/.test(t);
}

// Transformer count + model for the "how it works" card and scope line.
// In-Lite jobs run on one or more low-voltage transformers (HUB-100 is the
// standard 120V unit). Read them off the quote when itemized — count = summed
// qty, model = the HUB code named — otherwise default to a single HUB-100
// (the common residential case). This keeps a one-transformer job from
// claiming "two transformers on each side" the way the old static copy did.
function transformerSpec(quote) {
  const lines = (Array.isArray(quote.lineItems) ? quote.lineItems : []).filter(isTransformerLine);
  let count = lines.reduce((n, li) => n + (Number(li.qty) || 0), 0);
  let model = null;
  for (const li of lines) {
    const m = `${li.label || ""} ${li.description || ""}`.match(/hub[\s-]?(\d+)/i);
    if (m) { model = `HUB-${m[1]}`; break; }
  }
  if (!lines.length || count < 1) count = 1;   // default: a single transformer
  if (!model) model = "HUB-100";               // In-Lite's standard 120V unit
  return { count, model, hasLine: lines.length > 0 };
}

const COUNT_WORDS = ["Zero", "One", "Two", "Three", "Four", "Five", "Six", "Seven", "Eight"];
function countWord(n) { return COUNT_WORDS[n] || String(n); }

// Total fixtures across the schedule (sum of line quantities) — transformers
// are power supplies, not fixtures, so they don't count toward the total.
function fixtureCount(quote) {
  return (Array.isArray(quote.lineItems) ? quote.lineItems : [])
    .filter((li) => !isTransformerLine(li))
    .reduce((n, li) => n + (Number(li.qty) || 0), 0);
}

// The fixture count to SHOW: an explicit proposalFixtureCount override (set
// when the job is quoted as one all-inclusive line) wins; otherwise the summed
// line-item Qtys. Used by both the standalone lighting page and the combined
// proposal's project blurb so the two never disagree.
function effectiveFixtureCount(quote) {
  const override = Number(quote && quote.proposalFixtureCount);
  return Number.isFinite(override) && override > 0 ? override : fixtureCount(quote);
}

// Fixture-schedule rows for a lighting proposal: Class · In-Lite fixture ·
// Qty · Each · Line. The line's label is the class (Large/Medium/Small/
// Recessed — also the glyph), its description is the In-Lite fixture code.
function lightingRows(quote) {
  return (Array.isArray(quote.lineItems) ? quote.lineItems : []).map((li) => {
    const qty = Number(li.qty) || 0;
    const price = Number(li.price) || 0;
    const line = li.lineTotal != null ? Number(li.lineTotal) : price * qty;
    return {
      glyph: li.label || "",
      cls: li.label || "Fixture",
      fixture: li.description || "",
      qty: String(qty),
      each: fmtMoney(price),
      line: fmtMoney(line)
    };
  });
}

// Assemble the lighting proposal data. Shares customer/totals/deposit/scope
// with the sprinkler path; differs in the fixture schedule (Each/Line), the
// hero facts (Fixtures instead of Zones), and the CTA close. The 7 rendered
// "views" are attached later (Phase B) as data.views.
function buildLightingData(quote, t, ctx, common) {
  const { customer, displayId, issued, subtotal, hst, total, sig } = common;
  // Fixture count: an explicit override (set when the fixtures are quoted as
  // one all-inclusive package line) wins; otherwise sum the line-item Qtys.
  const fixtures = effectiveFixtureCount(quote);
  const tx = common.transformer || transformerSpec(quote);
  const many = tx.count >= 2;
  const facts = [
    { k: "Prepared for", v: customer.name || "Customer" },
    { k: "Fixtures", v: fixtures ? String(fixtures) : "—" },
    { k: "Quote", v: displayId },
    { k: "Date", v: issued || "—" }
  ];

  // How-it-works cards: the always-on cards from the template plus ONE
  // transformer card matched to the job (single HUB vs split-across-sides).
  const cards = Array.isArray(t.system && t.system.cards) ? [...t.system.cards] : [];
  const txCard = t.system && t.system.transformerCard;
  if (txCard) {
    const chosen = many ? txCard.many : txCard.one;
    if (chosen && chosen.title) cards.push({ title: chosen.title, body: chosen.body });
  }

  // Scope "included": insert the transformer line (one vs many) right after
  // the cable/connector line so it reads in install order.
  const includes = (t.scope && Array.isArray(t.scope.includes)) ? [...t.scope.includes] : [];
  const txLine = t.scope && t.scope.transformerLine;
  if (txLine) {
    const line = many ? txLine.many : txLine.one;
    if (line) {
      const at = includes.findIndex((x) => /cable|connector/i.test(x));
      if (at === -1) includes.push(line); else includes.splice(at + 1, 0, line);
    }
  }
  return {
    theme: "lighting",
    meta: {
      title: t.title || "Landscape Lighting Proposal — PJL Land Services",
      docKicker: `${t.kicker || "Landscape Lighting Design"}  ·  ${displayId}`
    },
    hero: {
      h1Lead: (t.hero && t.hero.h1Lead) || "The property,",
      h1Accent: (t.hero && t.hero.h1Accent) || "after dark",
      sub: (t.hero && t.hero.sub) || "",
      facts,
      bgPhoto: common.heroPhoto || null
    },
    system: {
      heading: (t.system && t.system.heading) || "How a low-voltage system works",
      lead: (t.system && t.system.lead) || "",
      cards
    },
    views: [],
    schedule: {
      heading: (t.schedule && t.schedule.heading) || "Project fixture schedule",
      lead: (t.schedule && t.schedule.lead) || "",
      rows: lightingRows(quote),
      subtotalLabel: `${(t.schedule && t.schedule.subtotalLabel) || "Subtotal"}  —  ${fixtures} fixture${fixtures === 1 ? "" : "s"}`,
      subtotal: fmtMoney(subtotal),
      hst: fmtMoney(hst),
      total: fmtMoney(total),
      countNote: (t.schedule && t.schedule.countNote) || ""
    },
    payment: payment(quote, t, total),
    scope: {
      heading: (t.scope && t.scope.heading) || "What the price covers",
      lead: (t.scope && t.scope.lead) || "",
      inHeading: (t.scope && t.scope.inHeading) || "What the price includes",
      outHeading: (t.scope && t.scope.outHeading) || "What it doesn't",
      includes,
      excludes: (t.scope && t.scope.excludes) || []
    },
    terms: t.terms || { heading: "The fine print", clauses: [] },
    close: {
      heading: (t.close && t.close.heading) || "Ready when you are",
      body: (t.close && t.close.body) || "",
      ctaLabel: (t.close && t.close.ctaLabel) || "",
      ctaHref: (t.close && t.close.ctaHref) || "",
      sig: `${company.CITY} &nbsp;·&nbsp; ${company.PHONE} &nbsp;·&nbsp; <b>${company.WEBSITE}</b>`
    }
  };
}

// ---- combined (two projects, one property) ---------------------------

// Just the street line for the compact hero "Property" fact / eyebrow.
function shortAddress(addr) {
  return String(addr || "").split(",")[0].trim() || "your property";
}

// Summarise ONE child quote for the combined page: its theme, a friendly
// name + glyph, a one-line blurb derived from the design, and its standalone
// totals. `child` is { quote, token, pdfDataUrl, pdfName } from the endpoint.
function combinedChildMeta(child) {
  const q = child.quote || {};
  const theme = q.proposalTemplateKey === "lighting" ? "lighting" : "sprinkler";
  const { subtotal, hst, total } = totals(q);
  let name, optName, optSub, glyph, blurb;
  if (theme === "lighting") {
    const fixtures = effectiveFixtureCount(q);
    name = "Landscape Lighting"; optName = "Lighting only"; optSub = "Lighting design, standalone"; glyph = "medium";
    const fTxt = fixtures ? `${fixtures} fixture${fixtures === 1 ? "" : "s"}` : "a full set of fixtures";
    blurb = `Low-voltage In-Lite lighting design — ${fTxt} across the property, sealed and expandable, built to live outside.`;
  } else {
    const zones = countZones(q);
    name = "Lawn Sprinkler System"; optName = "Sprinklers only"; optSub = "Irrigation system, standalone"; glyph = "small";
    const zTxt = zones ? `${zones} zone${zones === 1 ? "" : "s"}` : "a complete zone layout";
    blurb = `New irrigation system — ${zTxt} on a smart controller with weather-based scheduling.`;
  }
  return {
    id: q.id, theme, name, optName, optSub, glyph, blurb,
    displayId: displayNumber(q),
    subtotal: fmtMoney(subtotal), hst: fmtMoney(hst), total: fmtMoney(total),
    subtotalNum: subtotal,
    token: child.token || null,
    pdfDataUrl: child.pdfDataUrl || null,
    pdfName: child.pdfName || `${q.id}.pdf`
  };
}

// View / Download links for one option card, per the combined offer's link
// mode. "embed" points both at the child's PDF baked into the page as a
// data: URI; "link" (default) points at the child's standalone /approve page
// and its customer-side PDF endpoint (token-scoped when the child was sent).
function combinedChildHrefs(c, linkMode) {
  if (linkMode === "embed" && c.pdfDataUrl) {
    return { viewHref: c.pdfDataUrl, viewNewTab: true, dlHref: c.pdfDataUrl, dlDownload: c.pdfName };
  }
  const view = c.token
    ? `/approve/${encodeURIComponent(c.id)}?t=${encodeURIComponent(c.token)}`
    : `/approve/${encodeURIComponent(c.id)}`;
  const dl = c.token
    ? `/api/approve/${encodeURIComponent(c.id)}/${encodeURIComponent(c.token)}/pdf`
    : view;
  return { viewHref: view, viewNewTab: true, dlHref: dl, dlNewTab: true };
}

// Assemble the combined proposal data by MERGING two child quotes plus the
// bundle terms held on quote.combined. All dynamic prose (options lead,
// save-note, offer clause) is composed here from the figures so the copy
// always matches the actual saving / free service / validity.
function buildCombinedData(quote, t, ctx, common) {
  const { issued, sig } = common;
  const cfg = quote.combined || {};
  const address = common.address || "";
  const children = (Array.isArray(common.children) ? common.children : []).map(combinedChildMeta);
  // Sprinkler(s) first, lighting second — matches the reference ordering.
  children.sort((a, b) => (a.theme === "lighting" ? 1 : 0) - (b.theme === "lighting" ? 1 : 0));
  const [p1, p2] = children;

  const saving = Math.max(0, Number(cfg.bundleSaving) || 0);
  const freeService = String(cfg.freeService || "").trim();
  // Deposit: honour an explicit 0 as "no deposit". Only an absent/invalid
  // value falls back to the 25% default.
  const rawDeposit = Number(cfg.depositPercent);
  const depositPercent = Number.isFinite(rawDeposit) && rawDeposit >= 0 ? Math.min(100, rawDeposit) : 25;
  const hasDeposit = depositPercent > 0;
  const linkMode = cfg.linkMode === "embed" ? "embed" : "link";
  const validThrough = fmtDate(quote.validUntil || quote.validUntilDate) || "the date shown";

  const combinedSubtotal = children.reduce((n, c) => n + c.subtotalNum, 0);
  const discountedSubtotal = Math.max(0, combinedSubtotal - saving);
  const hst = +(discountedSubtotal * HST_RATE).toFixed(2);
  const total = +(discountedSubtotal + hst).toFixed(2);
  const deposit = +(total * depositPercent / 100).toFixed(2);
  const balance = +(total - deposit).toFixed(2);

  // Options lead — the pitch line under "Your options".
  let lead = "Take either project on its own — or do both together";
  const leadBits = [];
  if (saving > 0) leadBits.push(`save ${fmtMoneyCompact(saving)} off the combined price`);
  if (freeService) leadBits.push(`get your ${freeService} included at no charge`);
  lead += leadBits.length ? `, ${leadBits.join(", and ")}.` : " at the combined rate.";

  // Best-value badge.
  const badgeBits = [];
  if (saving > 0) badgeBits.push(`Save ${fmtMoneyCompact(saving)}`);
  if (freeService) badgeBits.push(`${saving > 0 ? "free " : "Free "}${freeService}`);
  const badge = badgeBits.length ? badgeBits.join(" + ") : "Best value";

  // Totals table rows.
  const rows = [
    { kind: "plain", lab: p1.name, sm: p1.displayId, num: p1.subtotal, dim: true },
    { kind: "plain", lab: p2.name, sm: p2.displayId, num: p2.subtotal, dim: true }
  ];
  if (saving > 0) {
    rows.push({ kind: "sub", lab: "Combined subtotal", num: fmtMoney(combinedSubtotal) });
    rows.push({ kind: "disc", lab: "Bundle saving", num: `-${fmtMoney(saving)}` });
    rows.push({ kind: "sub", lab: "Subtotal", num: fmtMoney(discountedSubtotal) });
  } else {
    rows.push({ kind: "sub", lab: "Subtotal", num: fmtMoney(combinedSubtotal) });
  }
  if (freeService) rows.push({ kind: "disc", lab: `${freeService} service`, num: "Included" });
  rows.push({ kind: "plain", lab: "HST 13%", num: fmtMoney(hst), dim: true });
  rows.push({ kind: "total", lab: "Total", num: fmtMoney(total) });

  // Save-note.
  let saveNote;
  if (saving > 0 && freeService) {
    saveNote = `Booked together, you save <span class="big">${fmtMoneyCompact(saving)}</span> off the combined price — <b>and</b> your <b>${freeService}</b> is included, on us. One crew, one install window, the whole property done.`;
  } else if (saving > 0) {
    saveNote = `Booked together, you save <span class="big">${fmtMoneyCompact(saving)}</span> off the combined price. One crew, one install window, the whole property done.`;
  } else if (freeService) {
    saveNote = `Booked together, your <b>${freeService}</b> is included, on us. One crew, one install window, the whole property done.`;
  } else {
    saveNote = `Booked together — one crew, one install window, the whole property done.`;
  }

  // Offer clause.
  const clauseBits = [];
  if (saving > 0) clauseBits.push(`the ${fmtMoneyCompact(saving)} bundle saving`);
  if (freeService) clauseBits.push(`the included ${freeService} service`);
  let offerSentence = "";
  if (clauseBits.length) {
    const subject = clauseBits.join(" and ");
    const verb = clauseBits.length > 1 ? "apply" : "applies";
    offerSentence = ` ${subject.charAt(0).toUpperCase()}${subject.slice(1)} ${verb} only when both projects are booked together; if either is cancelled before work begins, the remaining project reverts to its standalone price.`;
  }
  const clause = `<b>How the combined offer works.</b> Each project keeps its own scope, warranty, and standalone proposal.${offerSentence} Prices in Canadian dollars. This combined offer is valid through ${validThrough}.`;

  const opt = (c, tag) => {
    const h = combinedChildHrefs(c, linkMode);
    return {
      tag, name: c.optName, sub: c.optSub, price: c.total, priceNote: (t.options && t.options.priceNote) || "Total incl. HST",
      viewLabel: (t.options && t.options.viewLabel) || "View full proposal &rarr;",
      dlLabel: (t.options && t.options.downloadLabel) || "Download quote PDF",
      ...h
    };
  };

  const facts = [
    { k: "Prepared for", v: (common.customer && common.customer.name) || "Customer" },
    { k: "Projects", v: String(children.length).padStart(2, "0") },
    { k: "Property", v: shortAddress(address) },
    { k: "Date", v: issued || "—" }
  ];

  return {
    theme: "combined",
    meta: {
      title: t.title || "Combined Proposal — PJL Land Services",
      docKicker: `${(t.kicker || "Combined Proposal")}  ·  ${shortAddress(address)}`
    },
    hero: {
      h1Lead: (t.hero && t.hero.h1Lead) || "Two projects,",
      h1Accent: (t.hero && t.hero.h1Accent) || "one property",
      sub: (t.hero && t.hero.sub) || "",
      facts
    },
    projects: {
      heading: (t.projects && t.projects.heading) || "The two projects",
      lead: (t.projects && t.projects.lead) || "",
      items: children.map((c, i) => ({
        glyph: c.glyph, num: `Project ${String(i + 1).padStart(2, "0")}`,
        name: c.name, quote: `Quote ${c.displayId}`, blurb: c.blurb,
        subtotal: c.subtotal, hst: c.hst, total: c.total
      }))
    },
    options: {
      heading: (t.options && t.options.heading) || "Your options",
      lead,
      a: opt(p1, (t.options && t.options.tagA) || "Option A"),
      b: opt(p2, (t.options && t.options.tagB) || "Option B"),
      c: {
        tag: (t.options && t.options.tagC) || "Option C — Best value",
        name: (t.options && t.options.bothLabel) || "Both together",
        sub: (t.options && t.options.bothSub) || "Both projects, combined",
        price: fmtMoney(total),
        priceNote: (t.options && t.options.priceNote) || "Total incl. HST",
        badge
      },
      totals: rows,
      saveNote,
      clause
    },
    payment: hasDeposit ? {
      mode: "deposit",
      deposit: {
        label: "Deposit to schedule", amount: fmtMoney(deposit),
        when: `${depositPercent}%  ·  due at scheduling`,
        body: "The deposit holds your combined install date and releases the hardware order. Nothing is ordered until the deposit lands."
      },
      balance: {
        label: "Balance", amount: fmtMoney(balance), when: "Due on completion",
        body: "Payable once both systems are installed, tested, and walked through with you."
      }
    } : {
      mode: "total-due",
      totalDue: {
        label: "Total due", amount: fmtMoney(total), when: "Due on completion",
        body: "No deposit required to book — payable in full once both systems are installed, tested, and walked through with you."
      }
    },
    close: {
      heading: (t.close && t.close.heading) || "Ready to do both?",
      body: (t.close && t.close.body) || "",
      sig
    }
  };
}

// ---- main -------------------------------------------------------------

// Build the normalized proposal-data object the generator consumes.
//   quote      — hydrated quote record (project_proposal)
//   customer   — { name, phone, address, email } (from quoteRenderParties)
//   property   — { address } (from quoteRenderParties)
//   templateKey— which per-service copy template to use (default irrigation)
//   heroPhoto  — a data: URI for the hero background, or null
//   combinedChildren — for combined proposals: [{ quote, token, pdfDataUrl, pdfName }]
function buildProposalData(quote, { customer = {}, property = {}, templateKey = "irrigation", heroPhoto = null, combinedChildren = null } = {}) {
  const key = templates.isKnownTemplate(templateKey) ? templateKey : "irrigation";
  const { subtotal, hst, total } = totals(quote);
  const displayId = displayNumber(quote);
  const address = String(property.address || customer.address || "").trim();
  const issued = fmtDate(quote.createdAt);
  const validThrough = fmtDate(quote.validUntil || quote.validUntilDate);
  const zones = countZones(quote);
  const features = systemFeatures(quote);
  const transformer = transformerSpec(quote);   // lighting: count + HUB model

  // Token context for the template copy.
  const ctx = {
    customerName: customer.name || "",
    propertyAddress: address || "your property",
    quoteNumber: displayId,
    issuedDate: issued,
    validThrough: validThrough || "the date shown",
    subtotal: fmtMoney(subtotal),
    hst: fmtMoney(hst),
    total: fmtMoney(total),
    zoneCount: zones,
    transformerModel: transformer.model,
    transformerCountWord: countWord(transformer.count),
    companyName: company.NAME,
    companyPhone: company.PHONE
  };
  const t = templates.loadResolved(key, ctx);
  const sig = `${company.NAME} &nbsp;·&nbsp; ${company.CITY} &nbsp;·&nbsp; ${company.PHONE} &nbsp;·&nbsp; <b>${company.WEBSITE}</b>`;

  // Theme dispatch — lighting builds a different data shape (fixture schedule
  // with Each/Line, dark-theme hero + CTA close); combined merges two child
  // quotes into a bundle page. Everything else is sprinkler.
  if (t.theme === "lighting") {
    return buildLightingData(quote, t, ctx, { customer, displayId, issued, subtotal, hst, total, sig, heroPhoto, transformer });
  }
  if (t.theme === "combined") {
    return buildCombinedData(quote, t, ctx, { customer, displayId, issued, sig, address, children: combinedChildren });
  }

  // Hero facts — all auto-derived, four short cells like the reference.
  const facts = [
    { k: "Prepared for", v: customer.name || "Customer" },
    { k: "Quote", v: displayId },
    { k: "Date", v: issued || "—" }
  ];
  if (validThrough) facts.push({ k: "Valid through", v: validThrough });

  return {
    theme: "sprinkler",
    meta: {
      title: t.title || "Irrigation System Proposal — PJL Land Services",
      docKicker: `${t.kicker || "Proposal"}  ·  ${displayId}`
    },
    hero: {
      h1Lead: (t.hero && t.hero.h1Lead) || "The property,",
      h1Accent: (t.hero && t.hero.h1Accent) || "watered right",
      sub: (t.hero && t.hero.sub) || "",
      facts,
      photo: heroPhoto || null
    },
    system: {
      heading: (t.system && t.system.heading) || "How the system works",
      lead: (t.system && t.system.lead) || "",
      cards: buildSystemCards(t.system || {}, features)
    },
    schedule: {
      heading: (t.schedule && t.schedule.heading) || "System schedule",
      lead: (t.schedule && t.schedule.lead) || "",
      rows: scheduleRows(quote),
      subtotalLabel: (t.schedule && t.schedule.subtotalLabel) || "Subtotal",
      subtotal: fmtMoney(subtotal),
      hst: fmtMoney(hst),
      total: fmtMoney(total),
      countNote: (t.schedule && t.schedule.countNote) || DEFAULT_PRICING_NOTE
    },
    payment: payment(quote, t, total),
    seasonal: buildSeasonal(t, zones),
    scope: {
      heading: (t.scope && t.scope.heading) || "What the price covers",
      lead: (t.scope && t.scope.lead) || "",
      includes: scopeIncludes(t.scope || {}, features.flowMeter),
      excludes: (t.scope && t.scope.excludes) || []
    },
    terms: t.terms || { heading: "Site conditions & the fine print", clauses: [] },
    close: {
      heading: (t.close && t.close.heading) || "Ready when you are",
      body: (t.close && t.close.body) || "",
      sig
    }
  };
}

module.exports = { buildProposalData, fmtMoney, fmtDate };
