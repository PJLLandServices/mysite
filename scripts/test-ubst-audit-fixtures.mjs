#!/usr/bin/env node
// scripts/test-ubst-audit-fixtures.mjs — T9 (P-PJL-39: PJL-137)
//
// FAIL-FIRST. The read-only reconciliation audit exists, reads a data
// directory, reports every conflict category with counts and ids as JSON and
// as a human summary, writes nothing, and exits non-zero on critical
// conflicts.
//
// The fixture directory holds exactly one of each conflict the inventory
// found in production (docs/UBST_PHASE0_INVENTORY.md §5.8, TRD §11), so the
// expected answer is known before the tool is written:
//
//   duplicate_active            two live Bookings, one property, one day
//   merged_visits               one Booking holding April's and October's WO
//   stale_confirmed             a confirmed Booking whose WO is completed
//   terminal_wo_on_live         (the same record, seen from the WO side)
//   plan_stop_no_booking        a planned stop with no Booking at all
//   plan_stop_deleted_booking   a planned stop whose property was messaged
//                               (outreach touch) but has no Booking — Peter
//   wo_missing_booking_link     a dated property WO no Booking names
//   dangling_wo_id              a Booking naming a WO id that does not exist
//   id_collision                two Bookings sharing an id
//   envelope_disagrees          lead.booking live while the record is cancelled
//   patch_flip                  status changed with no cancelledAt
//   test_record                 a PJLTEST / example.com record in the store
//
// Expected on origin/main @ 305d7e3: 18 of 20 assertions fail (verified
// 2026-10-06): the tool does not exist, so every assertion about it fails;
// the fixture-building assertion and "the audit wrote nothing" pass.
//
// After PJL-133 (Phase 1, the contract): 18 of 20 assertions fail — the rest belong to later phases.
//
// Run: node scripts/test-ubst-audit-fixtures.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
const failures = [];
const ok = (name, cond, detail = "") => { if (cond) { pass += 1; return; } failures.push(`${name}${detail ? ` — ${detail}` : ""}`); };
const j = (v, n = 260) => String(JSON.stringify(v) ?? "(nothing)").slice(0, n);

// ---- The fixture ----------------------------------------------------------
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "pjl-ubst-audit-"));
const at = (d, h) => new Date(`${d}T${String(h).padStart(2, "0")}:00:00`).toISOString();
const prop = (id, code, extra = {}) => ({ id, code, customerName: `Cust ${code}`, customerEmail: `${code.toLowerCase()}@test.local`, customerPhone: "9055550000", address: `${code} Audit Rd, Newmarket, ON`, addressNormalized: `${code.toLowerCase()} audit rd, newmarket, on`, coords: { lat: 44.05, lng: -79.46 }, system: { zones: [{ number: 1 }, { number: 2 }, { number: 3 }, { number: 4 }], zoneCount: null }, seasonalEligibility: { springOpening: true, fallClosing: true }, seasonalOutreach: {}, serviceRecords: [], leadIds: [], workOrderIds: [], ...extra });
const bk = (id, propertyId, date, extra = {}) => ({ id, propertyId, leadId: null, customerName: "x", scheduledFor: at(date, 9), durationMinutes: 30, serviceKey: "fall_close_4z", serviceLabel: "Fall", status: "confirmed", workOrderIds: [], rescheduleCount: 0, createdAt: at("2026-09-01", 9), updatedAt: at("2026-09-01", 9), history: [], ...extra });
const wo = (id, extra = {}) => ({ id, type: "fall_closing", status: "scheduled", leadId: null, propertyId: null, scheduledFor: null, createdAt: at("2026-09-01", 9), updatedAt: at("2026-09-01", 9), zones: [], history: [], ...extra });

const P = {
  dup: prop("p-dup", "P-DUP"), merged: prop("p-merged", "P-MERGED"), stale: prop("p-stale", "P-STALE"),
  nobook: prop("p-nobook", "P-NOBOOK"),
  peter: prop("p-peter", "P-PETER", { seasonalOutreach: { "2026:fall": { touches: [{ ts: at("2026-10-01", 9), type: "assignment", step: 1, channels: ["email", "sms"], messageBatchId: "AS-peter" }], optOutThisSeason: false } } }),
  wolink: prop("p-wolink", "P-WOLINK"), dangling: prop("p-dangling", "P-DANGLING"), collide: prop("p-collide", "P-COLLIDE"),
  envelope: prop("p-envelope", "P-ENVELOPE"), flip: prop("p-flip", "P-FLIP"), test: prop("p-test", "P-TEST", { customerEmail: "pjltest1@example.com", customerName: "PJL- Test1" })
};
const LEAD_ENVELOPE = { id: "lead-envelope", status: "won", contact: { name: "Env Lead", email: "env@test.local", phone: "9055550001", address: "P-ENVELOPE Audit Rd, Newmarket, ON" }, propertyId: "p-envelope", booking: { start: at("2026-10-23", 9), end: at("2026-10-23", 9.5 | 0), serviceKey: "fall_close_4z", serviceLabel: "Fall", workOrder: { id: "WO-ENV1", status: "scheduled" } }, archived: false, crm: { status: "won", activity: [] } };
const BOOKINGS = [
  bk("BK-2026-0101", "p-dup", "2026-10-20"), bk("BK-2026-0102", "p-dup", "2026-10-20"),
  bk("BK-2026-0103", "p-merged", "2026-10-21", { workOrderIds: ["WO-APR1", "WO-OCT1"], createdAt: at("2026-04-01", 9) }),
  bk("BK-2026-0104", "p-stale", "2026-05-05", { workOrderIds: ["WO-STALE1"] }),
  bk("BK-2026-0105", "p-dangling", "2026-10-22", { workOrderIds: ["WO-GONE9"] }),
  bk("BK-2026-0106", "p-collide", "2026-10-26"), bk("BK-2026-0106", "p-collide", "2026-10-27"),
  bk("BK-2026-0107", "p-envelope", "2026-10-23", { leadId: "lead-envelope", status: "cancelled", cancelledAt: at("2026-10-02", 9), workOrderIds: ["WO-ENV1"] }),
  bk("BK-2026-0108", "p-flip", "2026-10-28", { status: "cancelled", history: [{ ts: at("2026-10-02", 9), action: "status:cancelled", by: "admin", note: "" }] }),
  bk("BK-2026-0109", "p-test", "2026-10-29")
];
const WOS = [
  wo("WO-APR1", { type: "spring_opening", status: "completed", propertyId: "p-merged", scheduledFor: at("2026-04-20", 9), completedAt: at("2026-04-20", 10), createdAt: at("2026-04-20", 8) }),
  wo("WO-OCT1", { propertyId: "p-merged", scheduledFor: at("2026-10-21", 9) }),
  wo("WO-STALE1", { type: "service_visit", status: "completed", propertyId: "p-stale", scheduledFor: at("2026-05-05", 9), completedAt: at("2026-05-05", 10), createdAt: at("2026-05-04", 8) }),
  wo("WO-LINK1", { propertyId: "p-wolink", scheduledFor: at("2026-10-30", 9) }),
  wo("WO-ENV1", { leadId: "lead-envelope", propertyId: "p-envelope", scheduledFor: at("2026-10-23", 9) }),
  wo("WO-COL1"), wo("WO-COL1")
];
const PLAN = { "fall-2026": { bucketCap: 5, dayCap: 10, days: {
  "2026-10-20": { label: "A", morning: ["P-DUP", "P-NOBOOK"], afternoon: [] },
  "2026-10-07": { label: "B", morning: ["P-PETER"], afternoon: [] },
  "2026-10-30": { label: "C", morning: ["P-WOLINK"], afternoon: [] }
} } };
fs.writeFileSync(path.join(DIR, "properties.json"), JSON.stringify(Object.values(P), null, 2));
fs.writeFileSync(path.join(DIR, "bookings.json"), JSON.stringify(BOOKINGS, null, 2));
fs.writeFileSync(path.join(DIR, "work-orders.json"), JSON.stringify(WOS, null, 2));
fs.writeFileSync(path.join(DIR, "leads.json"), JSON.stringify([LEAD_ENVELOPE], null, 2));
fs.writeFileSync(path.join(DIR, "season-plans.json"), JSON.stringify(PLAN, null, 2));
const digest = () => crypto.createHash("sha256").update(fs.readdirSync(DIR).sort().map((f) => f + fs.readFileSync(path.join(DIR, f), "utf8")).join("|")).digest("hex");
const before = digest();
ok("fixture: one of each conflict is on disk", BOOKINGS.length === 10 && WOS.length === 7, j({ bookings: BOOKINGS.length, wos: WOS.length }));

// ---- The tool --------------------------------------------------------------
const TOOL = path.join(ROOT, "scripts", "audit-bookings.mjs");
ok("the audit tool exists at scripts/audit-bookings.mjs", fs.existsSync(TOOL), "no such file");

const EXPECT = {
  duplicate_active: ["BK-2026-0101", "BK-2026-0102"],
  merged_visits: ["BK-2026-0103"],
  stale_confirmed: ["BK-2026-0104"],
  terminal_wo_on_live: ["BK-2026-0104"],
  plan_stop_no_booking: ["P-NOBOOK", "P-PETER", "P-WOLINK"],
  plan_stop_deleted_booking: ["P-PETER"],
  wo_missing_booking_link: ["WO-LINK1", "WO-OCT1"],
  dangling_wo_id: ["BK-2026-0105"],
  id_collision: ["BK-2026-0106", "WO-COL1"],
  envelope_disagrees: ["lead-envelope"],
  patch_flip: ["BK-2026-0108"],
  test_record: ["BK-2026-0109"]
};

let report = null;
if (fs.existsSync(TOOL)) {
  const run = spawnSync(process.execPath, [TOOL, "--data", DIR, "--json"], { encoding: "utf8", timeout: 120000 });
  try { report = JSON.parse(run.stdout || "{}"); } catch { report = null; }
  ok("the tool answers with JSON on --json", report && typeof report === "object" && report.categories, (run.stderr || run.stdout || "").slice(0, 300));
  ok("the tool exits non-zero when critical conflicts exist", run.status !== 0, `exit ${run.status}`);
  const human = spawnSync(process.execPath, [TOOL, "--data", DIR], { encoding: "utf8", timeout: 120000 });
  ok("the tool prints a human summary without --json", /conflict|duplicate|Booking/i.test(human.stdout || ""), (human.stdout || "").slice(0, 200));
} else {
  ok("the tool answers with JSON on --json", false, "no tool");
  ok("the tool exits non-zero when critical conflicts exist", false, "no tool");
  ok("the tool prints a human summary without --json", false, "no tool");
}
ok("the audit wrote nothing", digest() === before, "the data directory changed under a read-only audit");

for (const [cat, ids] of Object.entries(EXPECT)) {
  const got = report?.categories?.[cat];
  const gotIds = (got?.ids || []).map(String).sort();
  ok(`category ${cat}: count and ids`, got && got.count === ids.length && JSON.stringify(gotIds) === JSON.stringify([...ids].sort()),
    got ? `count ${got.count}, ids ${j(gotIds)}; expected ${j(ids)}` : "category missing from the report");
}
ok("the report names which conflicts are critical and which are advisory", report && typeof report.critical === "number" && typeof report.advisory === "number", j(report && { critical: report.critical, advisory: report.advisory }));
ok("the report is deterministic: a second run matches the first", (() => {
  if (!fs.existsSync(TOOL) || !report) return false;
  const again = spawnSync(process.execPath, [TOOL, "--data", DIR, "--json"], { encoding: "utf8", timeout: 120000 });
  try { return JSON.stringify(JSON.parse(again.stdout).categories) === JSON.stringify(report.categories); } catch { return false; }
})(), "no report to compare");

fs.rmSync(DIR, { recursive: true, force: true });
console.log(`\ntest-ubst-audit-fixtures: ${pass} passed, ${failures.length} failed`);
if (failures.length) {
  console.log(failures.map((f) => `  FAIL: ${f}`).join("\n"));
  console.log("\n  (fail-first suite: the audit tool is PJL-137's first deliverable; these describe it)");
}
process.exit(failures.length ? 1 : 0);
