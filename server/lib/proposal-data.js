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

const templates = require("./proposal-templates");
const company = require("./company");

const HST_RATE = 0.13;

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

// ---- main -------------------------------------------------------------

// Build the normalized proposal-data object the generator consumes.
//   quote      — hydrated quote record (project_proposal)
//   customer   — { name, phone, address, email } (from quoteRenderParties)
//   property   — { address } (from quoteRenderParties)
//   templateKey— which per-service copy template to use (default irrigation)
//   heroPhoto  — a data: URI for the hero background, or null
function buildProposalData(quote, { customer = {}, property = {}, templateKey = "irrigation", heroPhoto = null } = {}) {
  const key = templates.isKnownTemplate(templateKey) ? templateKey : "irrigation";
  const { subtotal, hst, total } = totals(quote);
  const displayId = displayNumber(quote);
  const address = String(property.address || customer.address || "").trim();
  const issued = fmtDate(quote.createdAt);
  const validThrough = fmtDate(quote.validUntil || quote.validUntilDate);

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
    companyName: company.NAME,
    companyPhone: company.PHONE
  };
  const t = templates.loadResolved(key, ctx);

  // Hero facts — all auto-derived, four short cells like the reference.
  const facts = [
    { k: "Prepared for", v: customer.name || "Customer" },
    { k: "Quote", v: displayId },
    { k: "Date", v: issued || "—" }
  ];
  if (validThrough) facts.push({ k: "Valid through", v: validThrough });

  const sig = `${company.NAME} &nbsp;·&nbsp; ${company.CITY} &nbsp;·&nbsp; ${company.PHONE} &nbsp;·&nbsp; <b>${company.WEBSITE}</b>`;

  return {
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
    system: t.system || { heading: "", lead: "", cards: [] },
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
    scope: t.scope || { heading: "What the price covers", lead: "", includes: [], excludes: [] },
    terms: t.terms || { heading: "Site conditions & the fine print", clauses: [] },
    close: {
      heading: (t.close && t.close.heading) || "Ready when you are",
      body: (t.close && t.close.body) || "",
      sig
    }
  };
}

module.exports = { buildProposalData, fmtMoney, fmtDate };
