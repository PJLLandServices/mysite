#!/usr/bin/env node
// scripts/test-notify-season-plan.mjs
//
// "Notify on route" works for a season-plan visit (Patrick, 2026-10-01,
// from the field: "I'm on route and I need to notify … customers of today").
//
// WHAT BROKE: the Today screen disabled Notify on any card without a lead
// (`disabled={… || !b.leadId}`), and the only send route was
// /api/leads/:id/notify-on-route. A season-plan visit (the fall assignment
// run) is a booking record with a property and the customer's own name,
// phone and email, but no lead, so it could never be notified. Separately,
// the on-route stamp lived on the lead forever: a returning customer's
// spring notice marked every later visit "Notified".
//
// THE RULE: a lead booking notifies through its lead, a season-plan visit
// through its booking (POST /api/bookings/:id/notify-on-route, same on_route
// text + email, to the booking's contact). A stamp counts only for the visit
// it was sent for (same Toronto day); a second tap the same day sends
// nothing more.
//
// Run: node scripts/test-notify-season-plan.mjs   (also in build:check)

import fs from "node:fs";
import { bootServer, j, sleep } from "./e2e/lib/journey.mjs";

let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) passed += 1;
  else { failed += 1; console.error(`  FAIL: ${label}`); }
}

// ---- the app asks the right door -------------------------------------------------------
{
  const screen = fs.readFileSync(new URL("../pjl-field/src/screens/TodayScreen.js", import.meta.url), "utf8");
  const api = fs.readFileSync(new URL("../pjl-field/src/api.js", import.meta.url), "utf8");
  ok(/disabled=\{notified \|\| busy \|\| !\(b\.leadId \|\| b\.bookingId\)\}/.test(screen), "app: Notify is enabled for a visit with a booking but no lead");
  ok(/if \(b\.leadId\) await notifyOnRoute\(b\.leadId\);\s*else await notifyBookingOnRoute\(b\.bookingId\);/.test(screen), "app: a lead notifies through its lead, a season-plan visit through its booking");
  ok(/rowKey\(row\) === rowKey\(b\)/.test(screen), "app: the 'Notified' mark lands on that one card, not every lead-less card");
  ok(/\/api\/bookings\/\$\{encodeURIComponent\(bookingId\)\}\/notify-on-route/.test(api), "app: notifyBookingOnRoute posts to the booking route");
}

const srv = await bootServer({ port: 4951 });
try {
  await srv.login();
  const bookings = srv.lib("bookings.js");
  const day = new Date(Date.now() + 2 * 864e5);
  const ymd = day.toLocaleDateString("en-CA");
  const at = (h, m = 0) => new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m).toISOString();
  const mk = (h, extra = {}) => bookings.createDirect({
    scheduledFor: at(h), durationMinutes: 45, serviceKey: "fall_winterization", serviceLabel: "Fall winterization",
    propertyId: `P-notify-${h}`, customerName: "Peter & Debra Calandra", customerPhone: "9055550123",
    customerEmail: "calandra@example.com", address: "111 Tanners Dr, Acton", source: "assignment", ...extra
  }, { by: "test" });
  const today = async () => (await srv.api("GET", `/api/schedule/today?date=${ymd}`)).body.bookings || [];
  const notify = (id) => srv.api("POST", `/api/bookings/${id}/notify-on-route`, {});
  const msgs = (from) => srv.outbox().slice(from).filter((e) => e.channel === "sms" || e.channel === "email");

  const a = await mk(9);
  const nobody = await mk(11, { customerPhone: "", customerEmail: "" });
  const cancelled = await mk(13, { status: "cancelled" });

  // ---- 1 the season-plan card has no lead, but a booking ----
  let row = (await today()).find((r) => r.bookingId === a.id);
  ok(row && !row.leadId && row.bookingId === a.id && row.onRouteNotifiedAt === null, `1: the season-plan card carries its booking, no lead, not yet notified (${j(row && { leadId: row.leadId, bookingId: row.bookingId, n: row.onRouteNotifiedAt })})`);

  // ---- 2 notify it ----
  let m0 = srv.outbox().length;
  const r = await notify(a.id);
  await sleep(500);
  const sent = msgs(m0);
  const sms = sent.find((e) => e.channel === "sms");
  const mail = sent.find((e) => e.channel === "email");
  ok(r.status === 200 && r.body.ok && r.body.notifiedAt, `2: the booking route answers ok (${r.status} ${j(r.body)})`);
  ok(sms && /9055550123$/.test(sms.to.replace(/\D/g, "")) && /on the way/i.test(sms.body) && /Hi Peter,/.test(sms.body), `2: the customer gets the on-route text, by first name (${j(sms)})`);
  ok(mail && mail.to === "calandra@example.com" && /on the way/i.test(`${mail.subject} ${mail.text}`), `2: …and the on-route email (${j(mail && { to: mail.to, subject: mail.subject })})`);
  row = (await today()).find((x) => x.bookingId === a.id);
  ok(row?.onRouteNotifiedAt === r.body.notifiedAt, `2: the card now reads notified (${row?.onRouteNotifiedAt})`);
  ok((bookings.list ? (await bookings.get(a.id)).history : []).some((h) => h.action === "notified_on_route"), "2: the booking's history records it");

  // ---- 3 a second tap the same day sends nothing ----
  m0 = srv.outbox().length;
  const again = await notify(a.id);
  await sleep(300);
  ok(again.status === 200 && again.body.alreadySent === true && msgs(m0).length === 0, `3: a second tap sends nothing more (${j(again.body)} ${msgs(m0).length})`);

  // ---- 4 refusals send nothing ----
  m0 = srv.outbox().length;
  const none = await notify(nobody.id);
  const dead = await notify(cancelled.id);
  const missing = await notify("B-nope");
  await sleep(300);
  ok(none.status === 409 && /no phone or email/i.test(none.body.errors?.[0] || ""), `4: no phone or email → refused, call instead (${none.status})`);
  ok(dead.status === 409 && missing.status === 404 && msgs(m0).length === 0, `4: a cancelled or unknown visit sends nothing (${dead.status} ${missing.status} ${msgs(m0).length})`);

  // ---- 5 an old stamp never marks today's visit ----
  const all = srv.data("bookings");
  const rec = all.find((b) => b.id === a.id);
  // A record reused from an earlier season: its stamp names that visit.
  rec.onRouteNotifiedAt = new Date(Date.now() - 200 * 864e5).toISOString();
  rec.onRouteNotifiedFor = new Date(Date.now() - 200 * 864e5 + 3600e3).toISOString();
  srv.writeData("bookings", all);
  row = (await today()).find((x) => x.bookingId === a.id);
  ok(row?.onRouteNotifiedAt === null, `5: a notice from an earlier season doesn't mark this visit notified (${row?.onRouteNotifiedAt})`);
  m0 = srv.outbox().length;
  const fresh = await notify(a.id);
  await sleep(300);
  ok(fresh.status === 200 && !fresh.body.alreadySent && msgs(m0).some((e) => e.channel === "sms"), "5: …so today's visit can be notified");

  // ---- 6 the same rule for a lead's stamp ----
  const leads = srv.data("leads");
  const lead = {
    id: `L-notify-${Date.now()}`, createdAt: new Date().toISOString(), status: "won",
    contact: { name: "Steve Richards", phone: "9055550456", email: "steve@example.com", address: "79 Delarmbro Dr, Erin" },
    booking: { start: at(15), end: at(16), serviceKey: "fall_winterization", serviceLabel: "Fall winterization" },
    crm: { status: "won", activity: [] },
    onRouteNotifiedAt: new Date(Date.now() - 200 * 864e5).toISOString()
  };
  srv.writeData("leads", [...(Array.isArray(leads) ? leads : []), lead]);
  row = (await today()).find((x) => x.leadId === lead.id);
  ok(row && row.onRouteNotifiedAt === null, `6: a lead notified on an earlier visit isn't shown notified today (${j(row && row.onRouteNotifiedAt)})`);
} finally {
  await srv.stop();
}

console.log(`\nnotify season-plan visits: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
