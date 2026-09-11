#!/usr/bin/env node
// scripts/test-appointment-seen.mjs
//
// "How do we track who's seen it?" — Patrick, 2026-09-10.
//
// The cadence could say who was MESSAGED and who ACTED, and nothing in
// between. That gap hides the group most worth chasing: the customers who
// opened their appointment link and didn't answer. A hesitant customer and
// a wrong phone number both looked like silence.
//
// Opening /a/<token> now stamps `outreach.seenAt`, ONCE, on the first
// view — the interesting fact is when they first saw it, not when they
// last refreshed. The count rides the same status line Patrick already
// reads: "N assigned · N messaged · N opened · N responded".
//
// Best-effort by design: a note about a page view must never be able to
// fail the page. Asserted below, because that is the property that makes
// it safe to deploy mid-campaign.
//
// Run: node scripts/test-appointment-seen.mjs  (also in build:check)

process.env.TZ = "America/Toronto";

import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const appointmentActions = require(path.join(ROOT, "server", "lib", "appointment-actions.js"));
const cadence = require(path.join(ROOT, "server", "lib", "assignment-cadence.js"));

let pass = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};
const j = (v, n = 160) => String(JSON.stringify(v) ?? "(nothing)").slice(0, n);
// Missing entirely is a FAILURE to report, not a crash that hides the ten
// assertions behind it.
// Absent means every assertion below fails with a reason, rather than
// the run stopping at the first call.
const markSeen = async (...a) => {
  if (typeof appointmentActions.markSeen !== "function") return "(markSeen is missing)";
  return appointmentActions.markSeen(...a);
};

const bookingWith = (outreach) => ({
  id: "BK-SEEN-PROBE",
  source: "assignment",
  status: "confirmed",
  propertyId: "P-1",
  assignment: { season: "fall", year: 2026, code: "P-001", outreach }
});

// ---- 1. The first open is recorded ---------------------------------
{
  const writes = [];
  const setOutreach = async (id, patch, meta) => {
    writes.push({ id, patch, meta });
    return bookingWith({ ...patch });
  };
  const b = bookingWith({ token: "t".repeat(24), steps: { "1": { at: "2026-09-10T23:30:00Z" } } });
  await markSeen(b, { now: new Date("2026-09-10T23:45:00Z"), setOutreach });

  ok("opening the link records it", writes.length === 1, `${writes.length} writes`);
  ok("…as a timestamp", typeof writes[0]?.patch?.seenAt === "string"
    && !Number.isNaN(Date.parse(writes[0].patch.seenAt)), j(writes[0]?.patch));
  ok("…attributed to the customer, in the booking's own history",
    writes[0]?.meta?.action === "appointment_opened" && writes[0]?.meta?.by === "customer",
    j(writes[0]?.meta));
  ok("…without touching what was sent or answered",
    !("steps" in (writes[0]?.patch || {})) && !("respondedAt" in (writes[0]?.patch || {})),
    j(writes[0]?.patch));
}

// ---- 2. Only the FIRST open ------------------------------------------
// A "seen" that moves on every refresh cannot answer "did they ever
// look?", which is the only question it exists for.
{
  const writes = [];
  const setOutreach = async (...a) => { writes.push(a); return null; };
  const b = bookingWith({ token: "t".repeat(24), seenAt: "2026-09-10T20:00:00Z" });
  await markSeen(b, { now: new Date("2026-09-10T23:45:00Z"), setOutreach });
  ok("a second visit does not move the timestamp", writes.length === 0, `${writes.length} writes`);
}

// ---- 3. It cannot break the page --------------------------------------
// The property that makes this safe to ship in the middle of a campaign.
{
  const boom = async () => { throw new Error("disk on fire"); };
  const b = bookingWith({ token: "t".repeat(24) });
  let threw = null;
  let out = null;
  try { out = await markSeen(b, { setOutreach: boom }); }
  catch (err) { threw = err; }
  ok("a failed write does not throw at the page", threw === null, String(threw?.message));
  ok("…and the caller still gets the booking back", out === b, j(out));

  // A booking with no assignment envelope isn't part of the cadence.
  let threw2 = null;
  try { await markSeen({ id: "BK-X" }, { setOutreach: boom }); }
  catch (err) { threw2 = err; }
  ok("a non-assignment booking is left alone, quietly", threw2 === null, String(threw2?.message));
}

// ---- 4. The count Patrick reads ---------------------------------------
{
  const listBookings = async () => [
    bookingWith({ steps: { "1": { at: "x" } } }),                                    // messaged
    bookingWith({ steps: { "1": { at: "x" } }, seenAt: "2026-09-10T23:00:00Z" }),     // opened
    bookingWith({ steps: { "1": { at: "x" } }, seenAt: "2026-09-10T23:00:00Z",
      respondedAt: "2026-09-10T23:10:00Z" })                                          // answered
  ];
  const st = await cadence.status("fall", 2026, { deps: { listBookings } });
  ok("the status counts the opens", st.summary.seen === 2, j(st.summary));
  ok("…alongside messaged and responded, not instead of them",
    st.summary.bookings === 3 && st.summary.blasted === 3 && st.summary.responded === 1,
    j(st.summary));
  ok("…so 'opened but never answered' is finally visible",
    st.summary.seen - st.summary.responded === 1, j(st.summary));
}

if (failures.length) {
  console.error(`\n✗ test-appointment-seen: ${failures.length} failed, ${pass} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ test-appointment-seen: ${pass} assertions passed`);
