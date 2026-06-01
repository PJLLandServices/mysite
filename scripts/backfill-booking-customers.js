#!/usr/bin/env node
//
// Backfill missing customer records on self-bookings.
//
// Why: before commit e2715be the POST /api/booking/reserve handler
// created lead + property + booking records but never resolved the
// canonical customer record. Self-bookers were invisible in the
// Customers admin list and couldn't be vCard-downloaded. Concrete
// case: Virginia Lorraine. Almost certainly not the only one.
//
// What this script does:
//   1. Reads server/data/leads.json
//   2. Filters: lead.booking?.start exists AND lead.customerId is null/undef
//   3. For each match, runs the same customer-resolution as the live
//      handler at server.js:973 — tries to match an existing customer
//      by email then phone, creates a new one if neither matches,
//      stamps customerId back onto the lead, and logs a comm-history
//      entry on the customer record.
//   4. Writes the updated leads.json back.
//
// Modes:
//   node scripts/backfill-booking-customers.js            (DRY RUN by default)
//   node scripts/backfill-booking-customers.js --apply    (commit writes)
//   npm run backfill-booking-customers                    (dry run)
//   npm run backfill-booking-customers -- --apply         (commit writes)
//
// Dry run prints the list of leads that would be touched (id, name,
// email, phone) and exits without writing. --apply does the work and
// prints a summary of created vs matched customers.
//
// Safe to re-run: leads with customerId already set are skipped.
// Customer-resolution itself is match-first, so re-running after a
// partial backfill won't create duplicates.

const path = require("node:path");

// Resolve project root relative to the script so it works from any cwd.
const ROOT = path.resolve(__dirname, "..");
process.chdir(ROOT);

// Require the customers + leads libs directly. They read/write the
// shared JSON store under server/data/.
const customers = require(path.join(ROOT, "server", "lib", "customers"));
const fs = require("node:fs/promises");

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
  // Atomic write — same pattern as server/lib/leads.js. Write to a
  // tmp file then rename so a crashed write can't half-update.
  const tmp = LEADS_FILE + ".tmp";
  await fs.writeFile(tmp, JSON.stringify(leads, null, 2));
  await fs.rename(tmp, LEADS_FILE);
}

// Mirror of resolveCustomerForLead at server/server.js:973 — kept in
// sync deliberately. If the live function changes signature, this
// script needs the same change.
async function resolveCustomerForLead(lead) {
  const contact = lead.contact || {};
  const email = contact.email || "";
  const phone = contact.phone || "";
  let match = null;
  if (email) match = await customers.findByEmail(email);
  if (!match && phone) match = await customers.findByPhone(phone);
  let customerId = match?.id || null;
  let action = match ? "matched" : null;
  if (!customerId) {
    try {
      const created = await customers.create({
        name: contact.name || "",
        email,
        phone,
        source: lead.source || "lead",
        customerSince: lead.createdAt,
        status: "lead"
      }, { by: "backfill-booking-customers", note: `Auto-created from lead ${lead.id} during backfill` });
      customerId = created.id;
      action = "created";
    } catch (err) {
      if (err.code === "DUPLICATE_EMAIL") {
        customerId = err.existingId;
        action = "matched-race";
      } else {
        throw err;
      }
    }
  }
  if (customerId) {
    try {
      await customers.addCommunication(customerId, {
        ts: lead.createdAt,
        source: lead.source || "lead",
        summary: `Backfilled — original ${lead.source || "lead"} intake`,
        notes: contact.notes || "",
        logId: lead.id
      });
    } catch (err) {
      // Best-effort — a failed communication log doesn't invalidate
      // the customerId itself.
      console.warn(`  [warn] addCommunication failed for ${customerId}:`, err?.message || err);
    }
  }
  return { customerId, action };
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

  const candidates = leads.filter((l) => {
    if (!l || typeof l !== "object") return false;
    if (l.customerId) return false; // already resolved
    if (!l.booking || !l.booking.start) return false; // not a self-booking
    return true;
  });

  console.log(`Total leads in store: ${leads.length}`);
  console.log(`Leads to backfill: ${candidates.length}`);
  console.log("");

  if (candidates.length === 0) {
    console.log("Nothing to do.");
    return;
  }

  // Always show the list first — both modes — so the operator sees
  // exactly what's about to happen (in apply mode) or what would happen
  // (in dry-run).
  console.log("Candidates:");
  for (const lead of candidates) {
    const c = lead.contact || {};
    const name = c.name || "(no name)";
    const email = c.email || "(no email)";
    const phone = c.phone || "(no phone)";
    console.log(`  ${lead.id}  |  ${name.padEnd(28).slice(0, 28)}  |  ${email.padEnd(36).slice(0, 36)}  |  ${phone}`);
  }
  console.log("");

  if (!apply) {
    console.log("Dry run — no writes. Re-run with --apply to commit.");
    return;
  }

  // APPLY: resolve each candidate, stamp customerId, accumulate stats.
  let created = 0;
  let matched = 0;
  let failed = 0;
  for (const lead of candidates) {
    try {
      const result = await resolveCustomerForLead(lead);
      if (!result.customerId) {
        console.error(`  [fail] ${lead.id}: resolveCustomerForLead returned null`);
        failed++;
        continue;
      }
      lead.customerId = result.customerId;
      if (result.action === "created") {
        created++;
        console.log(`  [created] ${lead.id} → ${result.customerId}`);
      } else {
        matched++;
        console.log(`  [matched] ${lead.id} → ${result.customerId}`);
      }
    } catch (err) {
      failed++;
      console.error(`  [error]   ${lead.id}: ${err?.message || err}`);
    }
  }

  await writeLeads(leads);

  console.log("");
  console.log("─".repeat(60));
  console.log(`Created: ${created}`);
  console.log(`Matched: ${matched}`);
  console.log(`Failed:  ${failed}`);
  console.log(`leads.json updated with ${created + matched} new customerId stamps.`);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
