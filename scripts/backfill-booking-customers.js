#!/usr/bin/env node
//
// Backfill missing customer records on self-bookings — CLI wrapper.
//
// The candidate-finding + resolution logic lives in
// server/lib/backfill-booking-customers.js and is shared with the
// POST /api/admin/backfill-customers endpoint. This wrapper handles
// only the CLI concerns: leads.json I/O, --apply flag, and output
// formatting.
//
// Modes:
//   node scripts/backfill-booking-customers.js            (DRY RUN)
//   node scripts/backfill-booking-customers.js --apply    (commit writes)
//   npm run backfill-booking-customers
//   npm run backfill-booking-customers:apply
//
// Why: before commit e2715be the POST /api/booking/reserve handler
// created lead + property + booking records but never resolved the
// canonical customer record. Self-bookers were invisible in the
// Customers admin list and couldn't be vCard-downloaded. Concrete
// case: Virginia Lorraine. Almost certainly not the only one.

const path = require("node:path");
const fs = require("node:fs/promises");

// Resolve project root relative to the script so it works from any cwd.
const ROOT = path.resolve(__dirname, "..");
process.chdir(ROOT);

const backfill = require(path.join(ROOT, "server", "lib", "backfill-booking-customers"));

const LEADS_FILE = path.join(ROOT, "server", "data", "leads.json");

async function readLeads() {
  try {
    const raw = await fs.readFile(LEADS_FILE, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
}

async function writeLeads(leads) {
  // Atomic write — tmp file then rename so a crashed write can't
  // half-update.
  const tmp = LEADS_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(leads, null, 2));
  await fs.rename(tmp, LEADS_FILE);
}

async function main() {
  const apply = process.argv.includes("--apply");
  const mode = apply ? "APPLY" : "DRY RUN";

  console.log("backfill-booking-customers — " + mode);
  console.log("─".repeat(60));

  const leads = await readLeads();
  if (!Array.isArray(leads)) {
    console.error("leads.json did not parse as an array. Aborting.");
    process.exit(1);
  }

  console.log(`Total leads in store: ${leads.length}`);

  const result = await backfill.runBackfill({ leads, apply });

  if (!result.ok) {
    console.error("Backfill failed:", result.error || "(unknown)");
    process.exit(1);
  }

  if (result.dryRun) {
    console.log(`Leads to backfill: ${result.total}${result.truncated ? ` (showing first ${result.processed} — cap)` : ""}`);
    console.log("");
    if (result.candidates.length === 0) {
      console.log("Nothing to do.");
      return;
    }
    console.log("Candidates:");
    for (const c of result.candidates) {
      const name = (c.name || "(no name)").padEnd(28).slice(0, 28);
      const email = (c.email || "(no email)").padEnd(36).slice(0, 36);
      const phone = c.phone || "(no phone)";
      console.log(`  ${c.leadId}  |  ${name}  |  ${email}  |  ${phone}`);
    }
    console.log("");
    console.log("Dry run — no writes. Re-run with --apply to commit.");
    return;
  }

  // APPLY: lib mutated leads array in-place. Log + write back.
  for (const c of result.created) {
    console.log(`  [created] ${c.leadId} → ${c.customerId}`);
  }
  for (const m of result.matched) {
    console.log(`  [matched] ${m.leadId} → ${m.customerId}`);
  }
  for (const f of result.failed) {
    console.error(`  [error]   ${f.leadId}: ${f.error}`);
  }

  if (result.created.length + result.matched.length > 0) {
    await writeLeads(leads);
  }

  console.log("");
  console.log("─".repeat(60));
  console.log(`Created: ${result.created.length}`);
  console.log(`Matched: ${result.matched.length}`);
  console.log(`Failed:  ${result.failed.length}`);
  console.log(`leads.json updated with ${result.created.length + result.matched.length} new customerId stamps.`);
  if (result.truncated) {
    console.log(`Truncated at ${result.processed} — ${result.total - result.processed} more candidates remain. Re-run to continue.`);
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
