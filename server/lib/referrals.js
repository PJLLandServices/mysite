// Referral credits — "send a neighbour or friend our way".
//
// Every welcome email has promised it since the spring: "When a neighbour
// or friend books with us, you get 10% off your seasonal service charge."
// Nothing behind it existed (Patrick, 2026-10-09: "I never made that
// function"). This is it.
//
// THE RULES (Patrick, 2026-10-09):
//   * The REFERRER gets the credit, exactly as the email says. The new
//     customer pays the normal price.
//   * The credit is pricing.json credits.referral_percent (10) of the
//     SEASONAL SERVICE CHARGE only — the spring opening / fall closing
//     line. Repairs and parts are never discounted.
//   * One credit per referred customer, one credit per visit. A referrer
//     with three referrals uses one on each of their next three seasonal
//     visits.
//   * "Has to be mentioned prior to processing! If I create the invoice
//     it's not available." The referral is recorded on the new customer's
//     visit while that visit has no invoice; once it has one, the referral
//     can't be added, changed or removed there. And a credit only comes off
//     a referrer's visit that is not invoiced yet — it is never added to an
//     invoice after the fact.
//
// ONE RULE FOR A CREDIT'S STATE (CLAUDE.md, lifecycle states). A credit is
//
//   removed    — the referral was taken back (ref.removedAt)
//   applied    — an invoice that is NOT void carries it (ref.appliedInvoiceId)
//   available  — otherwise
//
// It is DERIVED from the invoice store, never a stored flag that a second
// writer has to remember to flip: voiding the invoice that used a credit
// hands the credit back by itself, and a claim whose invoice never got
// written (a crash between the two writes) is simply still available.
// creditState() is that rule, and every reader below asks it.
//
// Record (server/data/referrals.json):
//   { id: "REF-0001", referrerCustomerId, referredCustomerId,
//     recordedOnWoId, recordedAt, recordedBy,
//     removedAt, removedBy,
//     appliedInvoiceId, appliedWoId, appliedAt,
//     history: [{ ts, action, by, note }] }

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const { writeJsonAtomic, serialize, parseJsonArrayStore } = require("./atomic-json");

const FILE = path.join(__dirname, "..", "data", "referrals.json");
const SEASONAL = new Set(["fall_closing", "spring_opening"]);

async function ensureFile() {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  if (!fsSync.existsSync(FILE)) await fs.writeFile(FILE, "[]\n", "utf8");
}

// A damaged file throws rather than reading as [] (the invoices.js rule):
// an empty answer would let the next save erase every referral.
async function readAll() {
  await ensureFile();
  return parseJsonArrayStore(await fs.readFile(FILE, "utf8"), FILE);
}

async function writeAll(records) {
  await ensureFile();
  await writeJsonAtomic(FILE, records);
}

const locked = (fn) => (...args) => serialize(FILE, () => fn(...args));

const round2 = (n) => Math.round(Number(n) * 100) / 100;

function nextId(records) {
  const max = records.reduce((m, r) => {
    const n = Number(String(r?.id || "").replace(/^REF-/, ""));
    return Number.isFinite(n) && n > m ? n : m;
  }, 0);
  return `REF-${String(max + 1).padStart(4, "0")}`;
}

// ---- the one rule --------------------------------------------------------

// `invoiceById` is a Map (or a function) from invoice id to the invoice.
function creditState(ref, invoiceById) {
  if (!ref) return null;
  if (ref.removedAt) return "removed";
  if (ref.appliedInvoiceId) {
    const inv = typeof invoiceById === "function" ? invoiceById(ref.appliedInvoiceId) : invoiceById?.get(ref.appliedInvoiceId);
    if (inv && inv.status !== "void") return "applied";
  }
  return "available";
}

const isLive = (ref) => ref && !ref.removedAt;

// The referral that names `customerId` as the one referred (at most one
// live one exists), or null.
function referralOf(records, customerId) {
  if (!customerId) return null;
  return (records || []).find((r) => isLive(r) && r.referredCustomerId === customerId) || null;
}

// A referrer's credits that can still be used, oldest first.
function availableCredits(records, referrerCustomerId, invoiceById) {
  if (!referrerCustomerId) return [];
  return (records || [])
    .filter((r) => r.referrerCustomerId === referrerCustomerId && creditState(r, invoiceById) === "available")
    .sort((a, b) => String(a.recordedAt || "").localeCompare(String(b.recordedAt || "")) || String(a.id).localeCompare(String(b.id)));
}

// The seasonal service charge on a list of billable lines (builder shape),
// in dollars, or null when there is no priced fee to take 10% of. A fee
// still waiting on Patrick's price (pending / suggested) earns nothing yet:
// the credit waits for a visit whose charge is known.
function seasonalChargeOf(lines) {
  const pricing = require("./pricing");
  const idx = pricing.feeLineIndex(lines);
  if (idx === -1) return null;
  const fee = lines[idx];
  if (fee.priceStatus === "pending" || fee.priceStatus === "suggested") return null;
  const unit = fee.overridePrice != null && Number.isFinite(Number(fee.overridePrice))
    ? Number(fee.overridePrice) : Number(fee.originalPrice ?? fee.price);
  const amount = round2(unit * (Number(fee.qty) || 1));
  return Number.isFinite(amount) && amount > 0 ? amount : null;
}

// "Sarah Mitchell" -> "Sarah M." — the referrer knows who they sent; their
// invoice needn't carry the neighbour's whole name.
function shortName(name) {
  const parts = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return "a neighbour";
  if (parts.length === 1) return parts[0];
  return `${parts[0]} ${parts[parts.length - 1][0].toUpperCase()}.`;
}

// PURE. The credit line a seasonal work order bills, or null.
//
//   wo            the work order (type, id, customerId)
//   lines         its billable lines (billing.billingFor, before the credit)
//   records       every referral
//   invoices      every invoice
//   percent       pricing.referralCreditPercent()
//   nameOf        customerId -> name
//
// A work order that already has an invoice bills the credit THAT invoice
// claimed (so re-reading the bill of an invoiced visit — the signed-scope
// reconcile does — keeps it) and never picks up a new one. One that has no
// invoice takes the referrer's oldest available credit.
function creditLineFor({ wo, lines, records, invoices, percent, nameOf = () => "" }) {
  if (!wo || !SEASONAL.has(wo.type) || !wo.customerId || !percent) return null;
  const charge = seasonalChargeOf(lines);
  if (charge == null) return null;
  const invoiceById = new Map((invoices || []).map((i) => [i.id, i]));
  const active = (invoices || []).find((i) => i && i.woId === wo.id && i.status !== "void") || null;
  let ref;
  if (active) {
    ref = (records || []).find((r) => r.appliedInvoiceId === active.id && creditState(r, invoiceById) === "applied") || null;
  } else {
    ref = availableCredits(records, wo.customerId, invoiceById)[0] || null;
  }
  if (!ref) return null;
  const amount = round2(charge * percent / 100);
  if (!(amount > 0)) return null;
  return {
    key: null,
    label: `Referral credit ${percent}% — thank you for referring ${shortName(nameOf(ref.referredCustomerId))}`,
    qty: 1,
    originalPrice: -amount,
    overridePrice: null,
    custom: true,
    referralCreditId: ref.id,
    source: { referralCredit: ref.id },
    note: ""
  };
}

// billing.billingFor's reader: loads the stores and asks creditLineFor.
async function creditLineForWorkOrder(wo, lines) {
  if (!wo || !SEASONAL.has(wo.type) || !wo.customerId) return null;
  // A visit the office settled as Paid in Full is never invoiced, so a
  // credit shown on it could never be used: it waits for a billed visit.
  if (require("./wo-settlement").isPaidInFull(wo)) return null;
  const pricing = require("./pricing");
  const percent = pricing.referralCreditPercent();
  if (!percent) return null;
  const records = await readAll();
  if (!records.some((r) => r.referrerCustomerId === wo.customerId)) return null;
  const invoices = await require("./invoices").list();
  const customers = require("./customers");
  const names = new Map();
  for (const r of records) {
    if (r.referrerCustomerId !== wo.customerId || names.has(r.referredCustomerId)) continue;
    const c = await customers.get(r.referredCustomerId, { withProperties: false }).catch(() => null);
    names.set(r.referredCustomerId, c?.name || "");
  }
  return creditLineFor({ wo, lines, records, invoices, percent, nameOf: (id) => names.get(id) || "" });
}

// ---- writes ----------------------------------------------------------------

// invoices.createDraft, under the INVOICE store lock, before it writes the
// invoice: claim the credits its lines carry for invoice `invoiceId`. A
// credit another live invoice already holds (two open visits for one
// referrer, both previewing the same credit) is NOT claimed twice — its id
// comes back in `refused` and the caller drops that line. At most one
// credit per invoice. `invoiceRecords` is the invoice store as the caller
// holds it under its lock.
async function claimForInvoice(creditIds, { invoiceId, woId, invoiceRecords, by = "system" }) {
  const wanted = [...new Set((creditIds || []).filter(Boolean))];
  if (!wanted.length) return { claimed: [], refused: [] };
  const invoiceById = new Map((invoiceRecords || []).map((i) => [i.id, i]));
  const records = await readAll();
  const claimed = [];
  const refused = [];
  const now = new Date().toISOString();
  for (const id of wanted) {
    const ref = records.find((r) => r.id === id);
    const state = creditState(ref, invoiceById);
    if (!ref || state !== "available" || claimed.length >= 1) { refused.push(id); continue; }
    ref.appliedInvoiceId = invoiceId;
    ref.appliedWoId = woId || null;
    ref.appliedAt = now;
    ref.history = [...(ref.history || []), { ts: now, action: "credit_applied", by, note: `Invoice ${invoiceId}${woId ? ` (WO ${woId})` : ""}` }];
    claimed.push(id);
  }
  if (claimed.length) await writeAll(records);
  return { claimed, refused };
}

// Record that `referredCustomerId` was sent by `referrerCustomerId`. The
// caller has already checked the visit it is recorded on has no invoice.
async function record({ referredCustomerId, referrerCustomerId, woId = null, by = "admin" }) {
  if (!referredCustomerId || !referrerCustomerId) return { ok: false, code: "missing_customer" };
  if (referredCustomerId === referrerCustomerId) return { ok: false, code: "self_referral" };
  const records = await readAll();
  const invoiceById = new Map((await require("./invoices").list()).map((i) => [i.id, i]));
  const now = new Date().toISOString();
  const current = referralOf(records, referredCustomerId);
  if (current && current.referrerCustomerId === referrerCustomerId) return { ok: true, referral: current, unchanged: true };
  if (current) {
    if (creditState(current, invoiceById) === "applied") return { ok: false, code: "credit_used", referral: current };
    current.removedAt = now;
    current.removedBy = by;
    current.history = [...(current.history || []), { ts: now, action: "replaced", by, note: `Referrer changed on WO ${woId || "—"}` }];
  }
  const ref = {
    id: nextId(records),
    referrerCustomerId,
    referredCustomerId,
    recordedOnWoId: woId,
    recordedAt: now,
    recordedBy: by,
    removedAt: null,
    removedBy: null,
    appliedInvoiceId: null,
    appliedWoId: null,
    appliedAt: null,
    history: [{ ts: now, action: "recorded", by, note: woId ? `On WO ${woId}` : "" }]
  };
  records.push(ref);
  await writeAll(records);
  return { ok: true, referral: ref };
}

// Take a referral back. Refused once its credit is on a live invoice.
async function remove({ referredCustomerId, by = "admin" }) {
  const records = await readAll();
  const invoiceById = new Map((await require("./invoices").list()).map((i) => [i.id, i]));
  const current = referralOf(records, referredCustomerId);
  if (!current) return { ok: true, unchanged: true };
  if (creditState(current, invoiceById) === "applied") return { ok: false, code: "credit_used", referral: current };
  const now = new Date().toISOString();
  current.removedAt = now;
  current.removedBy = by;
  current.history = [...(current.history || []), { ts: now, action: "removed", by, note: "" }];
  await writeAll(records);
  return { ok: true, referral: current };
}

async function list() { return readAll(); }

module.exports = {
  FILE,
  creditState, referralOf, availableCredits, seasonalChargeOf, shortName, creditLineFor,
  creditLineForWorkOrder,
  claimForInvoice: locked(claimForInvoice),
  record: locked(record),
  remove: locked(remove),
  list
};
