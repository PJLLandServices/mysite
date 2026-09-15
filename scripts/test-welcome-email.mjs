// The new-customer welcome email.
//
//   node scripts/test-welcome-email.mjs
//
// WHAT THIS PROTECTS. One email per customer, ever, on their FIRST
// booking — and never to a customer who is not new, never before the
// booking has settled, never when Patrick has the switch off, and never
// to a customer who already existed before the switch was ever turned
// on (autoSendCutoff — see the 2026-09-15 incident notes below, where
// the lack of this sent every past customer PJL had one email in a
// single sweep the first time the switch was used for real). The
// renderer is pinned too: each variant keeps or drops the booking
// section exactly as designed, and every variant carries the customer's
// own portal link instead of the generic login page. And the invariant
// every sender in this codebase shares: the mark goes down BEFORE the
// send, so a failed send is a quiet miss and never a double.
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

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "pjl-welcome-"));
fs.mkdirSync(path.join(SANDBOX, "server"), { recursive: true });
fs.cpSync(path.join(ROOT, "server/lib"), path.join(SANDBOX, "server/lib"), { recursive: true });
for (const f of ["seasons.json", "pricing.json", "parts.json"]) {
  fs.cpSync(path.join(ROOT, f), path.join(SANDBOX, f));
}
fs.mkdirSync(path.join(SANDBOX, "server/data"), { recursive: true });

const welcome = require(path.join(SANDBOX, "server/lib/welcome-email.js"));
const customers = require(path.join(SANDBOX, "server/lib/customers.js"));
const settingsLib = require(path.join(SANDBOX, "server/lib/settings.js"));
const SPRING_SOURCE = fs.readFileSync(path.join(ROOT, "server/lib/welcome-email-spring.html"), "utf8");
const FALL_SOURCE = fs.readFileSync(path.join(ROOT, "server/lib/welcome-email-fall.html"), "utf8");
const SERVICE_SOURCE = fs.readFileSync(path.join(ROOT, "server/lib/welcome-email-service.html"), "utf8");
const INSTALLATION_SOURCE = fs.readFileSync(path.join(ROOT, "server/lib/welcome-email-installation.html"), "utf8");

// ---- 1. Render ---------------------------------------------------------

const PORTAL = "https://www.pjllandservices.com/portal/abc&def";
const BOOKING_BAND = "HOW YOUR BOOKING WAS MADE"; // shared verbatim per spec — spring, fall
const INSTALLATION_SEASONS_HEADING = "How your seasons work from here";
const rendered = Object.fromEntries(welcome.VARIANTS.map((v) => [
  v, welcome.renderWelcomeEmail({ variant: v, firstName: "Ad <b>", portalUrl: PORTAL, unsubscribeUrl: "https://x/unsub" })
]));

ok("four variants render, each its own complete design", welcome.VARIANTS.length === 4 && welcome.VARIANTS.every((v) => rendered[v].html.length > 10000));
ok("spring_opening and fall_closing carry the shared-per-spec booking heading; service and installation don't need it",
  rendered.spring_opening.html.includes(BOOKING_BAND) && rendered.fall_closing.html.includes(BOOKING_BAND)
  && !rendered.service.html.includes(BOOKING_BAND) && !rendered.installation.html.includes(BOOKING_BAND));
ok("installation explains the seasonal cycle instead of a booking flow (it's never auto-booked itself)",
  rendered.installation.html.includes(INSTALLATION_SEASONS_HEADING)
  && rendered.installation.html.includes("nothing to rebuild, only to verify"));
ok("service explains how a repair visit itself works, distinct from the seasonal auto-booking sections",
  rendered.service.html.includes("How a repair visit goes") && !rendered.service.html.includes(BOOKING_BAND)
  && !rendered.service.html.includes(INSTALLATION_SEASONS_HEADING));
ok("spring and fall do not carry installation's seasons heading or service's repair-visit heading",
  !rendered.spring_opening.html.includes(INSTALLATION_SEASONS_HEADING) && !rendered.fall_closing.html.includes(INSTALLATION_SEASONS_HEADING)
  && !rendered.spring_opening.html.includes("How a repair visit goes") && !rendered.fall_closing.html.includes("How a repair visit goes"));
ok("no variant surfaces the internal routing/driving-cost reasoning every spec's §9 forbids",
  welcome.VARIANTS.every((v) => !rendered[v].html.includes("less windshield time") && !rendered[v].html.includes("less fuel")
    && !rendered[v].html.includes("route down your street") && !rendered[v].html.includes("routes are built by area")));
ok("no variant still describes a repair-style \"find the fault first\" visit outside of service's own repair content",
  !rendered.spring_opening.html.includes("find the fault first") && !rendered.fall_closing.html.includes("find the fault first")
  && !rendered.installation.html.includes("find the fault first"));
ok("installation warranty leads with three years; spring, fall and service are one-year only, no install upsell line",
  rendered.installation.html.includes("Your new system carries three years, parts and labour.")
  && !rendered.installation.html.includes("New system installations carry three years.")
  && [rendered.spring_opening, rendered.fall_closing, rendered.service].every((r) =>
    r.html.includes("Every repair we carry out is covered for one year, parts and labour.") && !r.html.includes("three years")));
ok("installation never promises zero overspray, and never claims the customer reviewed/approved a design",
  !rendered.installation.html.toLowerCase().includes("zero overspray")
  && !/you (saw|see|reviewed|approved) the design/i.test(rendered.installation.html));
ok("every variant substitutes the portal URL (escaped) and loses the generic login link",
  welcome.VARIANTS.every((v) =>
    rendered[v].html.includes('href="https://www.pjllandservices.com/portal/abc&amp;def"')
    && !rendered[v].html.includes("portal/login")));
ok("every variant swaps the unsubscribe href when one is given",
  welcome.VARIANTS.every((v) => rendered[v].html.includes('href="https://x/unsub"') && !rendered[v].html.includes("subject=Unsubscribe")));
ok("no unsubscribe URL keeps the designed mailto",
  welcome.renderWelcomeEmail({ variant: "service", portalUrl: PORTAL }).html.includes("mailto:info@pjllandservices.com?subject=Unsubscribe"));
ok("no portal URL falls back to the login page",
  welcome.renderWelcomeEmail({ variant: "service" }).html.includes('href="https://www.pjllandservices.com/portal/login"'));
ok("every variant with the default link is its own approved file byte-for-byte",
  welcome.renderWelcomeEmail({ variant: "spring_opening" }).html === SPRING_SOURCE
  && welcome.renderWelcomeEmail({ variant: "fall_closing" }).html === FALL_SOURCE
  && welcome.renderWelcomeEmail({ variant: "service" }).html === SERVICE_SOURCE
  && welcome.renderWelcomeEmail({ variant: "installation" }).html === INSTALLATION_SOURCE);
ok("subjects are per variant",
  rendered.spring_opening.subject.endsWith("your spring opening is booked")
  && rendered.fall_closing.subject.endsWith("your fall closing is booked")
  && rendered.spring_opening.subject !== rendered.fall_closing.subject
  && rendered.service.subject.endsWith("we've got your repair booked")
  && rendered.installation.subject.endsWith("your new system, and what comes next"));
ok("text alternative greets by first name and carries the portal link; the HTML is unchanged by the name",
  rendered.service.text.startsWith("Hi Ad <b>,") && rendered.service.text.includes(PORTAL)
  && !rendered.service.html.includes("Ad <b>") && !rendered.service.html.includes("Ad &lt;b&gt;"));
ok("text alternative follows the variant",
  rendered.installation.text.includes(INSTALLATION_SEASONS_HEADING.toUpperCase()) && !rendered.installation.text.includes(BOOKING_BAND)
  && rendered.service.text.includes("HOW A REPAIR VISIT GOES") && !rendered.service.text.includes(BOOKING_BAND)
  && rendered.spring_opening.text.includes(BOOKING_BAND)
  && rendered.fall_closing.text.includes("YOUR FUTURE FALL CLOSINGS") && rendered.fall_closing.text.includes(BOOKING_BAND));
ok("an unknown variant renders as service", welcome.renderWelcomeEmail({ variant: "nope" }).subject === rendered.service.subject);

// ---- 2. dueWelcomes ----------------------------------------------------

const NOW = new Date("2026-09-13T15:00:00.000Z");
const ago = (mins) => new Date(NOW.getTime() - mins * 60 * 1000).toISOString();
const ON = { welcomeEmail: { enabled: true } };
const OFF = { welcomeEmail: { enabled: false } };

const C = [
  { id: "C-1", name: "Ann Fresh", email: "ann@example.com" },
  { id: "C-2", name: "Bob Young", email: "bob@example.com" },
  { id: "C-3", name: "Cat Repeat", email: "cat@example.com" },
  { id: "C-4", name: "Dan Marked", email: "dan@example.com", welcomeEmail: { sentAt: ago(1000), variant: "service" } },
  { id: "C-5", name: "Eve Cancelled", email: "eve@example.com" },
  { id: "C-6", name: "Fay Noemail", email: "" },
  { id: "C-7", name: "Gus Repair", email: "gus@example.com" },
  { id: "C-8", name: "Hal Fall", email: "hal@example.com" }
];
const B = [
  { id: "BK-1", customerId: "C-1", serviceKey: "spring_open_4z", status: "confirmed", createdAt: ago(45) },
  { id: "BK-2", customerId: "C-2", serviceKey: "spring_open_4z", status: "confirmed", createdAt: ago(5) },        // too young
  { id: "BK-3a", customerId: "C-3", serviceKey: "fall_close_4z", status: "completed", createdAt: ago(60 * 24 * 200) }, // first (dead)
  { id: "BK-3b", customerId: "C-3", serviceKey: "spring_open_4z", status: "confirmed", createdAt: ago(45) },      // second booking
  { id: "BK-4", customerId: "C-4", serviceKey: "spring_open_4z", status: "confirmed", createdAt: ago(45) },        // marked
  { id: "BK-5", customerId: "C-5", serviceKey: "spring_open_4z", status: "cancelled", createdAt: ago(45) },        // cancelled
  { id: "BK-6", customerId: "C-6", serviceKey: "spring_open_4z", status: "confirmed", createdAt: ago(45) },        // no email
  { id: "BK-7", customerId: "C-7", serviceKey: "service_call", status: "confirmed", createdAt: ago(45) },
  { id: "BK-8", customerId: "C-8", serviceKey: "fall_close_6z", status: "pending", createdAt: ago(45) },
  { id: "BK-9", customerId: null, customerEmail: "orphan@example.com", serviceKey: "service_call", status: "confirmed", createdAt: ago(45) }
];

const due = welcome.dueWelcomes({ bookings: B, customers: C, now: NOW, settings: ON });
const dueIds = due.map((d) => d.booking.id).sort();
ok("exactly the new, settled, live, emailable first bookings are due",
  JSON.stringify(dueIds) === JSON.stringify(["BK-1", "BK-7", "BK-8"]), JSON.stringify(dueIds));
ok("a booking younger than 30 minutes waits", !dueIds.includes("BK-2"));
ok("a customer's SECOND booking is not a new customer, even when the first is dead",
  !dueIds.includes("BK-3b") && !dueIds.includes("BK-3a"));
ok("an already-marked customer is never due again", !dueIds.includes("BK-4"));
ok("a cancelled booking earns nothing", !dueIds.includes("BK-5"));
ok("no email on customer or booking → not due", !dueIds.includes("BK-6"));
ok("a booking without a customerId is skipped", !dueIds.includes("BK-9"));
ok("variant follows the service key: spring → spring_opening, fall → fall_closing, else service",
  due.find((d) => d.booking.id === "BK-1").variant === "spring_opening"
  && due.find((d) => d.booking.id === "BK-8").variant === "fall_closing"
  && due.find((d) => d.booking.id === "BK-7").variant === "service");
ok("the sweep never picks installation on its own",
  due.every((d) => d.variant !== "installation")
  && welcome.variantForServiceKey("spring_opening") === "spring_opening"
  && welcome.variantForServiceKey("fall_closing") === "fall_closing"
  && welcome.variantForServiceKey("") === "service");
ok("the toggle off returns nothing at all",
  welcome.dueWelcomes({ bookings: B, customers: C, now: NOW, settings: OFF }).length === 0
  && welcome.dueWelcomes({ bookings: B, customers: C, now: NOW, settings: {} }).length === 0);
ok("exactly at 30 minutes counts; a second short does not",
  welcome.dueWelcomes({ bookings: [{ ...B[0], createdAt: ago(30) }], customers: C, now: NOW, settings: ON }).length === 1
  && welcome.dueWelcomes({ bookings: [{ ...B[0], createdAt: new Date(NOW.getTime() - welcome.MIN_AGE_MS + 1000).toISOString() }], customers: C, now: NOW, settings: ON }).length === 0);
ok("a cancelled FIRST booking followed by a live second one does not make the second 'first'",
  !welcome.dueWelcomes({
    bookings: [
      { id: "X-1", customerId: "C-1", serviceKey: "spring_open_4z", status: "cancelled", createdAt: ago(500) },
      { id: "X-2", customerId: "C-1", serviceKey: "spring_open_4z", status: "confirmed", createdAt: ago(45) }
    ], customers: C, now: NOW, settings: ON
  }).some((d) => d.booking.id === "X-2"));

// autoSendCutoff: the 2026-09-15 incident. Enabling the switch for the
// first time must never treat a booking from long before that moment
// as newly due — before this existed, dueWelcomes had no concept of
// "before" at all, and the very first enable swept every customer
// PJL had ever had in one pass.
const WITH_CUTOFF = { welcomeEmail: { enabled: true, autoSendCutoff: ago(60) } };
ok("a booking older than the cutoff is excluded even though it is otherwise perfectly due",
  welcome.dueWelcomes({ bookings: [{ ...B[0], createdAt: ago(60 * 24 * 200) }], customers: C, now: NOW, settings: WITH_CUTOFF }).length === 0);
ok("a booking created after the cutoff is still picked up normally",
  welcome.dueWelcomes({ bookings: [{ ...B[0], createdAt: ago(45) }], customers: C, now: NOW, settings: WITH_CUTOFF }).length === 1);
ok("no cutoff set (the pre-fix shape) behaves exactly as before — this is what actually broke",
  welcome.dueWelcomes({ bookings: [{ ...B[0], createdAt: ago(60 * 24 * 200) }], customers: C, now: NOW, settings: ON }).length === 1);

// backfill list ignores the toggle, the cutoff, and the age, honours the mark
const backfill = welcome.backfillCandidates({ bookings: B, customers: C });
ok("backfill candidates ignore the switch and the 30-minute age but still honour the mark",
  backfill.map((r) => r.bookingId).sort().join(",") === "BK-1,BK-2,BK-7,BK-8"
  && backfill.every((r) => r.customerId !== "C-4"));
ok("a booking the cutoff would hide from the automatic sweep still shows up here — Patrick can still work through real history by hand",
  welcome.backfillCandidates({ bookings: [{ ...B[0], createdAt: ago(60 * 24 * 200) }], customers: C })
    .some((r) => r.bookingId === "BK-1"));

// ---- 3. Mark before send ------------------------------------------------

const settingsPath = path.join(SANDBOX, "server/data/settings.json");
await settingsLib.updateWelcomeEmail({ enabled: true }, { who: "test", now: ago(120) });
ok("settings writer flips the switch and audits it",
  (await settingsLib.get()).welcomeEmail.enabled === true
  && (await settingsLib.get()).audit.some((a) => a.action === "welcomeEmail")
  && fs.existsSync(settingsPath));
ok("settings default is OFF", settingsLib.DEFAULT_SETTINGS.welcomeEmail.enabled === false);
ok("the first-ever enable stamps autoSendCutoff to that moment, not the real clock",
  (await settingsLib.get()).welcomeEmail.autoSendCutoff === new Date(ago(120)).toISOString());
await settingsLib.updateWelcomeEmail({ enabled: false }, { who: "test" });
await settingsLib.updateWelcomeEmail({ enabled: true }, { who: "test", now: NOW });
ok("re-enabling later never moves the cutoff forward",
  (await settingsLib.get()).welcomeEmail.autoSendCutoff === new Date(ago(120)).toISOString());

const ann = await customers.create({ name: "Ann Fresh", email: "ann@example.com", phone: "9055550100" });
const gus = await customers.create({ name: "Gus Repair", email: "gus@example.com", phone: "9055550101" });
// Ivy pins the 2026-09-15 incident: a real customer from long before the
// switch was ever turned on, with no mark, exactly like every one of
// Patrick's actual customers the day this bug fired for real.
const ivy = await customers.create({ name: "Ivy Historical", email: "ivy@example.com", phone: "9055550103" });
const liveBookings = [
  { id: "BK-ANN", customerId: ann.id, serviceKey: "spring_open_4z", status: "confirmed", createdAt: ago(45), propertyId: "P-ANN" },
  { id: "BK-GUS", customerId: gus.id, serviceKey: "service_call", status: "confirmed", createdAt: ago(45) },
  { id: "BK-IVY", customerId: ivy.id, serviceKey: "spring_open_4z", status: "confirmed", createdAt: ago(60 * 24 * 200) }
];

const sentMail = [];
let throwFor = null;
const deps = {
  now: NOW,
  listBookings: async () => liveBookings,
  listCustomers: () => customers.list(),
  getSettings: () => settingsLib.get(),
  sendMail: async (msg) => {
    if (throwFor && msg.to === throwFor) throw new Error("smtp down");
    sentMail.push(msg);
    return { messageId: `m-${sentMail.length}` };
  },
  portalUrlFor: (b) => (b.propertyId ? `https://x/portal/${b.propertyId}` : "https://x/portal/login")
};

throwFor = "gus@example.com";
const first = await welcome.sweep(deps);
ok("sweep: one sent, one failed, both reported",
  first.due === 2 && first.sent === 1 && first.errors.length === 1 && first.errors[0].bookingId === "BK-GUS", JSON.stringify(first));
const annAfter = await customers.get(ann.id, { withProperties: false });
const gusAfter = await customers.get(gus.id, { withProperties: false });
ok("the sent customer carries the mark with variant, booking and by",
  annAfter.welcomeEmail?.sentAt && annAfter.welcomeEmail.variant === "spring_opening"
  && annAfter.welcomeEmail.bookingId === "BK-ANN" && annAfter.welcomeEmail.by === "sweep");
ok("a sendMail that THROWS still leaves the mark — a miss, never a double",
  gusAfter.welcomeEmail?.sentAt && gusAfter.welcomeEmail.variant === "service");
ok("the mark is on the customer's history line",
  annAfter.history.some((h) => h.changes && h.changes.welcomeEmail));
ok("the message is addressed, framed and linked like every other customer email",
  sentMail.length === 1 && sentMail[0].to === "ann@example.com"
  && /PJL Land Services/.test(sentMail[0].from) && sentMail[0].replyTo
  && sentMail[0].html.includes('href="https://x/portal/P-ANN"') && sentMail[0].text.startsWith("Hi Ann,"));
ok("a customer whose booking predates the day the switch was ever turned on is never auto-swept, unmarked, not mailed — the 2026-09-15 incident this pins",
  first.due === 2 && !sentMail.some((m) => m.to === "ivy@example.com")
  && !(await customers.get(ivy.id, { withProperties: false })).welcomeEmail);
ok("that same historical customer still shows up on the backfill table, for Patrick to send by hand",
  welcome.backfillCandidates({ bookings: liveBookings, customers: await customers.list() })
    .some((r) => r.customerId === ivy.id && r.bookingId === "BK-IVY"));

throwFor = null;
const second = await welcome.sweep(deps);
ok("the next sweep sends to NOBODY — not the success, and not the failure either",
  second.due === 0 && second.sent === 0 && sentMail.length === 1, JSON.stringify(second));

await settingsLib.updateWelcomeEmail({ enabled: false }, { who: "test" });
const hal = await customers.create({ name: "Hal Fall", email: "hal@example.com", phone: "9055550102" });
liveBookings.push({ id: "BK-HAL", customerId: hal.id, serviceKey: "fall_close_4z", status: "confirmed", createdAt: ago(45) });
const off = await welcome.sweep(deps);
ok("switch off: the sweep waits and marks nothing",
  off.waiting === "disabled" && off.due === 0 && !(await customers.get(hal.id, { withProperties: false })).welcomeEmail);

// manual send ignores the switch and can force past a mark
const manual = await welcome.sendWelcomeFor({
  customer: await customers.get(hal.id, { withProperties: false }),
  booking: liveBookings[2], variant: "installation", by: "admin",
  sendMail: deps.sendMail, portalUrlFor: deps.portalUrlFor
});
ok("a manual send goes out with the switch off, as installation, marked by admin",
  manual.ok && manual.variant === "installation"
  && (await customers.get(hal.id, { withProperties: false })).welcomeEmail.by === "admin"
  && sentMail[sentMail.length - 1].html.includes(INSTALLATION_SEASONS_HEADING));

// ---- 4. Installation invoice detection ---------------------------------

const proj = { id: "PR-1", branch: "direct_residential", finalInvoiceId: "INV-9" };
ok("final invoice of an install-branch project is detected",
  welcome.isFinalInstallationInvoice({ id: "INV-9", projectId: "PR-1" }, proj) === true);
ok("a repair-branch project is not an installation",
  welcome.isFinalInstallationInvoice({ id: "INV-9", projectId: "PR-1" }, { ...proj, branch: "residential_repair" }) === false
  && welcome.isFinalInstallationInvoice({ id: "INV-9", projectId: "PR-1" }, { ...proj, branch: "lighting_repair" }) === false);
ok("a deposit / non-final invoice of the project is not the final one",
  welcome.isFinalInstallationInvoice({ id: "INV-DEP", projectId: "PR-1" }, proj) === false
  && welcome.isFinalInstallationInvoice({ id: "INV-9", projectId: "PR-1" }, { ...proj, finalInvoiceId: null }) === false);
ok("an invoice pointing at a different project, or no project, is false",
  welcome.isFinalInstallationInvoice({ id: "INV-9", projectId: "PR-2" }, proj) === false
  && welcome.isFinalInstallationInvoice({ id: "INV-9" }, proj) === false
  && welcome.isFinalInstallationInvoice({ id: "INV-9", projectId: "PR-1" }, null) === false);

// ---- 5. Test send: all four variants, one inbox, nobody marked --------

{
  const sent = [];
  const r = await welcome.sendTestWelcomes({ to: "owner@example.com", sendMail: async (m) => { sent.push(m); return { messageId: "x" }; } });
  ok("test send delivers one email per variant", sent.length === welcome.VARIANTS.length && r.results.every((x) => x.ok));
  ok("every test email goes only to the given address", sent.every((m) => m.to === "owner@example.com"));
  ok("every test subject is prefixed [TEST", sent.every((m) => m.subject.startsWith("[TEST ")));
  ok("test emails keep their images (remote <img> tags survive)", sent.every((m) => (m.html.match(/<img /g) || []).length >= 8));
  let threw = false;
  try { await welcome.sendTestWelcomes({ to: "not-an-email", sendMail: async () => ({}) }); } catch { threw = true; }
  ok("test send refuses an invalid address", threw);
  {
    const real = [];
    await welcome.sendTestWelcomes({ to: "patrick@pjllandservices.com", sendMail: async (m) => { real.push(m); return {}; } });
    ok("test send accepts an address containing the letter s", real.length === welcome.VARIANTS.length);
    for (const bad of ["no-at-sign.com", "a@b", "a b@c.com", ""]) {
      let t2 = false;
      try { await welcome.sendTestWelcomes({ to: bad, sendMail: async () => ({}) }); } catch { t2 = true; }
      ok(`test send refuses "${bad}"`, t2);
    }
  }
  const partial = await welcome.sendTestWelcomes({ to: "owner@example.com", sendMail: async (m) => { if (m.subject.includes("service")) throw new Error("boom"); return {}; } });
  ok("one failed variant does not stop the others", partial.results.filter((x) => x.ok).length === welcome.VARIANTS.length - 1);
}

// ---- 6. Phone layout: nothing that should sit side by side stacks -----

{
  const html = welcome.renderWelcomeEmail({ variant: "installation" }).html;
  ok("no stacking column classes remain (badges and season icons never drop under their text)", !/class="col/.test(html) && !/\.col\s*\{/.test(html));
  ok("each season icon sits in its own cell beside its text", (html.match(/<td class="season-cell"[^>]*>\s*<img class="season-img"/g) || []).length === 2);
  ok("warranty and referral badges sit in a side cell beside their copy", (html.match(/<td class="side-cell"[^>]*>\s*<img class="side-img"/g) || []).length === 2);
  const inst = welcome.renderWelcomeEmail({ variant: "installation" }).html;
  ok("installation season paragraphs carry the mobile spacing hook", (inst.match(/<div class="txt" style="font-family:'DM Sans'[^"]*line-height:28px/g) || []).length >= 4);
}

// ---- Report ----------------------------------------------------------

if (failures.length) {
  console.error(`\n✗ test-welcome-email: ${failures.length} failed, ${pass} passed\n`);
  failures.forEach((f) => console.error(`  ✗ ${f}`));
  console.error("");
  process.exit(1);
}
console.log(`✓ test-welcome-email: ${pass} assertions passed`);
