#!/usr/bin/env node
// scripts/purge-test-data.mjs — the delete bot.
//
// Patrick, 2026-09-08: "can you build a delete bot that deletes all these
// booked appointments, and everything that they have created? (Properties,
// Customers, Work orders and Invoices.)"
//
// This script holds NO delete logic of its own. It logs in and calls
// POST /api/admin/purge-test-data, which is the single tested definition of
// what a load-test record is and what is safe to remove — see
// scripts/test-purge-test-data.mjs (26 assertions). Two copies of that rule
// would drift, and the one that drifts deletes a real customer.
//
// WHAT IT REMOVES
//   Every lead whose name or notes carry the marker (default "PJLTEST-"),
//   and everything anchored to those leads: bookings, work orders, invoices,
//   quotes, projects, plus the customer and property each lead created.
//
// WHAT IT WILL NOT REMOVE
//   A customer or property that ANY unmarked lead still points at. If the
//   bot booked against somebody real, the booking goes and the person stays.
//   A booking with no lead behind it is left for a human — nothing marks it.
//
// HOW TO RUN
//   Dry run (default — deletes nothing, prints what it would take):
//     PJL_ADMIN_EMAIL=you@... PJL_ADMIN_PASSWORD=... node scripts/purge-test-data.mjs
//
//   For real, once the dry run looks right:
//     ... node scripts/purge-test-data.mjs --confirm
//
//   Options:
//     --marker=PJLTEST-           what marks a bot record (min 4 chars)
//     --base=https://...          server to hit (default $PJL_BASE_URL or production)
//     --confirm                   actually delete
//
// The dry run is the default on purpose. Run it, read the counts, then
// re-run with --confirm.

const args = process.argv.slice(2);
const flag = (name, fallback = "") => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
};

const BASE = (flag("base", process.env.PJL_BASE_URL || "https://pjllandservices.com")).replace(/\/+$/, "");
const MARKER = flag("marker", "PJLTEST-");
const LIVE = args.includes("--confirm");
const EMAIL = process.env.PJL_ADMIN_EMAIL || "";
const PASSWORD = process.env.PJL_ADMIN_PASSWORD || "";

if (!EMAIL || !PASSWORD) {
  console.error("Set PJL_ADMIN_EMAIL and PJL_ADMIN_PASSWORD before running.");
  console.error("  PJL_ADMIN_EMAIL=you@pjllandservices.com PJL_ADMIN_PASSWORD='...' node scripts/purge-test-data.mjs");
  process.exit(2);
}

// Say what we are about to touch BEFORE touching it — same rule as
// find-test-leads.js. A count with no address on it is ambiguous.
console.log(`server : ${BASE}`);
console.log(`marker : ${MARKER}`);
console.log(`mode   : ${LIVE ? "LIVE — records will be deleted" : "dry run — nothing will be deleted"}`);
console.log("");

const login = await fetch(`${BASE}/api/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: EMAIL, password: PASSWORD })
});
if (!login.ok) {
  console.error(`login failed (${login.status}). Check the email and password.`);
  process.exit(1);
}
const cookie = (login.headers.get("set-cookie") || "").split(";")[0];
if (!cookie) {
  console.error("login returned no session cookie — cannot continue.");
  process.exit(1);
}

const res = await fetch(`${BASE}/api/admin/purge-test-data`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie },
  body: JSON.stringify({ marker: MARKER, ...(LIVE ? { confirm: "PURGE TEST DATA" } : {}) })
});
const body = await res.json().catch(() => ({}));

if (!res.ok || body.ok !== true) {
  console.error(`purge refused (${res.status}): ${(body.errors || ["unknown error"]).join("; ")}`);
  process.exit(1);
}

const counts = body.counts || {};
const total = Object.values(counts).reduce((a, b) => a + b, 0);
if (!total) {
  console.log("Nothing matches the marker. There is nothing to delete.");
  process.exit(0);
}

const LABELS = {
  leads: "appointments / leads", bookings: "bookings", "work-orders": "work orders",
  invoices: "invoices", quotes: "quotes", projects: "projects",
  customers: "customers", properties: "properties"
};
console.log(body.dryRun ? "Would remove:" : "Removed:");
for (const [key, n] of Object.entries(counts)) {
  if (n) console.log(`  ${String(n).padStart(4)}  ${LABELS[key] || key}`);
}

if (body.dryRun) {
  if (Array.isArray(body.sample) && body.sample.length) {
    console.log("\nFirst few, to check they are the bot's and not yours:");
    for (const s of body.sample) {
      console.log(`  ${s.name || "(no name)"} — ${s.address || "no address"}${s.when ? ` — ${s.when}` : ""}`);
    }
  }
  console.log("\nNothing was deleted. If that list is right, run it again with --confirm:");
  console.log("  node scripts/purge-test-data.mjs --confirm");
} else {
  console.log("\nDone. Reload the season plan — those days should be clear.");
}
