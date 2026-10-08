#!/usr/bin/env node
// scripts/audit-bookings.mjs — the read-only booking reconciliation audit
// (P-PJL-39, PJL-137). Reads a data directory, prints the conflicts, writes
// nothing. Repair is a separate mode that does not exist yet.
//
//   node scripts/audit-bookings.mjs                      # server/data
//   node scripts/audit-bookings.mjs --data /path/to/data # another copy
//   node scripts/audit-bookings.mjs --json               # machine-readable
//   node scripts/audit-bookings.mjs --now 2026-10-07     # judge "past" by this day
//
// Exit code: 2 when any CRITICAL conflict exists, 1 on advisory-only, 0 when
// clean — so a gate can tell "fix before cutover" from "note and move on".
//
// The same report is served to a signed-in admin by GET /api/admin/booking-audit
// (and through the PJL Assistant's read_crm), so production is audited where
// its data lives, never by copying it.

process.env.TZ = process.env.TZ || "America/Toronto";

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { runAudit, formatReport } = require(path.join(ROOT, "server", "lib", "booking-audit.js"));

const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i > -1 ? (args[i + 1] || "") : null; };
const DATA = path.resolve(flag("--data") || path.join(ROOT, "server", "data"));
const JSON_OUT = args.includes("--json");
const NOW = flag("--now") ? new Date(`${flag("--now")}T12:00:00`) : new Date();

function readStore(name, fallback) {
  const p = path.join(DATA, `${name}.json`);
  if (!fs.existsSync(p)) return fallback;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); }
  catch (err) {
    // A store that exists but does not parse is a finding in itself; the
    // audit must say so rather than treat it as empty.
    process.stderr.write(`${name}.json is unreadable (${err.message}) — audited as empty; FIX THE FILE FIRST\n`);
    return fallback;
  }
}

const stores = {
  bookings: readStore("bookings", []),
  leads: readStore("leads", []),
  workOrders: readStore("work-orders", []),
  properties: readStore("properties", []),
  seasonPlans: readStore("season-plans", {})
};
const report = runAudit(stores, { now: NOW });
report.dataDir = DATA;

if (JSON_OUT) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
else process.stdout.write(formatReport(report) + "\n");
process.exit(report.critical > 0 ? 2 : (report.advisory > 0 ? 1 : 0));
