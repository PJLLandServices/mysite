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

// Warranty months + month arithmetic now live in lib/warranty.js (JOB-002
// Part A) — the single authoritative policy table, shared with the
// warrantyForWorkOrder() helper so the snapshot written here and any
// later computation can never drift. Values are unchanged: 12mo for
// service_visit / spring_opening / fall_closing, 36mo for installs.
const { WARRANTY_MONTHS, addMonths } = require("./warranty");

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

  // JOB-007 (CRM-11): honour the WO's own completion stamp. On the
  // normal path completedAt was server-stamped by workOrders.update()
  // milliseconds before this runs (JOB-002 Part A), so this is a no-op;
  // on a BACK-DATED completion the service record and warranty derive
  // from the actual visit date, not the day the record was closed out.
  const completedAt = wo.completedAt || new Date().toISOString();
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

  // 5) Schedule the customer invoice-ready SMS (Invoice SMS brief, May
  // 2026). Fires ~delayMinutes after this cascade runs, pointing the
  // customer at the portal-invoice view (which mirrors the invoice and
  // re-exposes the QB payment link). Gated by:
  //   - invoice exists with paidOnSiteAtCompletion === false
  //   - settings.invoiceSms.enabled !== false
  //   - customer SMS allowed (notificationPrefs.textReminders !== false)
  //   - customer has a phone on the invoice snapshot
  //
  // Idempotent — if customerSmsSentAt is set (sweep already fired) or
  // customerSmsScheduledAt is already in the future, this skips. The
  // setTimeout is the primary fire path; sweepPendingInvoiceSMS catches
  // sends lost to a server restart. Best-effort: failures here log and
  // continue (the cascade itself doesn't depend on the SMS).
  // deps.skipInvoiceSms — re-draft escape hatch. When an invoice has to be
  // re-cut for a bookkeeping correction (mispriced line, voided original),
  // the customer has usually already been told what's coming, or hasn't been
  // contacted at all and shouldn't be by a re-run. There was previously no
  // way to suppress this: the settings gate (invoiceSms.enabled) has no
  // writer, clearing customerSmsScheduledAt only stops the sweep and not the
  // in-process timer, and sendInvoiceReadySMS aborts only on
  // sent/void/paid — so a re-draft always texted the customer.
  if (invoice && invoice.paidOnSiteAtCompletion === false && !deps.skipInvoiceSms) {
    try {
      const settingsLib = require("./settings");
      const notifyCustomer = require("./notify-customer");
      const settings = await settingsLib.get();
      if (settings?.invoiceSms?.enabled !== false) {
        // Re-fetch the invoice so we see the latest customerSmsSentAt /
        // customerSmsScheduledAt — a prior cascade re-fire may have
        // already scheduled.
        const freshInv = await invoices.get(invoice.id);
        if (freshInv && !freshInv.customerSmsSentAt && !freshInv.customerSmsScheduledAt) {
          let smsAllowed = true;
          let skipReason = null;
          if (freshInv.customerId) {
            try {
              const customers = require("./customers");
              const cust = await customers.get(freshInv.customerId);
              if (cust && cust?.notificationPrefs?.textReminders === false) {
                smsAllowed = false;
                skipReason = "customer_sms_skipped_opted_out";
              }
            } catch (_err) { /* tolerate missing customer record */ }
          }
          if (smsAllowed && !String(freshInv.customerPhone || "").trim()) {
            smsAllowed = false;
            skipReason = "customer_sms_skipped_no_phone";
          }
          if (!smsAllowed) {
            try {
              await invoices.appendHistory(freshInv.id, {
                action: skipReason,
                by: "system",
                note: skipReason === "customer_sms_skipped_opted_out"
                  ? "Customer opted out of text reminders"
                  : "No customer phone on invoice"
              });
            } catch (logErr) { console.warn("[cascade] SMS skip history failed:", logErr?.message); }
          } else {
            const delayMinutes = Number.isFinite(Number(settings.invoiceSms?.delayMinutes))
              ? Number(settings.invoiceSms.delayMinutes)
              : 5;
            const delayMs = Math.max(0, delayMinutes * 60 * 1000);
            const scheduledAt = new Date(Date.now() + delayMs).toISOString();
            // Mint the portal token at schedule time so the SMS body
            // (read at send time) has a token to embed.
            try { await invoices.ensurePortalToken(freshInv.id); }
            catch (tokErr) { console.warn("[cascade] portalToken mint failed:", tokErr?.message); }
            await invoices.update(freshInv.id, { customerSmsScheduledAt: scheduledAt });
            try {
              await invoices.appendHistory(freshInv.id, {
                action: "customer_sms_scheduled",
                by: "system",
                note: `Scheduled for ${scheduledAt} (delay ${delayMinutes}m)`
              });
            } catch (logErr) { console.warn("[cascade] SMS schedule history failed:", logErr?.message); }
            // Primary fire path. unref() so a long delay doesn't keep
            // the Node process alive if everything else shut down.
            const timer = setTimeout(() => {
              notifyCustomer.sendInvoiceReadySMS({ invoiceId: freshInv.id })
                .catch((err) => console.warn("[cascade] sendInvoiceReadySMS failed:", err?.message));
            }, delayMs);
            if (typeof timer?.unref === "function") timer.unref();
          }
        }
      }
    } catch (err) {
      console.warn("[cascade] invoice SMS schedule failed:", err?.message);
    }
  }

  // 6) Enqueue the Google review request sequence (design handoff, Jul
  // 2026). Persisted schedule — email 1 fires ~7 days out via the
  // review-requests sweep in server.js, so nothing is lost to restarts.
  // scheduleForWo carries its own gates (feature enabled, customer
  // email present, per-property opt-out, one-per-customer-per-6-months,
  // idempotent per WO) and never throws into the cascade.
  // deps.suppressReviewRequest (JOB-007): back-dated completions skip
  // the review ask entirely — a review request landing weeks after a
  // months-old visit reads as spam, and anchoring it to the true date
  // would fire it immediately, which is no better.
  if (deps.suppressReviewRequest !== true) try {
    const reviewRequests = require("./review-requests");
    const rr = await reviewRequests.scheduleForWo(wo);
    if (rr?.scheduled) {
      try {
        await workOrders.appendHistory(wo.id, {
          action: "review_request_scheduled",
          by: "system",
          note: `${rr.record.id} — email 1 due ${rr.record.email1.dueAt}`
        });
      } catch (logErr) { console.warn("[cascade] review-request history failed:", logErr?.message); }
    }
  } catch (err) {
    console.warn("[cascade] review-request schedule failed:", err?.message);
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

async function runProjectFinalCascade(project, opts = {}) {
  const by = opts.by || "admin";
  const deps = opts.deps || {};
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

  // Threshold deposit — if the source quote requested a deposit, the
  // completion invoice must account for it: a held balance invoice
  // (created when the deposit was paid) is REUSED as the final invoice,
  // and a T&M rollup gets the deposit shown as a credit line. depositCtx
  // is null for legacy quotes / disabled deposits — zero behaviour change.
  const depositsLib = require("./deposits");
  const depositCtx = await depositsLib.depositContextForQuote(project.sourceQuoteId);

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

  // Gap 1 — roll accepted change-order on_site_quotes into the final
  // invoice. A project's ADDED scope lives as on_site_quotes on its build
  // WOs; the fixed-price / T&M rollup above only covers the base proposal,
  // so those change orders would otherwise never be billed. Merge their
  // lines here, tagged for audit. Double-billing guard: skip any quote
  // already referenced by an existing invoice (via quoteId or a line note).
  // NOTE: covers the standard (non-deposit) final; a deposit-balance final
  // that reuses a held invoice does not pick these up (edge case, flagged).
  const mergedChangeOrders = [];
  try {
    const quotesLib = require("./quotes");
    const allInvoices = await invoices.list();
    const woIds = Array.isArray(project.workOrderIds) ? project.workOrderIds : [];
    const seenQuote = new Set([project.sourceQuoteId].filter(Boolean));
    for (const woId of woIds) {
      const w = await workOrders.get(woId);
      const qid = w && w.onSiteQuote && w.onSiteQuote.quoteId;
      if (!qid || seenQuote.has(qid)) continue;
      seenQuote.add(qid);
      const q = await quotesLib.get(qid);
      if (!q || q.type !== "on_site_quote" || q.status !== "accepted") continue;
      const alreadyBilled = allInvoices.some((inv) =>
        inv.quoteId === qid
        || (Array.isArray(inv.lineItems) && inv.lineItems.some((l) => String(l.note || "").includes(qid))));
      if (alreadyBilled) continue;
      for (const li of (Array.isArray(q.lineItems) ? q.lineItems : [])) {
        lineItems.push({
          key: li.sourceKey || li.key || "custom",
          label: li.label,
          qty: li.qty,
          price: li.price,
          lineTotal: li.lineTotal,
          note: `Change order ${qid}`
        });
      }
      mergedChangeOrders.push(qid);
    }
  } catch (err) { console.warn("[project-cascade] change-order merge failed:", err?.message); }
  if (mergedChangeOrders.length) {
    billingNote = `${billingNote}${billingNote ? " — " : ""}change orders rolled in: ${mergedChangeOrders.join(", ")}`;
  }

  // Gap 3 — resolve bill-to identity robustly. Project fields can be sparse
  // on older records (this drafted with a blank bill-to in the field), so
  // fall back to the property record, then the customer record, so the
  // final invoice never renders an empty "Bill To".
  let billName = project.customerName || "";
  let billEmail = project.customerEmail || "";
  let billPhone = project.customerPhone || "";
  let billAddress = project.address || "";
  try {
    if ((!billName || !billAddress || !billEmail || !billPhone) && project.propertyId) {
      const prop = await properties.get(project.propertyId);
      if (prop) {
        billName = billName || prop.customerName || "";
        billEmail = billEmail || prop.customerEmail || "";
        billPhone = billPhone || prop.customerPhone || "";
        billAddress = billAddress || prop.address || "";
      }
    }
    if ((!billName || !billEmail) && project.customerId) {
      const customersLib = require("./customers");
      const cust = await customersLib.get(project.customerId, { withProperties: false });
      if (cust) {
        billName = billName || cust.name || "";
        billEmail = billEmail || cust.email || "";
        billPhone = billPhone || cust.phone || "";
      }
    }
  } catch (err) { console.warn("[project-cascade] bill-to resolution failed:", err?.message); }

  // Create (or reuse) the invoice. Project invoices skip the WO linkage
  // — invoice links back to the project via sourceProjectId instead.
  const completedAt = new Date().toISOString();
  let invoice = null;
  let invoiceDraftError = null;
  let reusedBalanceInvoice = false;

  // TODO (follow-up): the deposit-balance finals below bill from the quote
  // snapshot / held balance invoice, so they do NOT pick up the change-order
  // rollup merged into `lineItems` above. Known gap, shipped deliberately
  // (no projects are on the deposit path today, but outstanding quotes use
  // it). Until it's closed, emit a loud warning so a silently-unbilled
  // change order shows up in the Render logs instead of surfacing later as
  // a billing hole. Wire the CO lines into the balance invoice to fix.
  const takesDepositBalancePath = Boolean(
    (depositCtx && depositCtx.balanceInvoice && depositCtx.balanceInvoice.status !== "void")
    || (depositCtx && depositCtx.depositInvoice && project.billingMode !== "time_and_material")
  );
  if (takesDepositBalancePath) {
    console.warn(
      `[cascade] Deposit-balance final for project ${project.id} — ` +
      `change-order rollup NOT applied. If accepted on_site_quotes exist ` +
      `on this project's build WOs, they must be billed manually.` +
      (mergedChangeOrders.length
        ? ` DROPPED change orders on this run: ${mergedChangeOrders.join(", ")} — BILL THESE MANUALLY.`
        : "")
    );
  }

  if (depositCtx && depositCtx.balanceInvoice && depositCtx.balanceInvoice.status !== "void") {
    // Deposit was paid earlier → the held balance invoice IS the final
    // invoice. Clear the hold so it becomes sendable; do NOT draft a
    // second invoice (that would double-bill the job).
    try {
      invoice = (await invoices.update(depositCtx.balanceInvoice.id, { holdUntilCompletion: false })) || depositCtx.balanceInvoice;
      reusedBalanceInvoice = true;
      billingNote = `${billingNote}${billingNote ? " — " : ""}balance invoice ${invoice.id} (deposit ${depositCtx.depositInvoice?.id || ""} paid)`;
    } catch (err) {
      invoiceDraftError = err?.message || "balance-invoice reuse failed";
      console.warn("[project-cascade] balance invoice reuse failed:", invoiceDraftError);
    }
  } else if (depositCtx && depositCtx.depositInvoice && project.billingMode !== "time_and_material") {
    // Deposit invoice exists but the balance invoice doesn't yet —
    // either the deposit is still unpaid (admin overrode the preflight
    // blocker) or it settled between preflight and now. Issue the
    // balance invoice from the quote snapshot, deposit shown as paid or
    // as due separately.
    try {
      invoice = await depositsLib.createBalanceInvoice(depositCtx.quote, depositCtx.depositInvoice, {
        depositPaid: depositCtx.depositInvoice.status === "paid",
        projectId: project.id
      });
      invoice = (await invoices.update(invoice.id, { holdUntilCompletion: false })) || invoice;
      billingNote = `${billingNote}${billingNote ? " — " : ""}balance invoice (deposit ${depositCtx.depositInvoice.status === "paid" ? "paid" : "still owing on " + depositCtx.depositInvoice.id})`;
    } catch (err) {
      invoiceDraftError = err?.message || "balance-invoice draft failed";
      console.warn("[project-cascade] balance invoice draft failed:", invoiceDraftError);
    }
  } else if (lineItems.length) {
    // T&M with a deposit: the balance couldn't be known until now, so
    // the deposit rides the rollup as a credit line and this invoice
    // becomes the balance invoice.
    const tAndMDeposit = depositCtx && depositCtx.depositInvoice && project.billingMode === "time_and_material";
    if (tAndMDeposit) {
      const depInv = depositCtx.depositInvoice;
      const paid = depInv.status === "paid";
      lineItems.push({
        key: "deposit_credit",
        label: paid
          ? `Less deposit paid — invoice ${depInv.id}${depInv.paidAt ? ` (paid ${String(depInv.paidAt).slice(0, 10)})` : ""}`
          : `Less deposit — invoice ${depInv.id} (due separately)`,
        qty: 1,
        price: -Number(depInv.subtotal || 0),
        lineTotal: -Number(depInv.subtotal || 0)
      });
    }
    try {
      invoice = await invoices.createDraft({
        woId: project.finalWoId || null,
        quoteId: project.sourceQuoteId || null,
        projectId: project.id,
        propertyId: project.propertyId,
        customerId: project.customerId || null,
        customerName: billName,
        customerEmail: billEmail,
        customerPhone: billPhone,
        address: billAddress,
        lineItems,
        notes: `Project ${project.id} — ${billingNote}`,
        paidOnSiteAtCompletion: false,
        disclaimers: [],
        ...(tAndMDeposit ? {
          invoiceRole: "balance",
          depositMeta: {
            quoteId: depositCtx.quote.id,
            depositInvoiceId: depositCtx.depositInvoice.id,
            depositAmount: Number(depositCtx.depositInvoice.total) || 0,
            depositPaidAt: depositCtx.depositInvoice.paidAt || null,
            grandTotal: Number(depositCtx.deposit?.snapshot?.grandTotal) || Number(depositCtx.quote.total) || 0
          }
        } : {})
      });
    } catch (err) {
      invoiceDraftError = err?.message || "createDraft threw";
      console.warn("[project-cascade] invoice draft failed:", invoiceDraftError);
    }
  }

  // Deposit lifecycle: link the balance invoice + move the stage.
  // awaiting_balance_payment once the deposit is settled; a still-unpaid
  // deposit (override completion) stays awaiting_deposit with both
  // invoices outstanding.
  if (depositCtx && invoice) {
    try {
      const quotesLib = require("./quotes");
      const depositSettled = depositCtx.depositInvoice?.status === "paid";
      await quotesLib.updateDepositLifecycle(depositCtx.quote.id, {
        stage: depositSettled ? "awaiting_balance_payment" : "awaiting_deposit",
        balanceInvoiceId: invoice.id
      }, { note: `Project ${project.id} completed — balance invoice ${invoice.id}${reusedBalanceInvoice ? " released" : " created"}` });
    } catch (err) { console.warn("[project-cascade] deposit lifecycle update failed:", err?.message); }
  }

  // Auto-send the completion invoice when the deposits setting asks for
  // it (applies to balance invoices AND ordinary finals — the setting is
  // off by default, so existing behaviour is unchanged until Patrick
  // opts in). Failure-tolerant: a send hiccup leaves a normal draft.
  if (invoice && invoice.status === "draft" && (await depositsLib.autoSendBalanceEnabled())) {
    try {
      const sent = await depositsLib.sendInvoiceNow(invoice.id);
      if (sent.ok && sent.invoice) invoice = sent.invoice;
      if (sent.warning) console.warn("[project-cascade] auto-send warning:", sent.warning);
    } catch (err) { console.warn("[project-cascade] auto-send failed:", err?.message); }
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

  // ---- Property edits propagation (Brief 2 §3.3 / §3.9) -----------
  // Sweep all build WOs under this project. Each WO's computePropertyEdits()
  // diff against the live property is applied — gated by
  // wo.propertyEditsAppliedAt for per-WO idempotency, and by
  // project.propertyEditsAppliedAt at the project-level guard. New zones
  // installed during the build (e.g., "added drip line in west bed") land
  // with pendingReview:true via applySystemUpdates.
  let propertyEditsApplied = false;
  if (project.propertyId && !project.propertyEditsAppliedAt) {
    try {
      const liveProperty = await properties.get(project.propertyId);
      if (liveProperty) {
        const buildWos = await workOrders.listBuildWosForProject(project.id);
        for (const wo of buildWos) {
          if (wo.propertyEditsAppliedAt) continue;
          const edits = computePropertyEdits(wo, liveProperty);
          if (!edits.hasChanges) continue;
          const sysPatch = {
            zones: [
              ...edits.zoneEdits.map((ze) => {
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
          await properties.applySystemUpdates(project.propertyId, sysPatch);
          await workOrders.update(wo.id, { propertyEditsAppliedAt: new Date().toISOString() });
          propertyEditsApplied = true;
        }
      }
    } catch (err) { console.warn("[project-cascade] property-edits apply failed:", err?.message); }
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
    propertyEditsApplied,
    invoiceDraftError,
    billingNote
  };
}

module.exports = { run, runProjectFinalCascade, summarizeWo, lineItemsFromWo, computePropertyEdits, WARRANTY_MONTHS };
