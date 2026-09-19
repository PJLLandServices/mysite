// The Season Plan's per-stop "Send confirmation" — one booking's step-1
// assignment message, on demand from the desktop.
//
//   node scripts/test-plan-confirmation.mjs
//
// WHAT THIS PROTECTS. Patrick, 2026-09-19: the phone's Book tab confirms
// a customer the moment the booking is made, but a customer booked
// through the Season Plan waited for the season-wide blast — a button
// nobody reaches for to message one person. The fix is
// sendConfirmationForBooking: step 1, for one booking, through the SAME
// sendStepForBooking path the blast uses. What must hold is rule 1 in
// both directions — a customer confirmed here is alreadyBlasted to the
// blast, and a blasted customer answers alreadySent here — because a
// double-fired message is the worst bug this system can have.
process.env.TZ = "America/Toronto";

import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0;
const failures = [];
function ok(name, cond, detail = "") {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
}

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "pjl-plan-confirm-"));
fs.mkdirSync(path.join(SANDBOX, "server"), { recursive: true });
fs.cpSync(path.join(ROOT, "server/lib"), path.join(SANDBOX, "server/lib"), { recursive: true });
for (const f of ["seasons.json", "pricing.json", "parts.json"]) {
  fs.cpSync(path.join(ROOT, f), path.join(SANDBOX, f));
}
fs.mkdirSync(path.join(SANDBOX, "server/data"), { recursive: true });

const prop = (id, extra = {}) => ({
  id, code: id,
  customerName: `Customer ${id}`,
  customerPhone: "+19055550100",
  customerEmail: `${id.toLowerCase()}@example.com`,
  address: `${id} Test St, Newmarket, ON`,
  town: "Newmarket",
  ...extra
});
fs.writeFileSync(path.join(SANDBOX, "server/data/properties.json"), JSON.stringify([
  prop("P-1"),
  prop("P-2"),
  prop("P-SILENT", { customerPhone: "", customerEmail: "", commPrefs: { noContactNeeded: true } })
], null, 2));

const bookings = require(path.join(SANDBOX, "server/lib/bookings.js"));
const cadence = require(path.join(SANDBOX, "server/lib/assignment-cadence.js"));

const D = (day, h = 8, m = 0) => new Date(2026, 9, day, h, m).toISOString(); // October 2026
const mk = (pid, opts = {}) => bookings.createDirect({
  propertyId: pid,
  customerName: `Customer ${pid}`,
  customerPhone: "+19055550100",
  customerEmail: `${pid.toLowerCase()}@example.com`,
  address: `${pid} Test St, Newmarket, ON`,
  serviceKey: "fall_close_4z",
  serviceLabel: "Fall winterization (1-4 zones residential)",
  scheduledFor: opts.scheduledFor || D(5, 8, 13),
  durationMinutes: 30,
  status: "confirmed",
  source: "assignment",
  assignment: {
    season: "fall", year: 2026, batchId: "AS-test", assignedAt: "x",
    date: "2026-10-05", bucket: "morning", code: pid
  }
});
const b1 = await mk("P-1");
const b2 = await mk("P-2");
const bSilent = await mk("P-SILENT");

const wire = { emails: [], smses: [] };
const deps = {
  sendEmail: async (args) => { wire.emails.push(args); return { ok: true, messageId: "test" }; },
  sendSms: async (args) => { wire.smses.push(args); return { ok: true, sid: "test" }; }
};
const at = (month, day, h, min = 0) => new Date(2026, month - 1, day, h, min);
const IN_WINDOW = at(9, 20, 10);

// ---- 1. The interlocks mirror the blast's ---------------------------
{
  let threw = null;
  try { await cadence.sendConfirmationForBooking(b1.id, { deps, now: IN_WINDOW }); }
  catch (e) { threw = e.message; }
  ok("refuses while the appointment page isn't live",
    /appointment page/i.test(threw || ""), threw);

  threw = null;
  try { await cadence.sendConfirmationForBooking(b1.id, { deps, now: at(9, 20, 7), appointmentPageReady: true }); }
  catch (e) { threw = e.message; }
  ok("refuses outside the send window", /Sends go out/.test(threw || ""), threw);
}

// ---- 2. The send, and rule 1 in both directions ----------------------
{
  const r = await cadence.sendConfirmationForBooking(b1.id, {
    deps, now: IN_WINDOW, appointmentPageReady: true, by: "patrick"
  });
  ok("sends the step-1 message on both channels",
    r.ok === true && r.sent?.includes("email") && r.sent?.includes("sms"), JSON.stringify(r));
  ok("exactly one email and one SMS left the wire",
    wire.emails.length === 1 && wire.smses.length === 1,
    `${wire.emails.length} emails, ${wire.smses.length} smses`);

  const fresh = await bookings.get(b1.id);
  ok("step 1 is marked on the booking's outreach record",
    Boolean(fresh.assignment.outreach?.steps?.["1"]?.at), JSON.stringify(fresh.assignment.outreach || null));

  const again = await cadence.sendConfirmationForBooking(b1.id, {
    deps, now: IN_WINDOW, appointmentPageReady: true
  });
  ok("a second press answers alreadySent and sends NOTHING",
    again.ok === true && again.alreadySent === true
    && wire.emails.length === 1 && wire.smses.length === 1, JSON.stringify(again));

  // The other direction: the blast sees the confirmed customer as done.
  const blast = await cadence.blast("fall", 2026, {
    deps, now: IN_WINDOW, appointmentPageReady: true, by: "patrick"
  });
  ok("the blast counts the confirmed booking as alreadyBlasted — never a double send",
    blast.alreadyBlasted === 1, JSON.stringify(blast));
  ok("…and reaches the rest exactly once",
    blast.blasted === 1 && wire.emails.filter((e) => /p-1/.test(e.to || "")).length === 1,
    JSON.stringify({ blasted: blast.blasted }));

  const afterBlast = await cadence.sendConfirmationForBooking(b2.id, {
    deps, now: IN_WINDOW, appointmentPageReady: true
  });
  ok("a blasted customer answers alreadySent here",
    afterBlast.ok === true && afterBlast.alreadySent === true, JSON.stringify(afterBlast));
}

// ---- 3. The gates still gate ----------------------------------------
{
  const r = await cadence.sendConfirmationForBooking(bSilent.id, {
    deps, now: IN_WINDOW, appointmentPageReady: true
  });
  ok("Decision I: a no-contact property is skipped with its reason",
    r.ok === false && r.skipped === true && r.reason === "no_contact_needed", JSON.stringify(r));
}

// ---- 4. Only a live assignment booking qualifies ---------------------
{
  let threw = null;
  try {
    await cadence.sendConfirmationForBooking("BK-X", {
      deps: { ...deps, getBooking: async () => ({ id: "BK-X", source: "web", status: "confirmed" }) },
      now: IN_WINDOW, appointmentPageReady: true
    });
  } catch (e) { threw = e; }
  ok("a self-booked (non-assignment) booking is refused",
    threw?.code === "NOT_ASSIGNMENT", threw?.message);

  threw = null;
  try {
    await cadence.sendConfirmationForBooking("BK-Y", {
      deps: { ...deps, getBooking: async () => ({ id: "BK-Y", source: "assignment", assignment: { season: "fall", year: 2026 }, status: "cancelled" }) },
      now: IN_WINDOW, appointmentPageReady: true
    });
  } catch (e) { threw = e; }
  ok("a cancelled booking is refused — nothing to confirm",
    threw?.code === "NOT_LIVE", threw?.message);

  threw = null;
  try {
    await cadence.sendConfirmationForBooking("BK-GONE", {
      deps: { ...deps, getBooking: async () => null },
      now: IN_WINDOW, appointmentPageReady: true
    });
  } catch (e) { threw = e; }
  ok("a missing booking is a NOT_FOUND", threw?.code === "NOT_FOUND", threw?.message);
}

// ---- 5. Source guards: the wiring that makes the button real ---------
{
  const serverSrc = fs.readFileSync(path.join(ROOT, "server/server.js"), "utf8");
  const route = serverSrc.slice(serverSrc.indexOf("send-confirmation"));
  ok("the route exists and calls the cadence entry point",
    route.includes("assignmentCadence.sendConfirmationForBooking"));
  ok("the route is admin-gated — it messages a customer",
    route.slice(0, route.indexOf("sendConfirmationForBooking")).includes("requireAdmin"));
  ok("the route carries the appointment-page interlock",
    route.slice(0, route.indexOf("sendJson(res, 200, result)")).includes("APPOINTMENT_PAGE_READY"));
  ok("the plan payload annotates stops with their confirmation state",
    serverSrc.includes("stop.confirmation = c"));

  const uiSrc = fs.readFileSync(path.join(ROOT, "server/season-plan.js"), "utf8");
  ok("the panel renders the control for a stop that carries one",
    uiSrc.includes("confirmControl(stop.confirmation)") && uiSrc.includes("confirmControl(b.confirmation)"));
  ok("the button posts to the route the server serves",
    uiSrc.includes("/send-confirmation"));
}

if (failures.length) {
  console.error(`FAIL test-plan-confirmation: ${failures.length} failing`);
  for (const f of failures) console.error("  ✗ " + f);
  process.exit(1);
}
console.log(`ok test-plan-confirmation — ${pass} assertions`);
