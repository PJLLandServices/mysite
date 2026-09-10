// One-time backfill: give already-paid invoices a payment-ledger entry.
//
// The payment ledger (payments[] / amountPaid / balanceDue, Aug 2026)
// landed AFTER a batch of invoices had already been paid — via the QB
// Payments rail, the Stripe rail, e-Transfer, or manual marking. Those
// invoices carry status "paid" but an empty ledger, so the admin
// Payments panel says "Nothing recorded yet — $X owing" directly under
// a Paid badge, and balanceDue derives to the full total.
//
// This script appends ONE ledger payment per such invoice:
//   amount     = invoice total (they are status "paid" — the ledger's
//                overpayment guard also enforces this can't exceed it)
//   method     = "card_qb" when a Stripe or QB charge id exists on the
//                record ("Card" label), else "other" (e-Transfer /
//                cash / manually marked — the true method isn't
//                recoverable from the record, and guessing would be
//                worse than "Other")
//   receivedAt = the invoice's paidAt stamp
//   notes      = provenance: which charge id, and that this is a
//                backfill — so nobody later mistakes it for a
//                hand-recorded payment.
//
// Idempotent: only invoices with an EMPTY ledger are touched, so
// re-running after a partial failure is safe. Dry-run by default;
// pass --apply to write. Matches the migrate-customers.js convention.
//
// Run on the box that owns server/data/invoices.json (Render shell):
//   node scripts/backfill-payment-ledger.js           # preview
//   node scripts/backfill-payment-ledger.js --apply   # write

const invoices = require("../server/lib/invoices");

const APPLY = process.argv.includes("--apply");

(async () => {
  const all = await invoices.list();
  const candidates = all.filter(
    (inv) => inv.status === "paid" && (!Array.isArray(inv.payments) || inv.payments.length === 0)
  );

  if (!candidates.length) {
    console.log("backfill-payment-ledger: nothing to do — every paid invoice already has a ledger entry.");
    return;
  }

  console.log(`backfill-payment-ledger: ${candidates.length} paid invoice(s) with an empty ledger${APPLY ? "" : " (DRY RUN — pass --apply to write)"}:\n`);

  let ok = 0;
  let failed = 0;
  for (const inv of candidates) {
    const chargeRef = inv.stripeChargeId || inv.quickbooksChargeId || null;
    const method = chargeRef ? "card_qb" : "other";
    const receivedAt = inv.paidAt || inv.updatedAt;
    const notes = chargeRef
      ? `Backfilled ledger entry — paid via online card (${chargeRef}) before the payment ledger existed.`
      : "Backfilled ledger entry — invoice was marked paid before the payment ledger existed; original method not recorded.";

    console.log(
      `  ${inv.id}  $${Number(inv.total).toFixed(2)}  ${method === "card_qb" ? "Card" : "Other"}` +
      `  paid ${receivedAt ? receivedAt.slice(0, 10) : "(no date)"}  ${chargeRef || ""}`
    );

    if (!APPLY) continue;
    const result = await invoices.addPayment(inv.id, {
      amount: Number(inv.total),
      method,
      receivedAt,
      notes,
      by: "backfill"
    });
    if (result.ok) {
      ok++;
    } else {
      failed++;
      console.error(`    !! FAILED: ${(result.errors || []).join("; ")}`);
    }
  }

  if (APPLY) {
    console.log(`\nbackfill-payment-ledger: ${ok} written, ${failed} failed.`);
    if (failed) process.exitCode = 1;
  } else {
    console.log("\nDry run only. Re-run with --apply to write these entries.");
  }
})();
