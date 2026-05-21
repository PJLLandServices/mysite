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
const woReportSnapshot = require("./wo-report-snapshot");

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

  // Brief 2 — build-mode WOs short-circuit. Each calendar day in a
  // multi-day project completes individually for tracking, but the
  // invoice / customer email / warranty / service record only fire on
  // project completion (see runProjectFinalCascade below). The WO's
  // history still gets the cascade_fire breadcrumb so audit trail is
  // intact.
  if (wo.type === "build") {
    try {
      await workOrders.appendHistory(wo.id, {
        action: "cascade_fire",
        by: "system",
        note: "build_short_circuit — invoice + service record + warranty deferred to project completion"
      });
    } catch (err) { console.warn("[cascade] build short-circuit history failed:", err?.message); }
    return {
      ok: true,
      mode: "build_short_circuit",
      serviceRecord: null,
      invoice: null,
      alreadyRan: false
    };
  }

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
  //
  // Disclaimer attachment
  // (feature-per-property-seasonal-pricing-brief.md §3.8). A
  // fall_closing WO completing on a property flagged with
  // seasonalPricing.hasAdditionalFallBlowout carries the
  // `fall_additional_plumbing` disclaimer key. Resolved against the
  // LIVE property record so it tracks Patrick's current intent even
  // when the WO was seeded before the toggle was flipped. Idempotent
  // via Set semantics in invoices.update / hydrate.
  const disclaimers = [];
  if (wo.type === "fall_closing") {
    try {
      const liveProperty = await properties.get(wo.propertyId);
      if (liveProperty?.seasonalPricing?.hasAdditionalFallBlowout === true) {
        disclaimers.push("fall_additional_plumbing");
      }
    } catch (err) { console.warn("[cascade] disclaimer property fetch failed:", err?.message); }
  }
  let invoice = null;
  let invoiceDraftError = null;
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
        paidOnSiteAtCompletion: wo.paidOnSite === true,
        disclaimers
      });
    } catch (err) {
      invoiceDraftError = err?.message || "createDraft threw";
      console.warn("[cascade] invoice draft failed:", invoiceDraftError);
    }
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

  // 3b) Service / Inspection Report PDF snapshot (Service Report brief,
  // 2026-05-19). Gated by wo.completionReportSnapshotAt for idempotency:
  // re-firing the cascade reuses the existing snapshot instead of
  // generating a duplicate. Failures here do NOT mark the stamp — the
  // cascade-recovery admin action is the retry path. Snapshot capture
  // also re-reads the WO from disk (via createSnapshot's internal get)
  // so it picks up the propertyEditsApplied state that was just written.
  let reportSnapshot = null;
  let reportSnapshotError = null;
  if (!wo.completionReportSnapshotAt) {
    try {
      reportSnapshot = await woReportSnapshot.createSnapshot({
        woId: wo.id,
        triggerType: "cascade",
        by: "system"
      });
      try {
        await workOrders.update(wo.id, {
          completionReportSnapshotAt: new Date().toISOString()
        });
      } catch (stampErr) {
        // Stamp failure leaves the snapshot record on the WO but
        // doesn't gate re-fires. Next cascade run will look up the
        // most-recent cascade entry via findLatestCascadeSnapshot and
        // skip — same end state.
        console.warn("[cascade] report snapshot stamp failed:", stampErr?.message);
      }
    } catch (err) {
      reportSnapshotError = err?.message || "snapshot threw";
      console.warn("[cascade] report snapshot failed:", reportSnapshotError);
    }
  } else {
    // Re-fire: reuse the existing cascade snapshot so the customer
    // email still carries the attachment (e.g. if the previous run
    // crashed after the snapshot but before the email).
    const refreshedWo = await workOrders.get(wo.id);
    reportSnapshot = woReportSnapshot.findLatestCascadeSnapshot(refreshedWo);
  }

  // 4) Notify (admin + customer). Best-effort — failures are logged but
  // don't block the cascade. The report snapshot, when produced, is
  // forwarded so the customer email can attach the frozen PDF.
  if (deps.notifyAdmin) {
    try { await deps.notifyAdmin({ wo, serviceRecord, invoice, reportSnapshot }); }
    catch (err) { console.warn("[cascade] admin notify failed:", err?.message); }
  }
  if (deps.notifyCustomer) {
    try { await deps.notifyCustomer({ wo, serviceRecord, invoice, reportSnapshot }); }
    catch (err) { console.warn("[cascade] customer notify failed:", err?.message); }
  }

  // Audit-trail breadcrumb on the WO. Only logged on real execution
  // (the alreadyRan: true short-circuit above returns before reaching
  // here), so re-firing the cascade on an already-completed WO won't
  // spam the history. Brief A spec.
  try {
    const reportBit = reportSnapshot
      ? ` · report ${reportSnapshot.snapshotId}`
      : (reportSnapshotError ? ` · report snapshot failed: ${reportSnapshotError}` : "");
    await workOrders.appendHistory(wo.id, {
      action: "cascade_fire",
      by: "system",
      note: (invoice
        ? `Service record + draft invoice ${invoice.id} ($${Number(invoice.total).toFixed(2)})`
        : (lineItems.length ? `Service record (invoice draft failed: ${invoiceDraftError || "unknown"})` : "Service record (no charge)")
      ) + reportBit
    });
  } catch (err) { console.warn("[cascade] history append failed:", err?.message); }

  // Parity with the manual /create-invoice endpoint: when the cascade
  // produces a draft, stamp `invoice_drafted` too so the WO history
  // viewer surfaces a dedicated entry per spec acceptance criteria.
  if (invoice) {
    try {
      await workOrders.appendHistory(wo.id, {
        action: "invoice_drafted",
        by: "system",
        note: `Cascade: ${invoice.id} ($${Number(invoice.total).toFixed(2)})`
      });
    } catch (err) { console.warn("[cascade] invoice_drafted history failed:", err?.message); }
  }

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

  return { ok: true, serviceRecord, invoice, alreadyRan: false, propertyEditsApplied, invoiceDraftError, reportSnapshot, reportSnapshotError };
}

// ---- Brief 2: Project-final cascade --------------------------------
//
// Runs when an admin presses "Complete project" on a multi-day build
// project. This is the single cascade fire for the entire project —
// the per-day build WOs short-circuited above. Generates:
//
//   1. Final invoice — T&M (rolled up from sessions + materials) or
//      fixed-price (mirrored from proposalSnapshot.lineItems).
//   2. Property service record summarising the project.
//   3. Customer email with invoice attached.
//   4. Admin email with project summary.
//   5. Warranty stamp on project completion date (36 months for install
//      tier — builds are installs).
//
// Idempotent — called by projects.completeProject(), which gates re-runs
// via project.projectCompletionAt. This function is safe to call again
// (returns the existing invoice) but the gate is the canonical guard.

async function runProjectFinalCascade(project, { by = "admin", deps = {} } = {}) {
  if (!project || !project.id) {
    return { ok: false, errors: ["No project."] };
  }

  // Idempotent: if the project already has a final invoice ID, return it.
  if (project.finalInvoiceId) {
    const existing = await invoices.get(project.finalInvoiceId);
    if (existing) {
      return {
        ok: true,
        mode: "project_final",
        invoiceId: existing.id,
        invoice: existing,
        alreadyRan: true
      };
    }
  }

  // Build the line items based on billing mode.
  let lineItems = [];
  let billingNote = "";
  let unknownSkus = [];
  const projects = require("./projects");
  if (project.billingMode === "time_and_material") {
    // Lazy-load parts.json from disk to avoid a load-order coupling with
    // server.js's PARTS global.
    let partsCatalog = null;
    try {
      const fsSync = require("node:fs");
      const path = require("node:path");
      partsCatalog = JSON.parse(fsSync.readFileSync(path.resolve(__dirname, "..", "..", "parts.json"), "utf8"));
    } catch (err) { console.warn("[project-cascade] parts.json read failed:", err?.message); }
    const billing = await projects.computeTAndMBilling(project.id, { partsCatalog });
    lineItems = billing.lineItems.map((li) => ({
      key: li.sourceKey || (li.source === "labour" ? "project_labour" : "custom"),
      label: li.label,
      qty: li.qty,
      price: li.price,
      lineTotal: li.lineTotal
    }));
    unknownSkus = billing.unknownSkus || [];
    billingNote = `T&M: ${billing.totalHours} person-hours @ $${billing.rate}/hr`;
  } else {
    // Fixed-price — mirror the proposal snapshot. If for some reason
    // the snapshot is missing, fall back to the source quote.
    const snap = project.proposalSnapshot;
    if (snap && Array.isArray(snap.lineItems) && snap.lineItems.length) {
      lineItems = snap.lineItems.map((li) => ({
        key: li.sourceKey || "custom",
        label: li.label,
        qty: li.qty,
        price: li.price,
        lineTotal: li.lineTotal
      }));
      billingNote = `Fixed price: from proposal ${snap.quoteId}`;
    } else if (project.sourceQuoteId) {
      try {
        const quotes = require("./quotes");
        const q = await quotes.get(project.sourceQuoteId);
        if (q && Array.isArray(q.lineItems)) {
          lineItems = q.lineItems.map((li) => ({
            key: li.sourceKey || "custom",
            label: li.label,
            qty: li.qty,
            price: li.price,
            lineTotal: li.lineTotal
          }));
          billingNote = `Fixed price: live quote ${q.id}`;
        }
      } catch (err) { console.warn("[project-cascade] sourceQuote read failed:", err?.message); }
    }
  }

  if (unknownSkus.length) {
    return {
      ok: false,
      mode: "project_final",
      errors: [
        `Cannot bill project — these consumed SKUs have no retail price in parts.json: ${unknownSkus.join(", ")}. Set retail prices and retry.`
      ],
      unknownSkus
    };
  }

  // Create the invoice. Project invoices skip the WO linkage — invoice
  // links back to the project via sourceProjectId instead.
  const completedAt = new Date().toISOString();
  let invoice = null;
  let invoiceDraftError = null;
  if (lineItems.length) {
    try {
      invoice = await invoices.createDraft({
        woId: project.finalWoId || null,
        quoteId: project.sourceQuoteId || null,
        projectId: project.id,
        propertyId: project.propertyId,
        customerId: project.customerId || null,
        customerName: project.customerName || "",
        customerEmail: project.customerEmail || "",
        customerPhone: project.customerPhone || "",
        address: project.address || "",
        lineItems,
        notes: `Project ${project.id} — ${billingNote}`,
        paidOnSiteAtCompletion: false,
        disclaimers: []
      });
    } catch (err) {
      invoiceDraftError = err?.message || "createDraft threw";
      console.warn("[project-cascade] invoice draft failed:", invoiceDraftError);
    }
  }

  // Service record on the property.
  let serviceRecord = null;
  if (project.propertyId) {
    try {
      serviceRecord = await properties.addServiceRecord(project.propertyId, {
        woId: project.finalWoId || null,
        woType: "build",
        projectId: project.id,
        completedAt,
        techNotes: `Project ${project.id} completed — ${billingNote}`,
        summary: `Project completion — ${project.name || project.id}`,
        lineItems,
        subtotal: invoice?.subtotal || 0,
        hst: invoice?.hst || 0,
        total: invoice?.total || 0,
        warrantyMonths: WARRANTY_MONTHS.install,
        warrantyExpiresAt: addMonths(completedAt, WARRANTY_MONTHS.install),
        invoiceId: invoice?.id || null
      });
    } catch (err) {
      console.warn("[project-cascade] service record failed:", err?.message);
    }
  }

  // Notifications — best-effort.
  if (deps.notifyAdmin) {
    try { await deps.notifyAdmin({ project, invoice, serviceRecord, mode: "project_final" }); }
    catch (err) { console.warn("[project-cascade] admin notify failed:", err?.message); }
  }
  if (deps.notifyCustomer) {
    try { await deps.notifyCustomer({ project, invoice, serviceRecord, mode: "project_final" }); }
    catch (err) { console.warn("[project-cascade] customer notify failed:", err?.message); }
  }

  return {
    ok: true,
    mode: "project_final",
    invoiceId: invoice?.id || null,
    invoice,
    serviceRecord,
    propertyEditsApplied: false,
    invoiceDraftError,
    billingNote
  };
}

module.exports = { run, runProjectFinalCascade, summarizeWo, lineItemsFromWo, computePropertyEdits, WARRANTY_MONTHS };
