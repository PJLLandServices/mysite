#!/usr/bin/env node
// scripts/e2e/journey-8-returning-customer-portal.mjs
//
// JOURNEY 8 — a returning customer. Their spring opening is done and paid;
// Patrick books their fall closing; the customer moves it, then cancels it,
// from their own portal link. Last spring's visit must never be touched.
//
//   spring visit (real)    → booked, walked, photo + note, signed, finished,
//                            paid in cash — the history to preserve
//   fall booking (office)  → books the SAME customer (no duplicate), a NEW
//                            booking record and a NEW work order; spring's
//                            record is closed as completed, its WO, invoice
//                            and service record unchanged
//   the portal (customer)  → from the link in their confirmation text, as
//                            the customer (no staff session): both visits
//                            in their history, the fall one actionable
//   reschedule             → allowed once, >24h out; the booking and its
//                            work order move; a second move is refused
//   cancel                 → with a reason: the booking and the fall WO are
//                            cancelled, the slot leaves the day, a second
//                            cancel is a no-op that sends nothing
//   spring, at the end     → exactly as it was
//
// Run: node scripts/e2e/journey-8-returning-customer-portal.mjs

import { bootServer, journey, book, openWorkOrder, walkTheSystem, finish, invoiceFor, dayOut, j, sleep } from "./lib/journey.mjs";

process.env.TZ = "America/Toronto";
const J = journey("journey-8 returning customer · new fall visit · spring preserved · portal reschedule/cancel");
const srv = await bootServer({ port: 4938 });
const L = srv.ledger();
// A 1×1 PNG with real magic bytes (the upload validator checks them).
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
// The customer's own requests: no staff cookie, just their portal token.
const asCustomer = async (method, p, body) => {
  const r = await fetch(srv.BASE + p, { method, headers: { "content-type": "application/json", accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
try {
  await srv.login();
  const PHONE = "9055550150", EMAIL = "rita@example.com";
  const ADDRESS = "100 Davis Dr, Newmarket, ON L3Y 2N1";

  J.step("the spring visit");
  const { lead } = await book(srv, { serviceKey: "spring_open_4z", zoneCount: 4, day: dayOut(2),
    contact: { name: "Rita Returning", email: EMAIL, phone: PHONE, address: ADDRESS } });
  await J.sent(L, "spring booking", [
    { channel: "email", to: EMAIL, subject: /booked/i },
    { channel: "sms", to: PHONE, text: /confirmed/i },
    { channel: "email", to: "stub@pjl.test", subject: /BOOKED/ }
  ]);
  const spring = await openWorkOrder(srv, lead.id);
  J.ok(spring.type === "spring_opening", `a spring opening work order (${spring.type})`);
  await walkTheSystem(srv, spring.id, { walked: 4, paidOnSite: true });
  const up = await srv.api("POST", `/api/work-orders/${spring.id}/photos`, { photos: [{ mediaType: "image/png", data: PNG, category: "general", clientUploadId: `field-up-${Date.now()}` }] });
  J.ok(up.status === 200 || up.status === 201, `the completion photo uploads (${up.status} ${j(up.body.errors)})`);
  const noted = await srv.qpatch(spring.id, { customerNotes: "System opened, all four zones running well." });
  J.ok(noted.status === 200, `the visit note is saved (${noted.status})`);
  const done = await finish(srv, spring.id);
  J.ok(done.status === 200, `the spring visit finishes (${done.status} ${j(done.body.errors)})`);
  const springInv = invoiceFor(srv, spring.id);
  const cash = await srv.api("POST", `/api/invoices/${springInv.id}/payments`, { amount: springInv.total, method: "cash", receivedAt: new Date().toISOString() });
  J.ok(cash.status < 300, "…and is paid in cash");
  await J.sent(L, "spring finish", [
    { channel: "email", to: EMAIL, subject: /complete/i },
    { channel: "email", to: "stub@pjl.test", subject: /WO COMPLETED/ }
  ]);
  const snapshot = () => ({
    wo: srv.data("work-orders").find((w) => w.id === spring.id),
    booking: srv.data("bookings").find((b) => (b.workOrderIds || []).includes(spring.id)),
    invoice: srv.data("invoices").find((i) => i.id === springInv.id),
    record: (srv.data("properties").find((p) => p.id === spring.propertyId)?.serviceRecords || []).find((s) => s.woId === spring.id)
  });
  const before = snapshot();
  J.ok(before.wo?.status === "completed" && before.invoice?.status === "paid" && Boolean(before.record), "spring: completed, paid, on the property's record");

  J.step("the office books the fall visit");
  const fallDay = dayOut(21);
  const fall = await book(srv, { leadId: lead.id, serviceKey: "fall_close_4z", zoneCount: 4, day: fallDay, contact: { address: ADDRESS } });
  J.ok(fall.res.leadId === lead.id && srv.data("customers").length === 1 && srv.data("leads").length === 1, "the same customer, not a duplicate");
  const recs = srv.data("bookings");
  const fallRec = recs.find((b) => b.serviceKey === "fall_close_4z");
  const springRec = recs.find((b) => b.serviceKey === "spring_open_4z");
  J.ok(fallRec && springRec && fallRec.id !== springRec.id, `the fall visit gets its OWN booking record (${j(recs.map((b) => [b.id, b.serviceKey, b.status]))})`);
  J.ok(springRec?.status === "completed" && (springRec.history || []).some((h) => h.action === "closed_by_rebook"), `spring's record is closed as completed, and says why (${springRec?.status})`);
  const conf = await J.sent(L, "fall booking", [
    { channel: "email", to: EMAIL, subject: /booked/i },
    { channel: "sms", to: PHONE, text: /confirmed/i },
    { channel: "email", to: "stub@pjl.test", subject: /BOOKED/ }
  ]);
  const fallWo = await openWorkOrder(srv, lead.id);
  J.ok(fallWo.type === "fall_closing" && fallWo.id !== spring.id, `Start opens a NEW fall work order, not spring's (${fallWo.id})`);
  const token = (conf.find((m) => m.channel === "sms")?.body || "").match(/\/portal\/([A-Za-z0-9_-]+)/)?.[1];
  J.ok(Boolean(token), "the confirmation text carries the customer's portal link");
  await J.sent(L, "fall start", []);

  J.step("the customer's portal");
  const portal = (await asCustomer("GET", `/api/portal/${token}`)).body.portal;
  J.ok(portal && portal.viewerIsAdmin !== true, "opened as the customer, not staff");
  const hist = portal?.serviceHistory || [];
  J.ok(hist.some((h) => h.id === spring.id && h.status === "completed") && hist.some((h) => h.id === fallWo.id), `both visits in their history (${j(hist.map((h) => [h.id, h.status]))})`);
  J.ok(portal?.nextVisit?.woId === fallWo.id, "the next visit is the fall one");
  const acts = await asCustomer("GET", `/api/portal/${token}/booking-actions`);
  J.ok(acts.body.canReschedule === true && acts.body.canCancel === true && acts.body.bookingId === fallRec.id, `the fall visit can be moved or cancelled (${j(acts.body.reasons)})`);

  J.step("reschedule");
  const avail = await asCustomer("GET", `/api/portal/${token}/reschedule-availability`);
  const slot = (avail.body.days || []).flatMap((d) => d.slots || []).find((s) => new Date(s.start) - Date.now() > 3 * 86400000
    && new Date(s.start).toLocaleDateString("en-CA") !== fallDay);
  J.ok(avail.status === 200 && Boolean(slot), `open days are offered (${avail.status} ${(avail.body.days || []).length} days)`);
  const moved = await asCustomer("PATCH", `/api/portal/${token}/reschedule`, { slotStart: slot?.start, reason: "Away that week" });
  J.ok(moved.status === 200 && moved.body.ok, `the customer moves it (${moved.status} ${j(moved.body.errors)})`);
  const movedRec = srv.data("bookings").find((b) => b.id === fallRec.id);
  J.ok(new Date(movedRec?.scheduledFor).toLocaleDateString("en-CA") === new Date(slot.start).toLocaleDateString("en-CA"), `the booking is on the new day (${movedRec?.scheduledFor})`);
  const fallWoMoved = srv.data("work-orders").find((w) => w.id === fallWo.id);
  J.ok(new Date(fallWoMoved?.scheduledFor).toLocaleDateString("en-CA") === new Date(slot.start).toLocaleDateString("en-CA"), `…and so is its work order (${fallWoMoved?.scheduledFor})`);
  await J.sent(L, "reschedule", [
    { channel: "email", to: EMAIL, subject: /appointment moved/i },
    { channel: "sms", to: PHONE, text: /appointment moved/i },
    { channel: "email", to: "stub@pjl.test", subject: /Customer rescheduled/ }
  ]);
  const second = await asCustomer("PATCH", `/api/portal/${token}/reschedule`, { slotStart: slot?.start });
  J.ok(second.status >= 400 && second.body.phoneFallback, `a second move is refused, with the phone number (${second.status} ${second.body.code})`);
  await J.sent(L, "second move", []);

  J.step("cancel");
  const noReason = await asCustomer("POST", `/api/portal/${token}/cancel`, {});
  J.ok(noReason.status === 422 && noReason.body.code === "missing_reason", `a reason is required (${noReason.status})`);
  const cancel = await asCustomer("POST", `/api/portal/${token}/cancel`, { reason: "Selling the house before then" });
  J.ok(cancel.status === 200 && cancel.body.ok && !cancel.body.alreadyCancelled, `the customer cancels (${cancel.status} ${j(cancel.body.errors)})`);
  J.ok(srv.data("bookings").find((b) => b.id === fallRec.id)?.status === "cancelled", "the fall booking is cancelled");
  J.ok(srv.data("work-orders").find((w) => w.id === fallWo.id)?.status === "cancelled", "…and so is the fall work order");
  const day = await srv.api("GET", `/api/schedule/today?date=${new Date(slot.start).toLocaleDateString("en-CA")}`);
  J.ok(!(day.body.bookings || []).some((b) => b.leadId === lead.id && b.status !== "cancelled"), "the slot leaves the day");
  await J.sent(L, "cancel", [
    { channel: "email", to: EMAIL, subject: /Appointment cancelled/ },
    { channel: "email", to: "stub@pjl.test", subject: /Customer cancelled/ }
  ]);
  const twice = await asCustomer("POST", `/api/portal/${token}/cancel`, { reason: "Selling the house before then" });
  J.ok(twice.status === 200 && twice.body.alreadyCancelled === true, "a second cancel is a no-op");
  await J.sent(L, "cancel again", []);

  J.step("spring is untouched");
  const after = snapshot();
  J.ok(j(after.wo) === j(before.wo), "spring's work order is byte-for-byte unchanged");
  J.ok(after.invoice?.status === "paid" && after.invoice?.total === before.invoice?.total && (after.invoice?.payments || []).length === 1, "spring's invoice is still paid, once");
  J.ok(j(after.record) === j(before.record), "spring's service record is unchanged");
  J.ok(after.booking?.id === springRec.id && after.booking?.status === "completed", "spring's booking record stays completed");
  const finalPortal = (await asCustomer("GET", `/api/portal/${token}`)).body.portal;
  J.ok((finalPortal?.serviceHistory || []).some((h) => h.id === spring.id && h.status === "completed"), "…and still in the customer's history");
} catch (err) {
  J.crashed(err);
} finally {
  J.close(L);
  await srv.stop().catch(() => {});
}
J.finish();
