// Completion cascade — fires when a WO transitions to status=completed.
// Spec §4.3.4. Idempotent (a service record already attached to the WO
// short-circuits) so accidental re-firing is safe.
//
// What it does:
//   1. Append a service record to the linked property
//   2. Promote zone-level updates (descriptions, types) back to property
//   3. Create a draft invoice (server/data/invoices.json)
//   4. Stamp warranty metadata (12mo for repairs, 36mo for installs)
//   5. Notify Patrick (admin email/SMS)
//   6. Notify customer (branded email summary)
//   7. Return { serviceRecord, invoice } so the caller can show what fired.
//
// What it does NOT do (yet):
//   - QuickBooks invoice push (future slice — invoice has placeholder field)
//   - Photo promotion to property folder (also future — flagged in plan)

const properties = require("./properties");
const invoices = require("./invoices");

// Warranty defaults by service type. Spec §4.3.4 says 1yr repairs / 3yr
// installs. Map service_visit + spring/fall openings to "repair" tier;
// install-style WO types (none yet) get the longer warranty.
const WARRANTY_MONTHS = {
  service_visit: 12,
  spring_opening: 12,
  fall_closing: 12,
  install: 36
};

function addMonths(iso, months) {
  const d = new Date(iso);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString();
}

// Pull a one-line summary from the WO. Prefers tech notes, falls back to
// type label + zone count.
function summarizeWo(wo) {
  if (wo.techNotes && wo.techNotes.trim()) {
    return wo.techNotes.trim().split("\n")[0].slice(0, 200);
  }
  const zoneCount = (wo.zones || []).length;
  const issueCount = (wo.zones || []).reduce((sum, z) => sum + ((z.issues || []).length), 0);
  const labels = {
    spring_opening: "Spring opening",
    fall_closing: "Fall closing",
    service_visit: "Service visit"
  };
  const base = labels[wo.type] || "Visit";
  if (issueCount) return `${base} — ${issueCount} issue${issueCount === 1 ? "" : "s"} found across ${zoneCount} zone${zoneCount === 1 ? "" : "s"}`;
  return `${base} — ${zoneCount} zone${zoneCount === 1 ? "" : "s"} checked`;
}

// Pull line items from the WO. Priority:
//   1. wo.onSiteQuote.builderLineItems (the customer-accepted lines)
//   2. wo.lineItems (legacy / additional repairs)
//   3. [] (no charge — spring opening with nothing to bill, etc.)
function lineItemsFromWo(wo) {
  if (Array.isArray(wo.onSiteQuote?.builderLineItems) && wo.onSiteQuote.builderLineItems.length) {
    return wo.onSiteQuote.builderLineItems;
  }
  if (Array.isArray(wo.lineItems) && wo.lineItems.length) return wo.lineItems;
  return [];
}

// Build the system-update patch from the WO's zones. Only carries forward
// the fields a tech might have edited on-site (notes, sprinkler types,
// coverage). The property's blank-protection in applySystemUpdates means
// existing values are never blanked out.
function systemUpdatesFromWo(wo) {
  const zones = (wo.zones || [])
    .filter((z) => Number.isFinite(Number(z.number)) && Number(z.number) > 0)
    .map((z) => ({
      number: Number(z.number),
      label: z.location || "",
      location: z.location || "",
      sprinklerTypes: Array.isArray(z.sprinklerTypes) ? z.sprinklerTypes : [],
      coverage: Array.isArray(z.coverage) ? z.coverage : [],
      notes: z.notes || ""
    }));
  return zones.length ? { zones } : {};
}

async function run(wo, deps = {}) {
  if (!wo || !wo.id) return { ok: false, errors: ["No WO."] };
  if (!wo.propertyId) return { ok: false, errors: ["WO has no linked property."] };

  // Idempotency: if a service record already references this WO, return it.
  const existing = await properties.findServiceRecordByWo(wo.propertyId, wo.id);
  if (existing) {
    return { ok: true, serviceRecord: existing, invoice: existing.invoiceId ? await invoices.get(existing.invoiceId) : null, alreadyRan: true };
  }

  const completedAt = new Date().toISOString();
  const lineItems = lineItemsFromWo(wo);
  const summary = summarizeWo(wo);
  const warrantyMonths = WARRANTY_MONTHS[wo.type] || 12;
  const warrantyExpiresAt = addMonths(completedAt, warrantyMonths);

  // 1) Property system updates (zone descriptions etc.)
  const sysPatch = systemUpdatesFromWo(wo);
  if (Object.keys(sysPatch).length) {
    try { await properties.applySystemUpdates(wo.propertyId, sysPatch); }
    catch (err) { console.warn("[cascade] system update failed:", err?.message); }
  }

  // 2) Create draft invoice (only when there's something to bill)
  let invoice = null;
  if (lineItems.length) {
    try {
      invoice = await invoices.createDraft({
        woId: wo.id,
        quoteId: wo.onSiteQuote?.quoteId || null,
        propertyId: wo.propertyId,
        customerName: wo.customerName || "",
        customerEmail: wo.customerEmail || "",
        customerPhone: wo.customerPhone || "",
        address: wo.address || "",
        lineItems,
        notes: wo.techNotes ? wo.techNotes.slice(0, 500) : ""
      });
    } catch (err) { console.warn("[cascade] invoice draft failed:", err?.message); }
  }

  // 3) Append service record on the property
  const serviceRecord = await properties.addServiceRecord(wo.propertyId, {
    woId: wo.id,
    woType: wo.type,
    completedAt,
    techNotes: wo.techNotes || "",
    summary,
    lineItems,
    subtotal: invoice?.subtotal || 0,
    hst: invoice?.hst || 0,
    total: invoice?.total || 0,
    warrantyMonths,
    warrantyExpiresAt,
    invoiceId: invoice?.id || null
  });

  // 4) Notify (admin + customer). Best-effort — failures are logged but
  // don't block the cascade.
  if (deps.notifyAdmin) {
    try { await deps.notifyAdmin({ wo, serviceRecord, invoice }); }
    catch (err) { console.warn("[cascade] admin notify failed:", err?.message); }
  }
  if (deps.notifyCustomer) {
    try { await deps.notifyCustomer({ wo, serviceRecord, invoice }); }
    catch (err) { console.warn("[cascade] customer notify failed:", err?.message); }
  }

  return { ok: true, serviceRecord, invoice, alreadyRan: false };
}

module.exports = { run, summarizeWo, lineItemsFromWo, WARRANTY_MONTHS };
