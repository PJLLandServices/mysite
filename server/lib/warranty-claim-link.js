// Warranty-claim cross-check — "who is this, what did we do for them, and
// is the thing they're claiming against still under warranty?"
//
// A claim arrives from a public form with nothing but a name, a phone, an
// email, whatever the customer remembers of their invoice number, and some
// files. This module turns that into CRM context: the customer record, the
// property, the invoice being claimed against, the work order behind it,
// and the service history Patrick needs in front of him to make a call.
//
// THIS MODULE NEVER DECIDES ANYTHING. It reports what matched and how
// confidently, and it always shows its work through `matchedBy` — a claim
// is approved or denied by a person, not by a string comparison. In
// particular `warranty.active === false` is NOT a denial: back-dated
// completions, a missing completedAt on a pre-backfill record, and work
// invoiced under a different property all produce a false negative. It is
// a flag for Patrick to look at, worded that way everywhere it surfaces.
//
// Confidence is deliberately coarse:
//   "strong"  — the invoice the customer named was found AND it belongs to
//               the customer we matched them to. Both halves agree.
//   "partial" — we found a customer, or an invoice, but not a corroborated
//               pair.
//   "none"    — nothing matched. Common and not suspicious: a claim can
//               come from a spouse's email address, or from a job invoiced
//               before the CRM existed.
//
// Every lookup is wrapped: a cross-check failure must never cost the
// customer their claim. On any throw the claim still saves with
// confidence "none" and the reason logged.

const customers = require("./customers");
const properties = require("./properties");
const invoices = require("./invoices");
const workOrders = require("./work-orders");
const { warrantyForWorkOrder, WARRANTY_MONTHS, addMonths } = require("./warranty");

// Pull every plausible invoice id out of what the customer typed.
//
// Customers write their invoice reference every way imaginable:
// "I-2026-0042", "i 2026 0042", "Invoice #2026-0042", "42", "#0042". We
// generate candidate ids from the digits rather than trying to parse the
// prose. Returns canonical "I-YYYY-NNNN" strings, most-specific first.
function invoiceIdCandidates(raw, { years = [] } = {}) {
  const text = String(raw || "").trim();
  if (!text) return [];
  const out = [];
  const push = (id) => { if (id && !out.includes(id)) out.push(id); };

  // Shape 1: a full id, in any punctuation/casing — I-2026-0042, i 2026 42.
  const full = text.match(/i?\s*[-_ ]?\s*(20\d{2})\s*[-_ ]?\s*(\d{1,6})/i);
  if (full) {
    push(`I-${full[1]}-${String(full[2]).padStart(4, "0")}`);
    // Stop here. Falling through to the bare-sequence shape below would
    // re-read the YEAR as a sequence ("I-2026-0042" → also I-2026-2026,
    // I-2025-2026) and those are not near-misses — they are valid ids
    // that could belong to a real, unrelated invoice. A reference
    // specific enough to carry its own year gets exactly one candidate.
    return out;
  }

  // Shape 2: a bare sequence — "42", "#0042", "invoice 42". Only meaningful
  // paired with a year, so we try the years the caller thinks are relevant
  // (the customer's invoice years, then recent ones).
  const bare = text.match(/(?:^|[^0-9])(\d{1,4})(?:[^0-9]|$)/);
  if (bare) {
    const seq = String(bare[1]).padStart(4, "0");
    for (const y of years) push(`I-${y}-${seq}`);
  }
  return out;
}

// Years worth trying a bare sequence against: whatever years the customer
// actually has invoices in, newest first, then this year and last year.
function candidateYears(customerInvoices) {
  const years = [];
  for (const inv of customerInvoices) {
    const m = String(inv?.id || "").match(/^I-(20\d{2})-/);
    if (m && !years.includes(m[1])) years.push(m[1]);
  }
  const thisYear = String(new Date().getFullYear());
  const lastYear = String(new Date().getFullYear() - 1);
  for (const y of [thisYear, lastYear]) if (!years.includes(y)) years.push(y);
  return years;
}

// Warranty position for the work behind an invoice.
//
// Two sources, in order of authority:
//   1. The work order itself, via lib/warranty.js. Live and exact.
//   2. The property's service record, which snapshots warrantyExpiresAt at
//      completion. Used when the WO has been deleted/archived but the
//      service record survives.
//
// Returns null when neither is available — "we don't know", which reads
// very differently from "expired" and must not be collapsed into it.
async function warrantyPosition({ invoice, property }) {
  const woId = invoice?.woId || null;
  if (woId) {
    try {
      const wo = await workOrders.get(woId);
      if (wo) {
        const w = warrantyForWorkOrder(wo);
        if (w.ok) {
          return {
            source: "work_order",
            workOrderId: wo.id,
            workOrderType: wo.type || null,
            months: w.months,
            completedAt: w.completedAt,
            expiresAt: w.expiresAt,
            active: w.active
          };
        }
        return {
          source: "work_order",
          workOrderId: wo.id,
          workOrderType: wo.type || null,
          months: WARRANTY_MONTHS[wo.type] || null,
          completedAt: wo.completedAt || null,
          expiresAt: null,
          active: null,
          // "not_completed" / "no_completion_date" — surfaced verbatim so
          // the CRM can explain WHY there's no date rather than implying
          // the warranty lapsed.
          unknownReason: w.reason
        };
      }
    } catch (_) { /* fall through to the service record */ }
  }

  if (property && Array.isArray(property.serviceRecords)) {
    const rec = property.serviceRecords.find((r) =>
      (invoice && r?.invoiceId && r.invoiceId === invoice.id) ||
      (woId && r?.woId && r.woId === woId)
    );
    if (rec && rec.warrantyExpiresAt) {
      return {
        source: "service_record",
        workOrderId: rec.woId || null,
        workOrderType: rec.woType || null,
        months: Number(rec.warrantyMonths) || null,
        completedAt: rec.completedAt || null,
        expiresAt: rec.warrantyExpiresAt,
        active: Date.parse(rec.warrantyExpiresAt) > Date.now()
      };
    }
    // A record with a completion date but no snapshotted expiry (pre-
    // JOB-002 data) can still be computed from the policy table.
    if (rec && rec.completedAt) {
      const months = WARRANTY_MONTHS[rec.woType] || 12;
      const expiresAt = addMonths(rec.completedAt, months);
      return {
        source: "service_record_computed",
        workOrderId: rec.woId || null,
        workOrderType: rec.woType || null,
        months,
        completedAt: rec.completedAt,
        expiresAt,
        active: Date.parse(expiresAt) > Date.now()
      };
    }
  }
  return null;
}

// The service history Patrick reads on the claim page. Newest first,
// capped — the point is context, not an audit trail (the property page has
// the full list).
function recentServiceRecords(property, limit = 6) {
  if (!property || !Array.isArray(property.serviceRecords)) return [];
  return property.serviceRecords.slice(0, limit).map((r) => ({
    id: r.id || null,
    woId: r.woId || null,
    woType: r.woType || "service_visit",
    completedAt: r.completedAt || null,
    summary: String(r.summary || "").slice(0, 400),
    total: Number(r.total) || 0,
    invoiceId: r.invoiceId || null,
    warrantyExpiresAt: r.warrantyExpiresAt || null
  }));
}

// Main entry. Takes the claim (or any object with claimant + invoiceRef)
// and returns { link, context }:
//
//   link    — the small, storable summary that lives on the claim record.
//   context — the fuller read-side payload (names, addresses, history) the
//             CRM renders. NOT stored: it would go stale the moment the
//             customer record is edited, and it is cheap to rebuild.
async function crossCheck(claim) {
  const link = {
    customerId: null,
    propertyId: null,
    invoiceId: null,
    workOrderId: null,
    matchedBy: [],
    confidence: "none",
    warranty: null
  };
  const context = {
    customer: null,
    property: null,
    invoice: null,
    serviceRecords: [],
    otherInvoices: [],
    error: null
  };

  const email = String(claim?.claimant?.email || "").trim();
  const phone = String(claim?.claimant?.phone || "").trim();

  try {
    // ---- 1. Customer, by email then phone (customers.js match order) ----
    let customer = null;
    if (email) {
      customer = await customers.findByEmail(email);
      if (customer) link.matchedBy.push("customer_email");
    }
    if (!customer && phone) {
      customer = await customers.findByPhone(phone);
      if (customer) link.matchedBy.push("customer_phone");
    }
    if (customer) {
      link.customerId = customer.id;
      context.customer = {
        id: customer.id,
        name: customer.name || "",
        email: customer.email || "",
        phone: customer.phone || "",
        status: customer.status || ""
      };
    }

    // ---- 2. Invoices for that customer ---------------------------------
    const allInvoices = await invoices.list();
    const custInvoices = customer
      ? allInvoices.filter((inv) => inv.customerId === customer.id ||
          (inv.customerEmail && email && inv.customerEmail.toLowerCase() === email.toLowerCase()))
      : (email ? allInvoices.filter((inv) => (inv.customerEmail || "").toLowerCase() === email.toLowerCase()) : []);

    // ---- 3. The invoice they named --------------------------------------
    let invoice = null;
    const candidates = invoiceIdCandidates(claim?.invoiceRef, { years: candidateYears(custInvoices) });
    for (const id of candidates) {
      // Prefer one of THEIR invoices — a bare "42" must not resolve to a
      // stranger's invoice just because the number exists.
      const mine = custInvoices.find((inv) => inv.id === id);
      if (mine) { invoice = mine; link.matchedBy.push("invoice_id_customer"); break; }
    }
    if (!invoice) {
      for (const id of candidates) {
        const any = allInvoices.find((inv) => inv.id === id);
        if (any) {
          invoice = any;
          // Found, but it isn't on the customer we matched (or we matched
          // nobody). Flagged distinctly so the CRM can say "this invoice
          // is under a different name" rather than quietly linking it.
          link.matchedBy.push("invoice_id_unverified");
          break;
        }
      }
    }
    if (invoice) {
      link.invoiceId = invoice.id;
      link.workOrderId = invoice.woId || null;
      context.invoice = {
        id: invoice.id,
        status: invoice.status || "",
        issuedAt: invoice.issuedAt || invoice.createdAt || null,
        total: Number(invoice.total) || 0,
        customerName: invoice.customerName || "",
        customerEmail: invoice.customerEmail || "",
        address: invoice.address || "",
        woId: invoice.woId || null,
        propertyId: invoice.propertyId || null,
        // True when the invoice we found is NOT on the customer record we
        // matched. Drives the "verify this belongs to them" warning.
        belongsToMatchedCustomer: Boolean(customer && invoice.customerId === customer.id)
      };
      if (!customer && invoice.customerId) {
        // The invoice number was right even though the contact details
        // didn't match anything — e.g. a spouse filing on the account.
        link.customerId = invoice.customerId;
        try {
          const c = await customers.get(invoice.customerId);
          if (c) {
            context.customer = {
              id: c.id, name: c.name || "", email: c.email || "",
              phone: c.phone || "", status: c.status || ""
            };
            link.matchedBy.push("customer_via_invoice");
          }
        } catch (_) { /* leave context.customer null */ }
      }
    }

    // ---- 4. Property: from the invoice first, else the customer's -------
    let property = null;
    const allProperties = await properties.list();
    if (invoice?.propertyId) {
      property = allProperties.find((p) => p.id === invoice.propertyId) || null;
      if (property) link.matchedBy.push("property_via_invoice");
    }
    if (!property && link.customerId) {
      const owned = allProperties.filter((p) => p.customerId === link.customerId);
      // Only auto-link when there is exactly one — picking one of three
      // properties for the customer would be a guess presented as a fact.
      if (owned.length === 1) {
        property = owned[0];
        link.matchedBy.push("property_sole_owned");
      } else if (owned.length > 1) {
        link.matchedBy.push("property_ambiguous");
        context.candidateProperties = owned.map((p) => ({
          id: p.id, address: p.address || "", customerName: p.customerName || ""
        }));
      }
    }
    if (property) {
      link.propertyId = property.id;
      context.property = {
        id: property.id,
        address: property.address || "",
        customerName: property.customerName || "",
        zoneCount: Array.isArray(property.system?.zones) ? property.system.zones.length : 0,
        controllerBrand: property.system?.controllerBrand || ""
      };
      context.serviceRecords = recentServiceRecords(property);
    }

    // ---- 5. Warranty position -------------------------------------------
    link.warranty = await warrantyPosition({ invoice, property });
    if (link.warranty?.workOrderId && !link.workOrderId) {
      link.workOrderId = link.warranty.workOrderId;
    }

    // ---- 6. Their other invoices, for "did they mean this one?" ---------
    context.otherInvoices = custInvoices
      .filter((inv) => !invoice || inv.id !== invoice.id)
      .slice(0, 8)
      .map((inv) => ({
        id: inv.id,
        status: inv.status || "",
        issuedAt: inv.issuedAt || inv.createdAt || null,
        total: Number(inv.total) || 0,
        woId: inv.woId || null
      }));

    // ---- 7. Confidence ---------------------------------------------------
    const invoiceCorroborated = Boolean(invoice) && link.matchedBy.includes("invoice_id_customer");
    if (invoiceCorroborated) link.confidence = "strong";
    else if (customer || invoice) link.confidence = "partial";
    else link.confidence = "none";
  } catch (err) {
    // Never fatal — the claim is already filed and must survive a bad
    // cross-check. Recorded so the CRM can offer a "re-run" button.
    context.error = err?.message || String(err);
    console.error("[warranty-claim] cross-check failed:", context.error);
  }

  return { link, context };
}

module.exports = {
  crossCheck,
  invoiceIdCandidates,
  candidateYears,
  warrantyPosition,
  recentServiceRecords
};
