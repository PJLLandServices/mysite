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
const workOrders = require("./work-orders");

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

// ---- Property-edits diff (Brief D / spec §10 r3) ----------------------
// Pure function: given the WO's current zone snapshot and the linked
// property's current state, compute what would flow back on completion.
// Used by:
//   - GET /api/work-orders/:id — decorator surfaces this on the WO
//     payload so the tech UI can render a "Will save to property record
//     on completion" preview before signing.
//   - cascade.run() — applies the same diff at completion time, sets
//     propertyEditsAppliedAt for idempotency.
//
// Diff shape: { zoneEdits: [...], newZones: [...], hasChanges: bool }.
// Each zoneEdit: { number, fields: [{ field, before, after }] }.
// newZones: zones present on the WO but missing from the property —
// these get pendingReview: true so Patrick confirms before they merge
// fully (spec §4.3.2: "new zones discovered (flagged for Patrick review)").
function computePropertyEdits(wo, property) {
  const result = { zoneEdits: [], newZones: [], hasChanges: false };
  if (!wo || !property) return result;
  const woZones = Array.isArray(wo.zones) ? wo.zones : [];
  const propZones = Array.isArray(property?.system?.zones) ? property.system.zones : [];
  const propByNum = new Map(propZones.map((z) => [Number(z.number), z]));

  for (const wz of woZones) {
    const num = Number(wz.number);
    if (!Number.isFinite(num) || num <= 0) continue;
    const pz = propByNum.get(num);
    if (!pz) {
      // Zone exists on WO but not on property — "new zone discovered."
      // The new-zone shape mirrors what a property zone looks like so
      // applySystemUpdates can ingest it directly.
      const newZone = {
        number: num,
        label: wz.location || "",
        location: wz.location || "",
        sprinklerTypes: Array.isArray(wz.sprinklerTypes) ? wz.sprinklerTypes.slice() : [],
        coverage: Array.isArray(wz.coverage) ? wz.coverage.slice() : [],
        notes: wz.notes || ""
      };
      // Skip the auto-scaffolded "General service area" placeholder that
      // service_visit WOs always carry — that's not a real zone discovery.
      const isPlaceholder = num === 1 && (newZone.location === "General service area" || newZone.location === "Zone 1") && !newZone.notes && !newZone.sprinklerTypes.length && !newZone.coverage.length;
      if (!isPlaceholder) {
        result.newZones.push(newZone);
        result.hasChanges = true;
      }
      continue;
    }
    // Existing zone — compute per-field diffs. Only fields the tech can
    // edit (location/sprinkler/coverage/notes). Empty WO values do NOT
    // count as "edits" — the tech walked the zone and didn't touch the
    // descriptor; that's not a delete intent.
    const fields = [];
    const woLoc = (wz.location || "").trim();
    const pzLoc = (pz.location || pz.label || "").trim();
    if (woLoc && woLoc !== pzLoc) {
      fields.push({ field: "location", before: pzLoc, after: woLoc });
    }
    const woNotes = (wz.notes || "").trim();
    const pzNotes = (pz.notes || "").trim();
    if (woNotes && woNotes !== pzNotes) {
      fields.push({ field: "notes", before: pzNotes, after: woNotes });
    }
    const woSprinkler = Array.isArray(wz.sprinklerTypes) ? wz.sprinklerTypes.slice().sort() : [];
    const pzSprinkler = Array.isArray(pz.sprinklerTypes) ? pz.sprinklerTypes.slice().sort() : [];
    if (woSprinkler.length && woSprinkler.join(",") !== pzSprinkler.join(",")) {
      fields.push({ field: "sprinklerTypes", before: pzSprinkler, after: woSprinkler });
    }
    const woCoverage = Array.isArray(wz.coverage) ? wz.coverage.slice().sort() : [];
    const pzCoverage = Array.isArray(pz.coverage) ? pz.coverage.slice().sort() : [];
    if (woCoverage.length && woCoverage.join(",") !== pzCoverage.join(",")) {
      fields.push({ field: "coverage", before: pzCoverage, after: woCoverage });
    }
    if (fields.length) {
      result.zoneEdits.push({ number: num, label: pz.location || pz.label || `Zone ${num}`, fields });
      result.hasChanges = true;
    }
  }
  return result;
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

  // 1) Property system updates (Brief D / spec §10 r3). Compute the diff
  // against the LIVE property record (not stored on the WO) so concurrent
  // admin edits to the property are visible. Idempotency: skip the apply
  // if propertyEditsAppliedAt is already set (cascade re-fire safe). New
  // zones land with pendingReview: true via applySystemUpdates.
  let propertyEditsApplied = null;
  if (!wo.propertyEditsAppliedAt) {
    try {
      const liveProperty = await properties.get(wo.propertyId);
      if (liveProperty) {
        const edits = computePropertyEdits(wo, liveProperty);
        if (edits.hasChanges) {
          const sysPatch = {
            zones: [
              ...edits.zoneEdits.map((ze) => {
                // Reconstruct each zone's full state from the WO so
                // applySystemUpdates can ingest it directly.
                const woZone = (wo.zones || []).find((z) => Number(z.number) === Number(ze.number)) || {};
                return {
                  number: ze.number,
                  location: woZone.location || "",
                  sprinklerTypes: Array.isArray(woZone.sprinklerTypes) ? woZone.sprinklerTypes : [],
                  coverage: Array.isArray(woZone.coverage) ? woZone.coverage : [],
                  notes: woZone.notes || ""
                };
              }),
              ...edits.newZones
            ]
          };
          await properties.applySystemUpdates(wo.propertyId, sysPatch);
          propertyEditsApplied = edits;
        }
      }
    } catch (err) { console.warn("[cascade] property-edits apply failed:", err?.message); }
  }

  // 2) Create draft invoice (only when there's something to bill).
  // paidOnSiteAtCompletion is forwarded so the invoice carries the
  // field-payment flag — the customer email + Patrick's invoice editor
  // both reshape on it, but the invoice STAYS in draft status (Patrick
  // reviews before sending or marking paid in QB). Spec §4.3.2.
  let invoice = null;
  if (lineItems.length) {
    try {
      invoice = await invoices.createDraft({
        woId: wo.id,
        quoteId: wo.onSiteQuote?.quoteId || null,
        propertyId: wo.propertyId,
        customerId: wo.customerId || null,
        customerName: wo.customerName || "",
        customerEmail: wo.customerEmail || "",
        customerPhone: wo.customerPhone || "",
        address: wo.address || "",
        lineItems,
        notes: wo.techNotes ? wo.techNotes.slice(0, 500) : "",
        paidOnSiteAtCompletion: wo.paidOnSite === true
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

  // Audit-trail breadcrumb on the WO. Only logged on real execution
  // (the alreadyRan: true short-circuit above returns before reaching
  // here), so re-firing the cascade on an already-completed WO won't
  // spam the history. Brief A spec.
  try {
    await workOrders.appendHistory(wo.id, {
      action: "cascade_fire",
      by: "system",
      note: invoice
        ? `Service record + draft invoice ${invoice.id} ($${Number(invoice.total).toFixed(2)})`
        : "Service record (no charge)"
    });
  } catch (err) { console.warn("[cascade] history append failed:", err?.message); }

  // Property-edits idempotency stamp + history breadcrumb (Brief D).
  // Stamp goes on AFTER the apply succeeds — partial failure leaves the
  // stamp unset, so a cascade re-fire retries.
  if (propertyEditsApplied) {
    try {
      const stamped = await workOrders.update(wo.id, {
        propertyEditsAppliedAt: new Date().toISOString()
      });
      const editCount = propertyEditsApplied.zoneEdits.length + propertyEditsApplied.newZones.length;
      const summary = [
        propertyEditsApplied.zoneEdits.length ? `${propertyEditsApplied.zoneEdits.length} zone edit${propertyEditsApplied.zoneEdits.length === 1 ? "" : "s"}` : null,
        propertyEditsApplied.newZones.length ? `${propertyEditsApplied.newZones.length} new zone${propertyEditsApplied.newZones.length === 1 ? "" : "s"} flagged for review` : null
      ].filter(Boolean).join(", ");
      await workOrders.appendHistory(wo.id, {
        action: "property_edits_applied",
        by: "system",
        note: summary || `${editCount} edit${editCount === 1 ? "" : "s"} applied`
      });
    } catch (err) { console.warn("[cascade] property-edits stamp failed:", err?.message); }
  }

  return { ok: true, serviceRecord, invoice, alreadyRan: false, propertyEditsApplied };
}

module.exports = { run, summarizeWo, lineItemsFromWo, computePropertyEdits, WARRANTY_MONTHS };
