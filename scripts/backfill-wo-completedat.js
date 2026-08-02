#!/usr/bin/env node
//
// Backfill completedAt on completed work orders — JOB-002 Part A, Task A2.
//
// Before this job, completedAt did not exist as a field; the only reliable
// completion timestamp was the server-stamped status_change entry in
// wo.history[]. This script promotes that timestamp into the new
// first-class completedAt field for every completed work order that lacks
// one. Rule (per the job spec): take the EARLIEST history entry where
// action === "status_change" and after === "completed", and write its ts.
// Nothing else on the record is touched.
//
// Modes:
//   node scripts/backfill-wo-completedat.js            (DRY RUN — prints the
//                                                       before/after list,
//                                                       writes nothing)
//   node scripts/backfill-wo-completedat.js --apply    (backs up
//                                                       work-orders.json,
//                                                       then writes)
//
// The backup is written BEFORE any write, to:
//   server/data-backup-<UTC stamp>-wo-completedat/work-orders.json
// (server/data-backup-*/ is gitignored, same as the customer-migration
// backups.)
//
// Records whose history has no completion entry are reported as
// UNRECOVERABLE and skipped — never guessed. Run on Render (where the live
// data lives): dry-run first, read the list, then --apply.

const path = require("node:path");
const fs = require("node:fs/promises");

const ROOT = path.resolve(__dirname, "..");
const WO_FILE = path.join(ROOT, "server", "data", "work-orders.json");
const APPLY = process.argv.includes("--apply");

function completionTsFromHistory(wo) {
  const entries = (Array.isArray(wo.history) ? wo.history : [])
    .filter((h) => h && h.action === "status_change" && h.after === "completed" && typeof h.ts === "string")
    .sort((a, b) => a.ts.localeCompare(b.ts));
  return entries.length ? entries[0].ts : null;
}

async function main() {
  let raw;
  try {
    raw = await fs.readFile(WO_FILE, "utf8");
  } catch (err) {
    console.error(`Cannot read ${WO_FILE}: ${err.message}`);
    process.exit(1);
  }
  const records = JSON.parse(raw || "[]");

  const completed = records.filter((w) => w.status === "completed");
  const alreadyStamped = completed.filter((w) => typeof w.completedAt === "string" && w.completedAt);
  const candidates = completed.filter((w) => !(typeof w.completedAt === "string" && w.completedAt));

  const toWrite = [];
  const unrecoverable = [];
  for (const wo of candidates) {
    const ts = completionTsFromHistory(wo);
    if (ts) toWrite.push({ wo, ts });
    else unrecoverable.push(wo);
  }

  console.log(`${APPLY ? "APPLY" : "DRY RUN"} — backfill completedAt from history`);
  console.log(`total records: ${records.length} | completed: ${completed.length} | already have completedAt: ${alreadyStamped.length}`);
  console.log(`to backfill: ${toWrite.length} | unrecoverable (no history completion entry): ${unrecoverable.length}`);
  console.log("");
  console.log("Before/after list (completedAt was null on every row):");
  for (const { wo, ts } of toWrite) {
    const deleted = wo.deletedAt ? " [soft-deleted]" : "";
    console.log(`  ${wo.id} | type: ${wo.type || "(missing)"} | completedAt: null -> ${ts}${deleted}`);
  }
  for (const wo of unrecoverable) {
    console.log(`  ${wo.id} | type: ${wo.type || "(missing)"} | UNRECOVERABLE — skipped (no status_change->completed in history)`);
  }

  if (!APPLY) {
    console.log("\nDry run — nothing written. Re-run with --apply to commit.");
    return;
  }
  if (!toWrite.length) {
    console.log("\nNothing to write.");
    return;
  }

  // Backup BEFORE writing. Timestamped dir so repeated runs never clobber.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir = path.join(ROOT, `server/data-backup-${stamp}-wo-completedat`);
  await fs.mkdir(backupDir, { recursive: true });
  const backupFile = path.join(backupDir, "work-orders.json");
  await fs.writeFile(backupFile, raw, "utf8");
  console.log(`\nBackup written: ${backupFile}`);

  for (const { wo, ts } of toWrite) {
    wo.completedAt = ts;
  }
  // Same serialization as work-orders.js writeAll() — 2-space indent,
  // trailing newline — so the diff against the backup is only the new keys.
  await fs.writeFile(WO_FILE, JSON.stringify(records, null, 2) + "\n", "utf8");
  console.log(`Wrote ${toWrite.length} record(s) to ${WO_FILE}.`);
  console.log("Re-run the count check: all completed work orders should now have completedAt.");
}

main().catch((err) => {
  console.error("backfill-wo-completedat failed:", err);
  process.exit(1);
});
