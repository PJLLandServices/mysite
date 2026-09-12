#!/usr/bin/env node
// scripts/test-booking-alert-price.mjs
//
// Patrick, 2026-09-12, forwarding "New PJL Lead — Customer rescheduled
// their appointment — ADAM SORRENTI": "Can you tell me why Adam's quoted
// closing cost is $0.00?"
//
// It wasn't. The lead-alert shell prints a LEAD's items and estimated
// total; every alert about a BOOKING handed it a bare contact block, so
// the shell printed its empty state — "$0.00 · No specific items
// selected" — and ISO timestamps for the dates. This pins the one shape
// those alerts now share: the booking's service and price by the rule
// the appointment page uses, and dates the way the customer was told.
//
// Run: node scripts/test-booking-alert-price.mjs  (also in build:check)

process.env.TZ = "America/Toronto";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
const failures = [];
const ok = (name, cond, detail = "") => {
  if (cond) { pass += 1; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ""}`);
};
const j = (v, n = 220) => String(JSON.stringify(v) ?? "(nothing)").slice(0, n);
const read = (rel) => {
  try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch { return ""; }
};
const src = read("server/server.js");

// Lift the two helpers with stubbed collaborators; absent → reported.
function lift(name, extra) {
  const m = src.match(new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`));
  if (!m) return null;
  try { return new Function(`${extra} ${m[0]} return ${name};`)(); } catch (err) { failures.push(`${name} could not be lifted — ${err.message}`); return null; }
}
const whenLabel = lift("appointmentWhenLabel", `
  const BOOKING_BUCKETS = [
    { key: "morning", windowLabel: "8 AM – 12 PM" }, { key: "afternoon", windowLabel: "12 PM – 5 PM" }
  ];`);
const alertLead = lift("bookingAlertLead", `
  const properties = { get: async (id) => ({ p1: { id: "p1", system: { zones: [1, 2, 3, 4, 5] } }, p2: { id: "p2", seasonalPricing: { fallClosingPrice: 199 } }, p3: { id: "p3" } })[id] || null };
  const resolveSeasonalPrice = (property, family) => {
    if (property && property.seasonalPricing && property.seasonalPricing.fallClosingPrice != null) return { price: property.seasonalPricing.fallClosingPrice, label: "$199", custom: false };
    const zones = property && property.system && property.system.zones ? property.system.zones.length : 0;
    if (!zones) return { price: 0, label: "Custom quote", custom: true };
    return { price: family === "spring_opening" ? 150 : 245, label: "$245", custom: false };
  };`);

// ---- 1. Dates the way the customer was told them ---------------------------
{
  const w = (iso) => (whenLabel ? whenLabel(iso) : "(appointmentWhenLabel is missing)");
  ok("an afternoon appointment reads as its day and window", w("2026-10-22T18:01:00.000Z") === "Thu, Oct 22, Afternoon (12 PM – 5 PM)", j(w("2026-10-22T18:01:00.000Z")));
  ok("…a morning one too", w("2026-10-19T14:00:00.000Z") === "Mon, Oct 19, Morning (8 AM – 12 PM)", j(w("2026-10-19T14:00:00.000Z")));
  ok("no date → said, not crashed", w(null) === "(unscheduled)" && w("garbage") === "(unscheduled)", j([w(null), w("garbage")]));
}

// ---- 2. The alert carries the booking's price by the page's rule ----------
{
  const booking = { id: "BK-2026-0181", propertyId: "p1", serviceKey: "fall_closing_5_8", serviceLabel: "Fall closing (5–8 zones)", customerName: "ADAM SORRENTI", customerPhone: "4168829666", customerEmail: "adam@example.com", address: "24 Village Squire Ln, Thornhill" };
  const run = async (b, opts) => { if (!alertLead) return { missing: "(bookingAlertLead is missing)" }; try { return await alertLead(b, opts); } catch (err) { return { error: err.message }; } };
  const a = await run(booking, { sourceLabel: "Customer rescheduled their appointment", notes: "Was X. Now Y." });
  ok("the alert prices the service from the property's tier", a.totals?.expectedTotal === 245, j(a));
  ok("…as one line item, the booking's own service", a.features?.length === 1 && a.features[0].label === "Fall closing (5–8 zones)" && a.features[0].price === 245 && a.features[0].quoteType === "fixed", j(a.features));
  ok("…with the contact from the booking when there is no lead", a.contact?.name === "ADAM SORRENTI" && a.contact?.phone === "4168829666" && a.id === "BK-2026-0181", j(a.contact));
  ok("…and the note as given", a.contact?.notes === "Was X. Now Y." && a.sourceLabel === "Customer rescheduled their appointment", j(a));
  const o = await run({ ...booking, propertyId: "p2" }, { sourceLabel: "x" });
  ok("a property's own price override wins, as on the page", o.totals?.expectedTotal === 199, j(o.totals));
  const c = await run({ ...booking, propertyId: "p3" }, { sourceLabel: "x" });
  ok("no zone count → 'custom quote', said as such rather than a silent $0", c.features?.[0]?.quoteType === "custom" && c.totals?.expectedTotal === 0, j(c));
  const lead = { id: "L-1", contact: { name: "Adam S", phone: "1", email: "e", address: "addr" }, portal: { token: "tok" } };
  const l = await run(booking, { sourceLabel: "x", lead });
  ok("with a lead, the contact and the portal come from it", l.id === "L-1" && l.contact?.name === "Adam S" && l.portal?.token === "tok", j(l));
  const s = await run({ ...booking, serviceKey: "spring_opening_1_4" }, { sourceLabel: "x" });
  ok("a spring booking is priced as spring", s.totals?.expectedTotal === 150, j(s.totals));
}

// ---- 3. Every booking alert goes through it -------------------------------
{
  ok("the reschedule alert", /await bookingAlertLead\(bookingRec, \{\s*lead,\s*sourceLabel: "Customer rescheduled their appointment"/.test(src), "still a bare contact block");
  ok("…with readable dates", /Was \$\{appointmentWhenLabel\(bookingRec\.scheduledFor\)\}\. Now \$\{appointmentWhenLabel\(startDate\)\}/.test(src), "ISO stamps in the note");
  ok("the cancel alert", /await bookingAlertLead\(bookingRec, \{\s*lead,\s*sourceLabel: "Customer cancelled their appointment"/.test(src), "still a bare contact block");
  ok("the free-bucket alert (email AND sms from one shape)", /const alias = await bookingAlertLead\(b, \{\s*sourceLabel: "Customer chose the FREE BUCKET"/.test(src) && /sendNewLeadSms\(\{ \.\.\.alias, contact: \{ \.\.\.alias\.contact, notes: "" \} \}/.test(src), "still a bare contact block");
  ok("the resend shape", /async function alertShapeForBooking\(booking\) \{[\s\S]{0,400}return bookingAlertLead\(booking, \{/.test(src) && /await alertShapeForBooking\(booking\)/.test(src), "resend still bare, or not awaited");
  ok("no booking alert is built as a bare contact block any more", !/sourceLabel: "Customer (rescheduled|cancelled) their appointment",\s*contact: \{/.test(src), "a bare block remains");
}

if (failures.length) {
  console.error(`\n✗ test-booking-alert-price: ${failures.length} failed, ${pass} passed`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ test-booking-alert-price: ${pass} assertions passed`);
