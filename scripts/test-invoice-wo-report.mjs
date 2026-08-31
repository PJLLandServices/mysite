#!/usr/bin/env node
// scripts/test-invoice-wo-report.mjs
//
// INV-xx — attaching the work-order report to the invoice email.
//
// The invoice already carries an optional accompanying letter that rides
// along as a second PDF. This adds a third: the service report from the
// visit the invoice came from — the same PDF the customer received at
// completion.
//
// What's pinned here:
//
//   1. Off unless ticked. An invoice never grows an attachment on its own,
//      and a tick with no snapshot behind it does not count as on — that
//      combination would send an invoice believed to carry a report that
//      silently carries nothing.
//   2. The selection is a SPECIFIC snapshot id, not "the latest". What
//      gets attached must be the copy that was chosen, even if the work
//      order re-renders afterwards.
//   3. Void blocks the change, matching the letter.
//   4. The attachment is not part of the issued financial document, so it
//      does NOT lock at send — a resend can carry a report the first send
//      didn't.
//
// Isolation: invoices.js resolves its store as `<lib dir>/../data/
// invoices.json`, so the suite runs against a copy in a temp directory and
// can never touch real data. Same pattern as test-customer-delete-trashed.
//
// Run: node scripts/test-invoice-wo-report.mjs  (also in `npm run build:check`)

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed += 1; }
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}
function eq(actual, expected, label) {
  ok(actual === expected, `${label} (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`);
}

// ---- Sandbox ---------------------------------------------------------
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "pjl-invoice-report-"));
fs.mkdirSync(path.join(SANDBOX, "lib"), { recursive: true });
fs.mkdirSync(path.join(SANDBOX, "data"), { recursive: true });
for (const f of fs.readdirSync(path.join(ROOT, "server", "lib"))) {
  const src = path.join(ROOT, "server", "lib", f);
  if (fs.statSync(src).isFile()) fs.copyFileSync(src, path.join(SANDBOX, "lib", f));
}
const require = createRequire(import.meta.url);
const invoices = require(path.join(SANDBOX, "lib", "invoices.js"));
fs.writeFileSync(path.join(SANDBOX, "data", "invoices.json"), "[]\n", "utf8");

const BASE = {
  customerId: "1",
  customerName: "Kristen Holmes",
  customerEmail: "k@example.com",
  address: "90 Oriole Dr, Newmarket, ON L3Y 1A1",
  lineItems: [{ label: "Service call", qty: 1, unitPrice: 180 }]
};

// ---- 1. A fresh invoice carries the field, switched off ---------------
{
  const inv = await invoices.createDraft({ ...BASE, woId: "WO-2026-0100" });
  ok(inv.woReport && typeof inv.woReport === "object", "every invoice carries a woReport block");
  eq(inv.woReport.enabled, false, "it is off on a new invoice");
  eq(inv.woReport.woId, null, "no work order selected yet");
  eq(inv.woReport.snapshotId, null, "no snapshot selected yet");
}

// ---- 2. Enabling requires something to attach ------------------------
{
  const inv = await invoices.createDraft({ ...BASE, woId: "WO-2026-0101" });

  const tickedEmpty = await invoices.update(inv.id, { woReport: { enabled: true } });
  eq(tickedEmpty.woReport.enabled, false,
    "ticked with no snapshot stays OFF — otherwise the invoice claims a report it cannot send");

  const tickedNoSnap = await invoices.update(inv.id, { woReport: { enabled: true, woId: "WO-2026-0101" } });
  eq(tickedNoSnap.woReport.enabled, false, "a work order alone is not enough — a specific copy must be named");

  const real = await invoices.update(inv.id, {
    woReport: { enabled: true, woId: "WO-2026-0101", snapshotId: "snap_abc" }
  });
  eq(real.woReport.enabled, true, "ticked with a snapshot is on");
  eq(real.woReport.woId, "WO-2026-0101", "work order stored");
  eq(real.woReport.snapshotId, "snap_abc", "the chosen snapshot is stored, not 'the latest'");
  ok(typeof real.woReport.updatedAt === "string" && real.woReport.updatedAt,
    "the change is stamped with when");
  eq(real.woReport.updatedBy, "admin", "and with who");
}

// ---- 3. A selection can sit saved without being attached -------------
{
  const inv = await invoices.createDraft({ ...BASE, woId: "WO-2026-0102" });
  const chosen = await invoices.update(inv.id, {
    woReport: { enabled: false, woId: "WO-2026-0102", snapshotId: "snap_xyz" }
  });
  eq(chosen.woReport.enabled, false, "choosing a report is not the same act as deciding to send it");
  eq(chosen.woReport.snapshotId, "snap_xyz", "the choice survives being switched off");

  const reArmed = await invoices.update(inv.id, {
    woReport: { enabled: true, woId: "WO-2026-0102", snapshotId: "snap_xyz" }
  });
  eq(reArmed.woReport.enabled, true, "and can be switched back on without re-choosing");
}

// ---- 4. Sending does not lock it; void does --------------------------
{
  const inv = await invoices.createDraft({ ...BASE, woId: "WO-2026-0103" });
  await invoices.update(inv.id, { status: "sent", sentAt: new Date().toISOString() });

  // A report can legitimately be attached on a resend — same rule the
  // letter follows, for the same reason: neither is part of the issued
  // financial document.
  const afterSend = await invoices.update(inv.id, {
    woReport: { enabled: true, woId: "WO-2026-0103", snapshotId: "snap_after" }
  });
  eq(afterSend.woReport.enabled, true, "a sent invoice can still gain a report for its resend");

  await invoices.update(inv.id, { status: "void", voidReason: "test" });
  let threw = null;
  try {
    await invoices.update(inv.id, { woReport: { enabled: true, woId: "X", snapshotId: "Y" } });
  } catch (err) { threw = err; }
  ok(threw && /void/i.test(threw.message), "a void invoice refuses the change");
}

// ---- 5. Hydration of legacy records ----------------------------------
{
  // Invoices written before this feature have no woReport key at all.
  const file = path.join(SANDBOX, "data", "invoices.json");
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  raw.push({ id: "I-LEGACY", customerId: "1", status: "draft", lineItems: [], history: [] });
  fs.writeFileSync(file, JSON.stringify(raw, null, 2) + "\n", "utf8");
  const legacy = await invoices.get("I-LEGACY");
  ok(legacy.woReport && legacy.woReport.enabled === false,
    "a legacy invoice reads back with the attachment off, not undefined");
}

// ---- 6. The send path attaches the CUSTOMER copy, in the right order --
// Source-level, because proving the email needs a live SMTP transport.
// Two things matter and both are easy to get wrong silently: the audience
// (the internal render carries notes never meant to leave the office) and
// the order Patrick asked for.
{
  const server = fs.readFileSync(path.join(ROOT, "server", "server.js"), "utf8");
  const block = server.slice(server.indexOf("let reportWarning = null;"), server.indexOf("// Build the patch for invoices.update()"));

  ok(/audience:\s*"customer"/.test(block),
    'the invoice attachment reads the snapshot with audience: "customer" — never the internal render');
  ok(/extraAttachments:\s*\[reportAttachment,\s*letterAttachment\]/.test(block),
    "attachment order is report then letter (the invoice PDF leads inside sendInvoiceToCustomer), " +
    "which is Patrick's invoice → report → letter");
  ok(/renderInv\?\.woReport\?\.enabled/.test(block),
    "nothing is attached unless the invoice's own woReport switch is on");
  ok(/reportWarning\s*=/.test(block),
    "a ticked report that cannot be found surfaces a warning rather than sending silently short");
}

fs.rmSync(SANDBOX, { recursive: true, force: true });

console.log(`\ntest-invoice-wo-report: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
