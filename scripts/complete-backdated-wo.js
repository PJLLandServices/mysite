#!/usr/bin/env node
//
// Back-dated work-order completion — JOB-007 (CRM-11 cleanup).
//
// Completes a stranded (non-terminal) work order with its ACTUAL visit
// date, runs the completion cascade with CUSTOMER NOTIFICATIONS AND THE
// REVIEW-REQUEST SEQUENCE SUPPRESSED, and reports what was created. The
// service record and warranty derive from the actual date; the invoice
// draft is dated today (you're invoicing now for past work) and carries
// a note naming the true completion date.
//
// Usage (one WO per run):
//   node scripts/complete-backdated-wo.js WO-XXXXXXXX 2026-06-01                        (DRY RUN)
//   node scripts/complete-backdated-wo.js WO-XXXXXXXX 2026-06-01 --apply
//   node scripts/complete-backdated-wo.js WO-XXXXXXXX 2026-06-01 --apply --close-only
//
// --close-only (bucket (b): work done, ALREADY invoiced elsewhere):
// completes the WO with the actual date and SKIPS THE CASCADE ENTIRELY —
// no invoice draft, no service record, no warranty entry, nothing sent.
// Property link not required in this mode (nothing fires that needs it).
//
// Dry run prints the WO summary, any EXISTING invoice/service record
// (your duplicate signal — skip those ones individually), and the full
// plan. --apply backs up work-orders.json, invoices.json, and
// properties.json first, to:
//   server/data-backup-<UTC stamp>-backdated-completion/
//
// Refuses: terminal WOs, future dates, dates before the WO existed, and
// WOs with no propertyId (the cascade cannot fire for those — nothing
// would get a service record, invoice, or warranty; fix the link first).

const path = require("node:path");
const fs = require("node:fs/promises");

const ROOT = path.resolve(__dirname, "..");
const DATA = path.join(ROOT, "server", "data");
const workOrders = require(path.join(ROOT, "server", "lib", "work-orders"));
const invoices = require(path.join(ROOT, "server", "lib", "invoices"));
const properties = require(path.join(ROOT, "server", "lib", "properties"));
const cascade = require(path.join(ROOT, "server", "lib", "completion-cascade"));
const { warrantyForWorkOrder } = require(path.join(ROOT, "server", "lib", "warranty"));

const [, , woId, dateArg, ...flags] = process.argv;
const APPLY = flags.includes("--apply") || dateArg === "--apply";
const CLOSE_ONLY = flags.includes("--close-only") || dateArg === "--close-only";

async function main() {
  if (!woId || !dateArg || dateArg.startsWith("--")) {
    console.error("Usage: node scripts/complete-backdated-wo.js WO-XXXXXXXX YYYY-MM-DD [--apply]");
    process.exit(1);
  }
  const ts = Date.parse(dateArg.length === 10 ? `${dateArg}T12:00:00.000Z` : dateArg);
  if (!Number.isFinite(ts)) { console.error(`"${dateArg}" is not a date.`); process.exit(1); }
  const completedAt = new Date(ts).toISOString();

  const wo = await workOrders.get(woId);
  if (!wo) { console.error(`${woId} not found.`); process.exit(1); }

  console.log(`${APPLY ? "APPLY" : "DRY RUN"} — back-dated completion of ${wo.id}`);
  console.log(`  type: ${wo.type} | status: ${wo.status} | customer: ${wo.customerName || wo.customerId || "?"} | property: ${wo.propertyId || "NONE"}`);
  console.log(`  created: ${(wo.createdAt || "").slice(0, 10)} | scheduledFor: ${wo.scheduledFor ? wo.scheduledFor.slice(0, 10) : "(dateless)"}`);
  console.log(`  actual completion date to record: ${completedAt.slice(0, 10)}`);

  const TERMINAL = new Set(["completed", "cancelled", "no_show"]);
  if (TERMINAL.has(wo.status)) { console.error(`  REFUSED: already terminal ("${wo.status}").`); process.exit(1); }
  if (!wo.propertyId && !CLOSE_ONLY) {
    console.error("  REFUSED: no propertyId — the cascade cannot fire (no service record, no invoice, no warranty). Link the WO to its property in the CRM first, or use --close-only if this work is already papered elsewhere.");
    process.exit(1);
  }

  // Duplicate signals — existing paper for this WO.
  const existingInvoices = await invoices.listByWorkOrder(wo.id);
  const existingRecord = await properties.findServiceRecordByWo(wo.propertyId, wo.id);
  if (existingInvoices.length) {
    console.log(`  ⚠ EXISTING invoice(s) for this WO: ${existingInvoices.map((i) => `${i.id} (${i.status}, $${i.total})`).join(", ")}`);
  }
  if (existingRecord) {
    console.log(`  ⚠ EXISTING service record ${existingRecord.id} — the cascade will short-circuit (idempotent) and create nothing new.`);
  }

  if (CLOSE_ONLY) {
    console.log(`  plan (CLOSE-ONLY): complete as of ${completedAt.slice(0, 10)} — NO invoice, NO service record, NO warranty entry. Use when the work is already papered elsewhere.`);
  } else {
  const preview = warrantyForWorkOrder({ ...wo, status: "completed", completedAt });
  console.log(`  plan: complete as of ${completedAt.slice(0, 10)} → service record + warranty ${preview.ok ? `${preview.months}mo, covered until ${preview.expiresAt.slice(0, 10)}` : "(?)"} + invoice draft dated today`);

  // Predict the invoice using createDraft's OWN price rules
  // (overridePrice → originalPrice → price; unitPrice-shaped legacy
  // lines normalize to $0 — surfacing that here is the point of the
  // dry run: a $0 prediction means fix the WO's line items first).
  const lines = (Array.isArray(wo.onSiteQuote?.builderLineItems) && wo.onSiteQuote.builderLineItems.length)
    ? wo.onSiteQuote.builderLineItems
    : (Array.isArray(wo.lineItems) ? wo.lineItems : []);
  let subtotal = 0;
  for (const l of lines) {
    const price = (l.overridePrice != null && Number.isFinite(Number(l.overridePrice)))
      ? Number(l.overridePrice) : Number(l.originalPrice || l.price) || 0;
    subtotal += price * (Number(l.qty) || 1);
    console.log(`    line: ${l.label || l.key || "Line"} × ${Number(l.qty) || 1} @ $${price}`);
  }
  if (!lines.length) console.log("    (no line items — invoice would be $0; add them on the WO first if this visit is billable)");
  else console.log(`    predicted invoice: $${(subtotal * 1.13).toFixed(2)} incl. HST${subtotal === 0 ? "  ⚠ $0 — check the WO's line-item shape before applying" : ""}`);
  }
  console.log("  notifications: customer email SUPPRESSED, review-request SUPPRESSED, no SMS. Nothing is sent.");

  if (!APPLY) {
    console.log("\nDry run — nothing written. Re-run with --apply to commit.");
    return;
  }

  // Backup everything the cascade writes, BEFORE any write.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(ROOT, `server/data-backup-${stamp}-backdated-completion`);
  await fs.mkdir(backupDir, { recursive: true });
  for (const f of ["work-orders.json", "invoices.json", "properties.json"]) {
    try { await fs.copyFile(path.join(DATA, f), path.join(backupDir, f)); } catch (_) { /* absent file — nothing to back up */ }
  }
  console.log(`\n  backup: ${backupDir}`);

  const completed = await workOrders.completeBackdated(wo.id, { completedAt, by: "admin" });
  console.log(`  completed: ${completed.id} | completedAt ${completed.completedAt.slice(0, 10)} | departedAt ${completed.departedAt.slice(0, 10)}`);

  if (CLOSE_ONLY) {
    console.log("  close-only: cascade skipped — no invoice, no service record, nothing sent. Done.");
    return;
  }

  const result = await cascade.run(completed, { suppressReviewRequest: true });
  if (result.alreadyRan) {
    console.log("  cascade: short-circuited on existing service record — nothing new created.");
    return;
  }
  if (result.serviceRecord) {
    console.log(`  service record: ${result.serviceRecord.id} | completedAt ${String(result.serviceRecord.completedAt).slice(0, 10)} | warranty until ${String(result.serviceRecord.warrantyExpiresAt || "").slice(0, 10)}`);
  }
  if (result.invoice) {
    // Stamp the true completion date onto the draft so the paper trail
    // reads correctly ("real work was done" — Patrick, 2026-08-02).
    const note = `Service completed ${completedAt.slice(0, 10)}; invoiced ${new Date().toISOString().slice(0, 10)} (back-dated completion).`;
    try {
      const existing = await invoices.get(result.invoice.id);
      await invoices.update(result.invoice.id, {
        notes: existing.notes ? `${existing.notes}\n${note}` : note,
        by: "admin", note: "back-dated completion note"
      });
    } catch (err) { console.warn("  invoice note append failed (invoice still created):", err?.message); }
    console.log(`  invoice draft: ${result.invoice.id} | $${result.invoice.total} | status ${result.invoice.status} — review + send from the CRM when ready.`);
  } else {
    console.log("  invoice: none created (no billable line items on the WO).");
  }
  console.log("  done. No customer notification was sent.");
}

main().catch((err) => { console.error("complete-backdated-wo failed:", err?.message || err); process.exit(1); });
