#!/usr/bin/env node
// scripts/test-customer-delete-trashed.mjs
//
// CRM-16 — deleting a customer whose only remaining links are in the Trash.
//
// The referential guard in customers.hardDelete() used to count every
// record carrying the customerId, soft-deleted ones included. A quote
// deleted from the quote folder still sits in quotes.json for its 30-day
// Trash retention, so it kept blocking the customer delete while showing
// nowhere in the CRM — the customer page's own Quotes tab is built from
// quotes.list(), which filters the Trash out. "Linked to 1 quotes" with
// zero quotes visible, and no way forward from that page.
//
// What this suite pins:
//   1. Live links still block (unchanged behaviour), and the refusal
//      reports only the live ones.
//   2. A Trash-only customer is not blocked outright — it comes back as
//      code "trashed_only" listing what is in the Trash, and deletes
//      nothing until the caller confirms.
//   3. purgeTrashed: true deletes the customer AND permanently removes
//      exactly those Trash records — no live record, no other customer's
//      record, and no other customer's Trash record is touched.
//   4. A record restored between the refusal and the confirm is live
//      again and blocks; a purge never removes a record that is no
//      longer in the Trash.
//   5. Stores with no soft-delete (bookings, projects) and invoices
//      (which leave invoices.json entirely when deleted) behave as
//      before: any reference blocks.
//   6. A clean customer with no links at all still deletes.
//
// Isolation: customers.js requires only node builtins + ./billing-parties
// and resolves its store as `<lib dir>/../data/customers.json`, so the
// suite runs against copies in a temp directory and can never touch real
// data. Same pattern as test-wo-completedat.mjs.
//
// Run: node scripts/test-customer-delete-trashed.mjs  (also in `npm run build:check`)

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

// ---- Sandbox ---------------------------------------------------------
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "pjl-customer-delete-"));
fs.mkdirSync(path.join(SANDBOX, "lib"), { recursive: true });
fs.mkdirSync(path.join(SANDBOX, "data"), { recursive: true });
for (const f of ["customers.js", "billing-parties.js"]) {
  fs.copyFileSync(path.join(ROOT, "server", "lib", f), path.join(SANDBOX, "lib", f));
}
const require = createRequire(import.meta.url);
const customers = require(path.join(SANDBOX, "lib", "customers.js"));
const DATA = path.join(SANDBOX, "data");

function writeStore(name, records) {
  fs.writeFileSync(path.join(DATA, `${name}.json`), JSON.stringify(records, null, 2) + "\n", "utf8");
}
function readStore(name) {
  const p = path.join(DATA, `${name}.json`);
  if (!fs.existsSync(p)) return [];
  return JSON.parse(fs.readFileSync(p, "utf8") || "[]");
}
function ids(records) {
  return records.map((r) => r.id).sort();
}

// Two customers every time: the one under test and a bystander whose
// records must survive intact.
async function seed() {
  for (const store of ["leads", "properties", "bookings", "work-orders", "quotes", "invoices", "projects"]) {
    writeStore(store, []);
  }
  writeStore("customers", []);
  const target = await customers.create({ name: "Vivian G", email: "vivian@example.com" });
  const bystander = await customers.create({ name: "Other Person", email: "other@example.com" });
  return { target, bystander };
}

const TRASHED = "2026-08-20T12:00:00.000Z";

// 1. A live quote blocks, exactly as before.
{
  const { target } = await seed();
  writeStore("quotes", [{ id: "Q-LIVE", customerId: target.id, deletedAt: null }]);
  const res = await customers.hardDelete(target.id);
  ok(res.ok === false, "live quote blocks the delete");
  ok(res.code === "linked", "live link reports code 'linked'");
  ok(JSON.stringify(res.references) === JSON.stringify({ quotes: ["Q-LIVE"] }), "refusal names the live quote");
  ok(res.trashed === undefined, "no trashed key when nothing is in the Trash");
  ok(readStore("customers").length === 2, "blocked delete removed no customer");
}

// 1b. With both a live and a trashed quote, only the live one is reported
//     as the blocker — the Trash record is noted separately, never as the
//     thing the operator has to go clear.
{
  const { target } = await seed();
  writeStore("quotes", [
    { id: "Q-LIVE", customerId: target.id, deletedAt: null },
    { id: "Q-TRASH", customerId: target.id, deletedAt: TRASHED }
  ]);
  const res = await customers.hardDelete(target.id);
  ok(res.code === "linked", "live + trashed still blocks on the live one");
  ok(JSON.stringify(res.references) === JSON.stringify({ quotes: ["Q-LIVE"] }), "references lists the live quote only");
  ok(JSON.stringify(res.trashed) === JSON.stringify({ quotes: ["Q-TRASH"] }), "trashed reported separately");
  ok(readStore("quotes").length === 2, "blocked delete purged nothing");
}

// 2. Trash-only — the Vivian G case. Refused pending confirmation, and
//    nothing is deleted by the refusal itself.
{
  const { target } = await seed();
  writeStore("quotes", [{ id: "Q-TRASH", customerId: target.id, deletedAt: TRASHED }]);
  const res = await customers.hardDelete(target.id);
  ok(res.ok === false && res.code === "trashed_only", "trash-only link asks for confirmation, not Merge");
  ok(res.references === undefined, "trash-only refusal carries no live references");
  ok(JSON.stringify(res.trashed) === JSON.stringify({ quotes: ["Q-TRASH"] }), "trash-only refusal names the trashed quote");
  ok(readStore("customers").length === 2, "unconfirmed refusal deleted no customer");
  ok(readStore("quotes").length === 1, "unconfirmed refusal purged no quote");
}

// 3. Confirmed purge — customer and its Trash records go, everything
//    else stays exactly where it was.
{
  const { target, bystander } = await seed();
  writeStore("quotes", [
    { id: "Q-TRASH", customerId: target.id, deletedAt: TRASHED },
    { id: "Q-OTHER-TRASH", customerId: bystander.id, deletedAt: TRASHED },
    { id: "Q-OTHER-LIVE", customerId: bystander.id, deletedAt: null }
  ]);
  writeStore("leads", [
    { id: "L-TRASH", customerId: target.id, deletedAt: TRASHED },
    { id: "L-OTHER", customerId: bystander.id, deletedAt: null }
  ]);
  writeStore("work-orders", [{ id: "WO-TRASH", customerId: target.id, deletedAt: TRASHED }]);
  writeStore("properties", [{ id: "P-OTHER", customerId: bystander.id, deletedAt: null }]);

  const res = await customers.hardDelete(target.id, { purgeTrashed: true });
  ok(res.ok === true, "confirmed trash-only delete succeeds");
  ok(res.customer.id === target.id, "the deleted record comes back");
  ok(JSON.stringify(res.purged) === JSON.stringify({ leads: ["L-TRASH"], "work-orders": ["WO-TRASH"], quotes: ["Q-TRASH"] }),
    "purge report names every store it touched");
  ok(ids(readStore("customers")) .join() === bystander.id, "only the target customer was removed");
  ok(ids(readStore("quotes")).join() === ["Q-OTHER-LIVE", "Q-OTHER-TRASH"].sort().join(), "other customer's quotes untouched, including their Trash");
  ok(ids(readStore("leads")).join() === "L-OTHER", "target's trashed lead purged, bystander's lead kept");
  ok(readStore("work-orders").length === 0, "target's trashed work order purged");
  ok(readStore("properties").length === 1, "bystander's property untouched");
}

// 4. Restored between refusal and confirm — the record is live again, so
//    the confirm must NOT go through and must NOT purge it.
{
  const { target } = await seed();
  writeStore("quotes", [{ id: "Q-TRASH", customerId: target.id, deletedAt: TRASHED }]);
  const first = await customers.hardDelete(target.id);
  ok(first.code === "trashed_only", "first pass sees it in the Trash");
  // Operator restores the quote in another tab before confirming.
  writeStore("quotes", [{ id: "Q-TRASH", customerId: target.id, deletedAt: null }]);
  const second = await customers.hardDelete(target.id, { purgeTrashed: true });
  ok(second.ok === false && second.code === "linked", "a restore between refusal and confirm re-blocks the delete");
  ok(readStore("quotes").length === 1 && readStore("quotes")[0].deletedAt === null, "restored quote survives the confirmed call");
  ok(readStore("customers").length === 2, "restored link keeps the customer");
}

// 5. Stores with no soft-delete still block on any reference.
{
  const { target } = await seed();
  writeStore("bookings", [{ id: "BK-1", customerId: target.id }]);
  const res = await customers.hardDelete(target.id, { purgeTrashed: true });
  ok(res.code === "linked" && JSON.stringify(res.references) === JSON.stringify({ bookings: ["BK-1"] }),
    "booking with no deletedAt field blocks even with purgeTrashed set");
}
{
  const { target } = await seed();
  writeStore("invoices", [{ id: "INV-1", customerId: target.id }]);
  const res = await customers.hardDelete(target.id, { purgeTrashed: true });
  ok(res.code === "linked" && JSON.stringify(res.references) === JSON.stringify({ invoices: ["INV-1"] }),
    "invoice blocks even with purgeTrashed set — money records are never purged this way");
}
{
  const { target } = await seed();
  writeStore("projects", [{ id: "PRJ-1", customerId: target.id }]);
  const res = await customers.hardDelete(target.id, { purgeTrashed: true });
  ok(res.code === "linked", "project blocks even with purgeTrashed set");
}

// 6. Nothing attached at all — unchanged straight-through delete.
{
  const { target, bystander } = await seed();
  const res = await customers.hardDelete(target.id);
  ok(res.ok === true, "customer with no links deletes with one call");
  ok(JSON.stringify(res.purged) === "{}", "nothing purged when nothing was in the Trash");
  ok(ids(readStore("customers")).join() === bystander.id, "only the target went");
}

// 7. Unknown id is still a plain not-found, not a 409 shape.
{
  await seed();
  const res = await customers.hardDelete("CUST-9999");
  ok(res.ok === false && !res.code && /not found/i.test(res.error), "unknown customer returns a bare not-found");
}

// 8. scanCustomerLinks is the same split the refusals are built from.
{
  const { target } = await seed();
  writeStore("quotes", [
    { id: "Q-LIVE", customerId: target.id, deletedAt: null },
    { id: "Q-TRASH", customerId: target.id, deletedAt: TRASHED }
  ]);
  const { live, trashed } = await customers.scanCustomerLinks(target.id);
  ok(JSON.stringify(live) === JSON.stringify({ quotes: ["Q-LIVE"] }), "scan puts the live quote in live");
  ok(JSON.stringify(trashed) === JSON.stringify({ quotes: ["Q-TRASH"] }), "scan puts the trashed quote in trashed");
}

fs.rmSync(SANDBOX, { recursive: true, force: true });

console.log(`\ntest-customer-delete-trashed: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
