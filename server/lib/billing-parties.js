// Billing parties — resolves WHO is billed and THROUGH WHOM, from the
// (property, customer) pair. One place, so invoices, quote PDFs and the
// admin UI can never disagree about the envelope.
//
// The management-company model (Jul 2026): one CUSTOMER can manage MANY
// properties, and each property is owned by its own legal entity that gets
// billed. So the payer's legal name lives on the PROPERTY
// (property.billingEntity) and the managing company is the CUSTOMER.
//
//   Commercial, managed (property HAS its own billing entity):
//     name    = property.billingEntity        "YRSCC No. 1233 — Lewis Honey…"
//     careOf  = customer.name                 "c/o RMSCO Management Services Ltd."
//     address = customer.billingAddress       where the invoice is mailed
//
//   Everything else (residential, or a commercial account that bills itself):
//     name    = customer.billingName || customer.name
//     careOf  = customer.commercial.careOf    (manual override, usually empty)
//     address = customer.billingAddress || the service address
//
// The second branch is byte-identical to the pre-existing behaviour, so
// residential invoices are untouched.
//
// ccEmail (addendum, Jul 2026) is resolved on BOTH branches and is
// independent of the managed/self-billed split: the party who accepts the
// work is often not the party who pays it. A commercial owner signs the
// quote while a bookkeeper — or a per-site condo-corp accounts-payable
// desk — receives the invoice. Per-site wins over account-level, mirroring
// billingEntity's precedence. Deliberately kept SEPARATE from `email`:
// folding them together would lose the distinction between "who we bill"
// and "who else gets a copy", and the CC is a payments concern only (it is
// never applied to quotes — those go to the signatory who accepts them).

const crypto = require("node:crypto");

function s(v, n = 400) {
  return String(v == null ? "" : v).trim().slice(0, n);
}

// ---- Contact identity -------------------------------------------------
//
// Commercial contacts live in TWO lists — customer.commercial.contacts[]
// (org-wide signatories) and property.siteContacts[] (one building) — and
// Phase 1 has to resolve a portal login back to exactly one of them. Name
// and email both change over a contact's life (people get married, companies
// switch domains), so neither is a durable key. Every contact therefore
// carries a `con_xxxxxxxx` id.
//
// Minted HERE rather than in customers.js / properties.js so the two lists
// can never drift into different id formats — this module already owns the
// commercial-party model that both sides read. Format matches the existing
// li_ / iss_ / att_ family: prefix + 8 random hex chars.
//
// These are identity helpers, not billing resolution: resolveBillTo and
// resolveContactRoles are unchanged.
const CONTACT_ID_RE = /^con_[a-f0-9]{8}$/i;

function isContactId(value) {
  return typeof value === "string" && CONTACT_ID_RE.test(value.trim());
}

function makeContactId() {
  return "con_" + crypto.randomBytes(4).toString("hex");
}

// Preserve a well-formed caller-supplied id, otherwise mint a fresh one.
// An editor that round-trips the id keeps the contact's identity across a
// save; a contact submitted without one is, by definition, a new contact.
function coerceContactId(value) {
  return isContactId(value) ? value.trim().toLowerCase() : makeContactId();
}

// Resolve the bill-to envelope. Both args tolerate null.
// Returns { name, careOf, address, email, ccEmail, managed }
//   managed — true when the c/o was derived from a managing customer, i.e.
//             this is a property-level billing entity. Lets callers label
//             the UI ("Managed billing") without re-deriving the rule.
//   ccEmail — an extra address that gets a copy of the INVOICE only.
//             Per-site (property.billingCcEmail) beats account-level
//             (customer.billingCcEmail). Empty when neither is set, which
//             is every residential and most commercial accounts.
function resolveBillTo(property, customer, { fallbackAddress = "" } = {}) {
  const prop = property && typeof property === "object" ? property : {};
  const cust = customer && typeof customer === "object" ? customer : {};

  const entity = s(prop.billingEntity, 200);
  const custName = s(cust.name, 200);
  const custBillingName = s(cust.billingName, 200);
  const manualCareOf = s(cust.commercial && cust.commercial.careOf, 200);
  const custAddress = s(cust.billingAddress, 400);
  const email = s(cust.billingEmail, 254).toLowerCase() || s(cust.email, 254).toLowerCase();
  // Per-site first, then account-level. Same precedence as billingEntity, so
  // a management company can set one bookkeeper for the whole account and
  // still override it for the one site whose condo corp pays its own bills.
  const ccEmail = s(prop.billingCcEmail, 254).toLowerCase()
    || s(cust.billingCcEmail, 254).toLowerCase();

  // Managed: the property names its own payer AND a managing customer exists
  // to bill it through. A property whose entity matches the customer's own
  // name is self-billed, not managed — don't print "c/o <itself>".
  const managed = Boolean(entity && custName && entity !== custName);

  if (managed) {
    return {
      name: entity,
      careOf: custName,
      address: custAddress || s(fallbackAddress, 400),
      email,
      ccEmail,
      managed: true
    };
  }

  return {
    name: entity || custBillingName || custName,
    careOf: manualCareOf,
    address: custAddress || s(fallbackAddress, 400),
    email,
    ccEmail,
    managed: false
  };
}

// Build the `cc:` list for an INVOICE email. Pure — no I/O, no transport —
// so the dedupe rules are testable without a mail server.
//
// Two independent CC sources, and they can collide with each other or with
// the primary recipient:
//   spouseEmail     — household CC (customer.copySpouseOnInvoices)
//   billingCcEmail  — the payer's bookkeeper / accounts-payable desk,
//                     snapshotted onto invoice.billTo.ccEmail at draft time
//
// A duplicate is dropped rather than sent twice: CC'ing the primary
// recipient on their own invoice, or listing one address under two roles,
// reads as a bug to the customer. Comparison is case-insensitive because
// these come from three different hand-typed fields.
//
// Order is deliberate — spouse first, then billing — so the existing
// household-CC behaviour is unchanged when no billing CC is set.
function buildInvoiceCcList({ to = "", spouseEmail = "", billingCcEmail = "" } = {}) {
  const primary = s(to, 254).toLowerCase();
  const out = [];
  for (const candidate of [spouseEmail, billingCcEmail]) {
    const addr = s(candidate, 254).toLowerCase();
    if (!addr) continue;
    if (addr === primary) continue;
    if (out.includes(addr)) continue;
    out.push(addr);
  }
  return out;
}

// Who signs the quote, and who do we call to get on site?
// Signatories come from the CUSTOMER (the management company signs across
// all its sites); a site-specific signatory on the property also counts.
// Site contacts come from the PROPERTY (each site has its own president /
// super), falling back to any customer contact flagged as a site contact.
// Returns { signatories: [...], siteContacts: [...] } — each entry carries
// `from: "customer" | "property"` so the UI can show where it came from.
function resolveContactRoles(property, customer) {
  const prop = property && typeof property === "object" ? property : {};
  const cust = customer && typeof customer === "object" ? customer : {};
  const custContacts = (cust.commercial && Array.isArray(cust.commercial.contacts))
    ? cust.commercial.contacts : [];
  const propContacts = Array.isArray(prop.siteContacts) ? prop.siteContacts : [];

  const tag = (list, from) => list.filter(Boolean).map((c) => ({ ...c, from }));
  const all = [...tag(custContacts, "customer"), ...tag(propContacts, "property")];

  return {
    signatories: all.filter((c) => c.isAuthorizedSignatory),
    siteContacts: all.filter((c) => c.isSiteContact)
  };
}

module.exports = {
  resolveBillTo,
  resolveContactRoles,
  buildInvoiceCcList,
  isContactId,
  makeContactId,
  coerceContactId
};
