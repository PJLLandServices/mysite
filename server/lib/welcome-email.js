// New-customer welcome email.
//
// One email, sent ONCE per customer, the first time they book with us:
// how routing works, what we record, how the season runs, how billing
// works.
//
// Four variants, each its OWN complete, self-contained design (a 600px
// table-layout email, images hosted on pjllandservices.com):
//   spring_opening — welcome-email-spring.html
//   fall_closing   — welcome-email-fall.html
//   service        — welcome-email-service.html. Not auto-booked like
//                    the two above (SERVICE_REPAIR_SPEC §7: every call
//                    is inbound), but a repair DOES auto-enrol the
//                    property onto the seasonal board (§5) — that fact
//                    is the one this variant exists to land, since it
//                    was blank/vague before.
//   installation   — welcome-email-installation.html. The customer never
//                    sees or approves "the design" (INSTALLATION_SPEC
//                    §4 Stage 2 — that's backend costing); they get the
//                    quote and a full explanation at handoff. Never
//                    promise "zero overspray" (§4 Stage 7) — the honest
//                    claim is full coverage, efficient delivery.
//
// All four rewritten Sep 2026 against Patrick's ops specs — every spec's
// §9 is explicit that internal routing/driving-cost/one-person-operation
// reasoning never reaches the customer, which the original shared draft
// (retired the same pass) violated throughout. Each file is fully
// self-contained: no cut-and-swap logic, no shared markers to drift.
//
// Lifecycle (the part that matters more than the HTML):
//   - The automatic sweep runs only while settings.welcomeEmail.enabled
//     is true. Default OFF. Manual sends from /admin/welcome-email ignore
//     the switch — Patrick pressing the button IS the consent.
//   - "New customer" = this booking is the customer's EARLIEST booking
//     (by createdAt) and the customer carries no welcomeEmail mark.
//   - The mark goes on the customer record BEFORE sendMail, so a crash
//     between the two errs quiet, never twice. Same posture as the
//     booking reminders and the assignment cadence.
//   - Test records are refused by the transport itself
//     (test-recipients.guardTransport), not by a private check here.
//   - Installation is never chosen by the sweep: it fires from the final
//     invoice of an installation project (server.js invoice send handler)
//     through sendWelcomeFor().
//
// Tested by scripts/test-welcome-email.mjs.

const fs = require("node:fs");
const path = require("node:path");
const bookings = require("./bookings");
const testRecipients = require("./test-recipients");
const { logSend } = require("./mailer-log");

// Every variant's own design — see the note at the top of this file.
const SPRING_TEMPLATE_FILE = path.join(__dirname, "welcome-email-spring.html");
let springTemplateCache = null;
function springTemplate() {
  if (springTemplateCache === null) springTemplateCache = fs.readFileSync(SPRING_TEMPLATE_FILE, "utf8");
  return springTemplateCache;
}

const FALL_TEMPLATE_FILE = path.join(__dirname, "welcome-email-fall.html");
let fallTemplateCache = null;
function fallTemplate() {
  if (fallTemplateCache === null) fallTemplateCache = fs.readFileSync(FALL_TEMPLATE_FILE, "utf8");
  return fallTemplateCache;
}

const SERVICE_TEMPLATE_FILE = path.join(__dirname, "welcome-email-service.html");
let serviceTemplateCache = null;
function serviceTemplate() {
  if (serviceTemplateCache === null) serviceTemplateCache = fs.readFileSync(SERVICE_TEMPLATE_FILE, "utf8");
  return serviceTemplateCache;
}

const INSTALLATION_TEMPLATE_FILE = path.join(__dirname, "welcome-email-installation.html");
let installationTemplateCache = null;
function installationTemplate() {
  if (installationTemplateCache === null) installationTemplateCache = fs.readFileSync(INSTALLATION_TEMPLATE_FILE, "utf8");
  return installationTemplateCache;
}

const VARIANTS = ["spring_opening", "fall_closing", "service", "installation"];

const SUBJECTS = {
  spring_opening: "Welcome to PJL Land Services — your spring opening is booked",
  fall_closing: "Welcome to PJL Land Services — your fall closing is booked",
  service: "Welcome to PJL Land Services — we've got your repair booked",
  installation: "Welcome to PJL Land Services — your new system, and what comes next"
};

const DEFAULT_PORTAL_URL = "https://www.pjllandservices.com/portal/login";
const DEFAULT_UNSUBSCRIBE_HREF = "mailto:info@pjllandservices.com?subject=Unsubscribe";

// A booking younger than this is still being made — the customer may be
// mid-flow, the confirmation is still landing, and a second email on top
// of it reads as noise. Thirty minutes is comfortably past all of that.
const MIN_AGE_MS = 30 * 60 * 1000;

// Same shape as notify-customer's — kept private there.
function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

const PORTAL_HREF = `href="${DEFAULT_PORTAL_URL}"`;
const UNSUBSCRIBE_HREF = `href="${DEFAULT_UNSUBSCRIBE_HREF}"`;

function normalizeVariant(variant) {
  return VARIANTS.includes(variant) ? variant : "service";
}

// booking.serviceKey → variant. Keys are the pricing.json ids
// (spring_open_4z, fall_close_6z, …) — the same prefix rule server.js
// uses to name a booking's family. The sweep never picks installation.
function variantForServiceKey(serviceKey) {
  const key = String(serviceKey || "").toLowerCase();
  if (key === "spring_opening" || key.startsWith("spring")) return "spring_opening";
  if (key === "fall_closing" || key.startsWith("fall")) return "fall_closing";
  return "service";
}

// Replace exactly one occurrence; throw if the design file has drifted so
// a silent no-op can't ship an email with the wrong link in it.
function replaceOnce(html, needle, replacement, what) {
  const at = html.indexOf(needle);
  if (at === -1) throw new Error(`${what} marker not found`);
  return html.slice(0, at) + replacement + html.slice(at + needle.length);
}

const OWN_TEMPLATE_BY_VARIANT = {
  spring_opening: springTemplate,
  fall_closing: fallTemplate,
  service: serviceTemplate,
  installation: installationTemplate
};

// Every variant is its own complete, self-contained design now (the last
// hold-out, installation, moved off the shared cut-and-swap template in
// the same Sep 2026 pass — see the note at the top of this file). Just
// the two universal link substitutions.
function renderHtml({ variant, portalUrl, unsubscribeUrl }) {
  let html = OWN_TEMPLATE_BY_VARIANT[variant]();
  html = replaceOnce(html, PORTAL_HREF, `href="${escapeHtml(portalUrl || DEFAULT_PORTAL_URL)}"`, `${variant} portal button`);
  if (unsubscribeUrl) {
    html = replaceOnce(html, UNSUBSCRIBE_HREF, `href="${escapeHtml(unsubscribeUrl)}"`, `${variant} unsubscribe link`);
  }
  return html;
}

// Spring's own plain-text alternative, matching welcome-email-spring.html.
// Kept separate from the shared renderText below rather than folded in,
// so editing spring's copy again can never accidentally touch fall's.
function renderSpringText({ firstName, portalUrl, unsubscribeUrl }) {
  const name = String(firstName || "").trim();
  const lines = [];
  lines.push(name ? `Hi ${name},` : "Hi,");
  lines.push("");
  lines.push("Thank you for choosing PJL Land Services. Finding a sprinkler company you can count on is harder than it should be. Calls go unanswered, appointments slip, and nobody explains what was done. You've made the right call, and we don't take that trust lightly.");
  lines.push("");
  lines.push("HOW YOUR BOOKING WAS MADE");
  lines.push("This is the only time you'll need to book. From next season on, we'll put you on the schedule ourselves and send you the date by email and text, with a link to your own appointment page. From that link, you can move the day, cancel it, or tell us to come whenever we're in the area. A simple acceptance confirms your spot, and we'll text you the day before as a reminder. You'll get a morning window, 8am to 12pm, or an afternoon window, 12pm to 5pm.");
  lines.push("");
  lines.push("YOUR FUTURE SPRING OPENINGS");
  lines.push("We start openings once the frost is out of the ground, never before. Every system is running by the May 24 long weekend. On the visit, we turn your water on, start the controller, and run every zone on its own to check coverage, pressure and operation. Anything found gets quoted and fixed on the spot where possible, including anything already noted on your fall closing, since that carries forward onto this visit.");
  lines.push("");
  lines.push("EVERY VISIT IS DOCUMENTED");
  lines.push("Our technicians record your shut-off, blow-out connection, valves, zone locations and coverage types. So when you call about a dry corner out back, you don't have to describe it — we already know which zone that is.");
  lines.push("");
  lines.push("YOUR YEAR WITH US");
  lines.push("Summer: our team is available for whatever your system throws at you, and repairs are often same-day. Fall: closings run through the same booking, starting from mid-September, and we work through the season until every system on the board is done.");
  lines.push("");
  lines.push("PLANNING A LANDSCAPE RENOVATION?");
  lines.push("Call us once you have the plan in hand, before the work begins. We'll walk the property with you and make sure the irrigation is ready for your new landscape.");
  lines.push("");
  lines.push("WE STAND BEHIND OUR WORK");
  lines.push("Every repair we carry out is covered for one year, parts and labour.");
  lines.push("");
  lines.push("PAYING US");
  lines.push("Our technicians can take payment on the spot the moment the work is done: credit card, Apple Pay, Google Pay, or e-transfer. Invoices, receipts and work orders live in your portal:");
  lines.push(portalUrl || DEFAULT_PORTAL_URL);
  lines.push("");
  lines.push("SEND A NEIGHBOUR OR FRIEND OUR WAY");
  lines.push("When a neighbour or friend books with us, you get 10% off your seasonal service charge.");
  lines.push("");
  lines.push("Anything at all — (905) 960-0181 or info@pjllandservices.com.");
  lines.push("Thank you again for choosing us.");
  lines.push("");
  lines.push("PJL Land Services · Newmarket, Ontario · pjllandservices.com");
  lines.push(`You're receiving this because you booked a service with us. Unsubscribe: ${unsubscribeUrl || DEFAULT_UNSUBSCRIBE_HREF}`);
  return lines.join("\n");
}

// Fall's own plain-text alternative, matching welcome-email-fall.html.
// Same reason as renderSpringText: kept separate so touching one season's
// copy can never silently drift the other's.
function renderFallText({ firstName, portalUrl, unsubscribeUrl }) {
  const name = String(firstName || "").trim();
  const lines = [];
  lines.push(name ? `Hi ${name},` : "Hi,");
  lines.push("");
  lines.push("Thank you for choosing PJL Land Services. Finding a sprinkler company you can count on is harder than it should be. Calls go unanswered, appointments slip, and nobody explains what was done. You've made the right call, and we don't take that trust lightly.");
  lines.push("");
  lines.push("HOW YOUR BOOKING WAS MADE");
  lines.push("This is the only time you'll need to book. From next season on, we'll put you on the schedule ourselves and send you the date by email and text, with a link to your own appointment page. From that link, you can move the day, cancel it, or tell us to come whenever we're in the area. A simple acceptance confirms your spot, and we'll text you the day before as a reminder. You'll get a morning window, 8am to 12pm, or an afternoon window, 12pm to 5pm.");
  lines.push("");
  lines.push("YOUR FUTURE FALL CLOSINGS");
  lines.push("Closing bookings open from mid-September, and we work through the whole season until every system on the board is done. On the visit, we shut off water to your system, then blow out each zone with compressed air until it's fully clear. Your controller gets set for winter. Anything we find gets noted on your work order — nothing is quoted or sold on the spot. Whatever's noted carries forward and gets addressed at your next spring opening.");
  lines.push("");
  lines.push("EVERY VISIT IS DOCUMENTED");
  lines.push("Every visit gets written up on a work order: what we found, what we did, and anything worth flagging for next time — in plain language, not shorthand only we'd understand. So when you call about a dry corner out back, you don't have to describe it — we already know which zone that is.");
  lines.push("");
  lines.push("YOUR YEAR WITH US");
  lines.push("Next spring, we'll turn your system back on and fix anything noted on this visit — every system running again by the May 24 long weekend. Summer: our team is available for whatever your system needs, and most repairs are same-day.");
  lines.push("");
  lines.push("PLANNING A LANDSCAPE RENOVATION?");
  lines.push("Call us once you have the plan in hand, before the work begins. We'll walk the property with you and make sure the irrigation is ready for your new landscape.");
  lines.push("");
  lines.push("WE STAND BEHIND OUR WORK");
  lines.push("Every repair we carry out is covered for one year, parts and labour.");
  lines.push("");
  lines.push("PAYING US");
  lines.push("Our technicians can take payment on the spot the moment the work is done: credit card, Apple Pay, Google Pay, or e-transfer. Invoices, receipts and work orders live in your portal:");
  lines.push(portalUrl || DEFAULT_PORTAL_URL);
  lines.push("");
  lines.push("SEND A NEIGHBOUR OR FRIEND OUR WAY");
  lines.push("When a neighbour or friend books with us, you get 10% off your seasonal service charge.");
  lines.push("");
  lines.push("Anything at all — (905) 960-0181 or info@pjllandservices.com.");
  lines.push("Thank you again for choosing us.");
  lines.push("");
  lines.push("PJL Land Services · Newmarket, Ontario · pjllandservices.com");
  lines.push(`You're receiving this because you booked a service with us. Unsubscribe: ${unsubscribeUrl || DEFAULT_UNSUBSCRIBE_HREF}`);
  return lines.join("\n");
}

// Service's own plain-text alternative, matching welcome-email-service.html.
function renderServiceText({ firstName, portalUrl, unsubscribeUrl }) {
  const name = String(firstName || "").trim();
  const lines = [];
  lines.push(name ? `Hi ${name},` : "Hi,");
  lines.push("");
  lines.push("Thank you for choosing PJL Land Services. Finding a sprinkler company you can count on is harder than it should be. Calls go unanswered, appointments slip, and nobody explains what was done. You've made the right call, and we don't take that trust lightly.");
  lines.push("");
  lines.push("HOW YOU REACH US");
  lines.push("When something needs attention, call us at (905) 960-0181, use our AI intake tool online, or book a repair visit directly. Repairs are usually same-day, April through October. If you ever have an active leak, shut off your main water supply right away and call us. Now that we've been out, your property is on our books — your spring opening and fall closing will be booked for you automatically from here, the same as any long-time customer.");
  lines.push("");
  lines.push("HOW A REPAIR VISIT GOES");
  lines.push("We walk the system with you before quoting anything. If you used our AI intake tool and the on-site diagnosis matches, your first hour of labour is free. Once we know what's wrong, you get a written quote on the spot, with an estimated time, before any work starts. Approve it, ask for changes, or pass — no pressure. Most repairs are completed the same visit, with parts already on the truck. We repair systems installed by anyone: Hunter, Rain Bird, Toro, Orbit, all major brands.");
  lines.push("");
  lines.push("EVERY VISIT IS DOCUMENTED");
  lines.push("Every repair gets written up on a work order: what we found, what we did, and anything it changes about your system. So when you call about a dry corner out back, you don't have to describe it — we already know which zone that is.");
  lines.push("");
  lines.push("YOUR YEAR WITH US");
  lines.push("Spring: we start openings once the frost is out of the ground, never before, with every system running again by the May 24 long weekend. On the visit, we turn your water on, start the controller, and run every zone on its own to check coverage, pressure and operation. Anything found gets quoted and fixed on the spot where possible.");
  lines.push("");
  lines.push("Fall: closings open from mid-September, and we work through the whole season until every system on the board is done. On the visit, we shut off water to your system, then blow out each zone with compressed air until it's fully clear, and set your controller for winter. Anything we find gets noted on your work order and carries forward to your next spring opening.");
  lines.push("");
  lines.push("PLANNING A LANDSCAPE RENOVATION?");
  lines.push("Call us once you have the plan in hand, before the work begins. We'll walk the property with you and make sure the irrigation is ready for your new landscape.");
  lines.push("");
  lines.push("WE STAND BEHIND OUR WORK");
  lines.push("Every repair we carry out is covered for one year, parts and labour.");
  lines.push("");
  lines.push("PAYING US");
  lines.push("Our technicians can take payment on the spot the moment the work is done: credit card, Apple Pay, Google Pay, or e-transfer. Invoices, receipts and work orders live in your portal:");
  lines.push(portalUrl || DEFAULT_PORTAL_URL);
  lines.push("");
  lines.push("SEND A NEIGHBOUR OR FRIEND OUR WAY");
  lines.push("When a neighbour or friend books with us, you get 10% off your seasonal service charge.");
  lines.push("");
  lines.push("Anything at all — (905) 960-0181 or info@pjllandservices.com.");
  lines.push("Thank you again for choosing us.");
  lines.push("");
  lines.push("PJL Land Services · Newmarket, Ontario · pjllandservices.com");
  lines.push(`You're receiving this because you booked a service with us. Unsubscribe: ${unsubscribeUrl || DEFAULT_UNSUBSCRIBE_HREF}`);
  return lines.join("\n");
}

// Installation's own plain-text alternative, matching
// welcome-email-installation.html.
function renderInstallationText({ firstName, portalUrl, unsubscribeUrl }) {
  const name = String(firstName || "").trim();
  const lines = [];
  lines.push(name ? `Hi ${name},` : "Hi,");
  lines.push("");
  lines.push("Welcome to the PJL family. Your system is in and on file with us. We're not going anywhere — here's how we look after it from here.");
  lines.push("");
  lines.push("HOW YOUR SEASONS WORK FROM HERE");
  lines.push("You never have to book a spring opening or a fall closing. Every year, we put your property on the schedule ourselves and send you the date by email and text, with a link to your own appointment page. A simple acceptance confirms your spot, and we'll text you the day before as a reminder. Your first spring opening starts from what we already know about your system — there's nothing to rebuild, only to verify.");
  lines.push("");
  lines.push("EVERY VISIT IS DOCUMENTED");
  lines.push("Your install already built your property's record with us: every zone, what it waters, the heads on it, and where everything runs. So when you call about a dry corner out back, you don't have to describe it — we already know which zone that is.");
  lines.push("");
  lines.push("YOUR YEAR WITH US");
  lines.push("Spring: we start openings once the frost is out of the ground, never before, with every system running by the May 24 long weekend. Fall: closings open from mid-September, and we work through the whole season until every system on the board is done. Summer: our team is available for whatever your system needs, and most repairs are same-day.");
  lines.push("");
  lines.push("PLANNING MORE FOR THE PROPERTY?");
  lines.push("A new bed, a patio, a pool, landscape lighting — call us once you have the plan, before anyone breaks ground. We'll walk the property with you and make sure the irrigation is ready for it, rather than cutting back into what we just finished.");
  lines.push("");
  lines.push("WE STAND BEHIND OUR WORK");
  lines.push("Your new system carries three years, parts and labour. If something we installed gives you trouble, we come back. Repairs we carry out afterwards carry one year.");
  lines.push("");
  lines.push("PAYING US");
  lines.push("Our technicians can take payment on the spot the moment the work is done: credit card, Apple Pay, Google Pay, or e-transfer. Invoices, receipts and work orders live in your portal:");
  lines.push(portalUrl || DEFAULT_PORTAL_URL);
  lines.push("");
  lines.push("SEND A NEIGHBOUR OR FRIEND OUR WAY");
  lines.push("When a neighbour or friend books with us, you get 10% off your seasonal service charge.");
  lines.push("");
  lines.push("Anything at all — (905) 960-0181 or info@pjllandservices.com.");
  lines.push("You trusted us with a big project on your own property, and we don't take that lightly. Thank you for choosing us.");
  lines.push("");
  lines.push("PJL Land Services · Newmarket, Ontario · pjllandservices.com");
  lines.push(`You're receiving this because you booked a service with us. Unsubscribe: ${unsubscribeUrl || DEFAULT_UNSUBSCRIBE_HREF}`);
  return lines.join("\n");
}

function renderText({ variant, firstName, portalUrl, unsubscribeUrl }) {
  if (variant === "spring_opening") return renderSpringText({ firstName, portalUrl, unsubscribeUrl });
  if (variant === "fall_closing") return renderFallText({ firstName, portalUrl, unsubscribeUrl });
  if (variant === "service") return renderServiceText({ firstName, portalUrl, unsubscribeUrl });
  return renderInstallationText({ firstName, portalUrl, unsubscribeUrl });
}

function renderWelcomeEmail({ variant, firstName, portalUrl, unsubscribeUrl } = {}) {
  const v = normalizeVariant(variant);
  return {
    subject: SUBJECTS[v],
    html: renderHtml({ variant: v, portalUrl, unsubscribeUrl }),
    text: renderText({ variant: v, firstName, portalUrl, unsubscribeUrl })
  };
}

// ---- Lifecycle -----------------------------------------------------------

function firstNameOf(customer, booking) {
  const full = String(customer?.name || booking?.customerName || "").trim();
  return full.split(/\s+/)[0] || "";
}

function emailFor(customer, booking) {
  return String(customer?.email || booking?.customerEmail || "").trim().toLowerCase();
}

// The customer's earliest booking, by createdAt. A tie (same second) is
// broken by id so two readers can never disagree about which one it is.
function earliestBookingFor(customerId, all) {
  let best = null;
  for (const b of all) {
    if (!b || b.customerId !== customerId) continue;
    if (!best) { best = b; continue; }
    const a = Date.parse(b.createdAt) || 0;
    const c = Date.parse(best.createdAt) || 0;
    if (a < c || (a === c && String(b.id) < String(best.id))) best = b;
  }
  return best;
}

// Pure: which bookings owe their customer a welcome right now.
//   bookings  — every booking record (bookings.list)
//   customers — every customer record (customers.list)
//   now       — Date
//   settings  — the settings object (settings.get); the enabled switch
//               lives at settings.welcomeEmail.enabled
// Returns [{ booking, customer, variant }].
//
// settings.welcomeEmail.autoSendCutoff, when present, excludes any
// booking created before it. This is what keeps "enabled" meaning
// "start watching for new customers" instead of "every past customer
// who has no mark is due right now" — without it, the very first
// enable ever scans a real customer list back to day one and treats
// all of it as brand new (2026-09-15 incident: one sweep emailed every
// past customer). backfillCandidates() below calls this with no
// cutoff in its settings on purpose — that table is Patrick working
// through real historical gaps by hand, not the automatic sweep.
function dueWelcomes({ bookings: all = [], customers: custs = [], now = new Date(), settings = null } = {}) {
  if (settings?.welcomeEmail?.enabled !== true) return [];
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now) || Date.now();
  const cutoffMs = settings?.welcomeEmail?.autoSendCutoff ? Date.parse(settings.welcomeEmail.autoSendCutoff) : null;
  const customerById = new Map((custs || []).filter((c) => c && c.id).map((c) => [c.id, c]));
  const out = [];
  const seen = new Set();
  for (const b of all || []) {
    if (!b || !b.customerId || seen.has(b.customerId)) continue;
    // Slot-holding status is the shared rule, never re-tested inline.
    if (!bookings.holdsItsSlot(b.status)) continue;
    const customer = customerById.get(b.customerId);
    if (!customer || customer.welcomeEmail?.sentAt) continue;
    if (!emailFor(customer, b)) continue;
    // Earliest booking across ALL of the customer's bookings — a second
    // booking is not a new customer, whatever the state of the first.
    const earliest = earliestBookingFor(b.customerId, all);
    if (!earliest || earliest.id !== b.id) continue;
    const createdAtMs = Date.parse(b.createdAt) || 0;
    if (cutoffMs !== null && createdAtMs < cutoffMs) continue;
    const age = nowMs - createdAtMs;
    if (age < MIN_AGE_MS) continue;
    seen.add(b.customerId);
    out.push({ booking: b, customer, variant: variantForServiceKey(b.serviceKey) });
  }
  return out;
}

let nodemailerCache = null;
function getNodemailer() {
  if (nodemailerCache !== null) return nodemailerCache;
  try { nodemailerCache = require("nodemailer"); } catch { nodemailerCache = false; }
  return nodemailerCache;
}

// Mirrors notify-customer's private getTransporter(): same Gmail creds,
// same test-recipient guard on the transport itself.
let transporterCache = null;
function getTransporter() {
  if (transporterCache) return transporterCache;
  const nodemailer = getNodemailer();
  if (!nodemailer) return null;
  if (!process.env.GMAIL_USER || !process.env.GMAIL_APP_PASSWORD) return null;
  transporterCache = testRecipients.guardTransport(nodemailer.createTransport({
    service: "gmail",
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD }
  }));
  return transporterCache;
}

function fromAddress() {
  return process.env.CUSTOMER_EMAIL || "info@pjllandservices.com";
}

// Send ONE welcome. Marks the customer first, then sends. deps:
//   customer, booking, variant — what to send and to whom
//   by            — "sweep" | the staff member's own name (never sent by
//                   an automatic path — see the cutoff check below)
//   markCustomer  — (customerId, mark) => Promise; default customers.update
//   sendMail      — (message) => Promise<info>; default: guarded transport
//   portalUrlFor  — (booking, customer) => absolute portal URL
//   unsubscribeUrlFor — optional (customer) => URL
//   now           — Date
//   settings      — settings.get()'s shape; only read for the cutoff
//                   check below, defaults to a fresh read when omitted
// Resolves { ok, to, variant, messageId } or throws AFTER the mark is
// down (the caller logs it; the next pass will not retry — by design).
async function sendWelcomeFor({
  customer,
  booking,
  variant,
  by = "sweep",
  markCustomer = null,
  sendMail = null,
  portalUrlFor = null,
  unsubscribeUrlFor = null,
  now = new Date(),
  settings = null
} = {}) {
  if (!customer || !customer.id) throw new Error("welcome: customer required");
  const v = normalizeVariant(variant);
  const to = emailFor(customer, booking);
  if (!to) throw new Error(`welcome: ${customer.id} has no email`);

  // Every automatic path shares this literal "sweep" value — the periodic
  // sweep itself, and the installation-invoice hook, which is automatic
  // in exactly the same sense even though it never calls dueWelcomes()
  // (installs aren't seen by the sweep at all — see server.js). A manual
  // send's `by` is always the staff member's own name (actorLabel()),
  // never this literal string, so this can never block Patrick's own
  // backfill-table sends. Enforced HERE, not only inside dueWelcomes(),
  // so any current or future automatic caller inherits the same rule
  // instead of having to remember to check first (2026-09-15 incident:
  // the installation hook had zero cutoff awareness and could still
  // re-fire the same failure through a routine invoice resend).
  if (by === "sweep") {
    const s = settings || await require("./settings").get();
    const cutoffMs = s?.welcomeEmail?.autoSendCutoff ? Date.parse(s.welcomeEmail.autoSendCutoff) : null;
    const createdAtMs = booking?.createdAt ? (Date.parse(booking.createdAt) || 0) : 0;
    if (cutoffMs !== null && createdAtMs < cutoffMs) {
      throw new Error(`welcome: ${customer.id} predates autoSendCutoff — automatic sends are blocked; use the backfill table on /admin/welcome-email to send by hand`);
    }
  }

  const mark = {
    sentAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    variant: v,
    bookingId: booking?.id || null,
    by
  };
  const marker = markCustomer || (async (id, m) => {
    const customers = require("./customers");
    return customers.update(id, { welcomeEmail: m }, { by: `welcome-${by}`, note: `Welcome email (${v}) marked before send` });
  });
  await marker(customer.id, mark);                         // mark FIRST

  const portalUrl = typeof portalUrlFor === "function" ? portalUrlFor(booking, customer) : "";
  const unsubscribeUrl = typeof unsubscribeUrlFor === "function" ? unsubscribeUrlFor(customer) : "";
  const rendered = renderWelcomeEmail({
    variant: v,
    firstName: firstNameOf(customer, booking),
    portalUrl,
    unsubscribeUrl
  });
  const message = {
    from: `"PJL Land Services" <${fromAddress()}>`,
    to,
    replyTo: fromAddress(),
    subject: rendered.subject,
    text: rendered.text,
    html: rendered.html
  };

  const send = sendMail || (async (msg) => {
    const transporter = getTransporter();
    if (!transporter) throw new Error("Email transport not configured (GMAIL_USER / GMAIL_APP_PASSWORD).");
    return transporter.sendMail(msg);
  });

  try {
    const info = await send(message);
    logSend({ kind: "welcome", to, ok: true, refId: customer.id });
    return { ok: true, to, variant: v, messageId: info?.messageId || null, suppressed: info?.suppressed === true };
  } catch (err) {
    logSend({ kind: "welcome", to, ok: false, error: err?.message, refId: customer.id });
    throw err;
  }
}

// One automatic pass. deps:
//   listBookings  — bookings.list
//   listCustomers — customers.list
//   getSettings   — settings.get
//   plus everything sendWelcomeFor takes (markCustomer, sendMail,
//   portalUrlFor, unsubscribeUrlFor, now).
async function sweep({
  now = new Date(),
  listBookings = bookings.list,
  listCustomers = null,
  getSettings = null,
  markCustomer = null,
  sendMail = null,
  portalUrlFor = null,
  unsubscribeUrlFor = null
} = {}) {
  const result = { due: 0, sent: 0, errors: [] };
  const settings = getSettings ? await getSettings() : await require("./settings").get();
  if (settings?.welcomeEmail?.enabled !== true) { result.waiting = "disabled"; return result; }
  const custs = listCustomers ? await listCustomers() : await require("./customers").list();
  const due = dueWelcomes({ bookings: await listBookings(), customers: custs, now, settings });
  result.due = due.length;
  for (const { booking, customer, variant } of due) {
    try {
      await sendWelcomeFor({ customer, booking, variant, by: "sweep", markCustomer, sendMail, portalUrlFor, unsubscribeUrlFor, now, settings });
      result.sent += 1;
    } catch (err) {
      result.errors.push({ bookingId: booking.id, customerId: customer.id, error: err?.message || String(err) });
    }
  }
  return result;
}

// Customers who have an earliest slot-holding booking and no mark —
// the backfill list for /admin/welcome-email. Ignores the toggle, the
// autoSendCutoff, and the 30-minute age (this is a human reading a
// table and choosing to send, not the automatic sweep).
function backfillCandidates({ bookings: all = [], customers: custs = [] } = {}) {
  const rows = dueWelcomes({
    bookings: all, customers: custs,
    now: new Date(Date.now() + MIN_AGE_MS * 2),
    settings: { welcomeEmail: { enabled: true } }
  });
  return rows.map(({ booking, customer, variant }) => ({
    customerId: customer.id,
    customerName: customer.name || booking.customerName || "",
    email: emailFor(customer, booking),
    bookingId: booking.id,
    bookingCreatedAt: booking.createdAt || null,
    serviceKey: booking.serviceKey || "",
    serviceLabel: booking.serviceLabel || "",
    variant
  })).sort((a, b) => String(b.bookingCreatedAt || "").localeCompare(String(a.bookingCreatedAt || "")));
}

// Is this invoice the FINAL invoice of an INSTALLATION project?
//
// Two facts, both already on the records:
//   - invoice.projectId (or sourceProjectId) names the project, and the
//     project's finalInvoiceId names the invoice the completion cascade
//     created — so "final" is the project pointing back at this invoice.
//   - The project mirrors its quote's branch, and quotes.js draws the
//     repair/installation line by branch (REPAIR_BRANCHES is the
//     exception list; everything else a project_proposal can be is
//     install/design-build work). Asked through quotes.isInstallationQuote
//     so the two readers cannot drift.
function isFinalInstallationInvoice(invoice, project) {
  if (!invoice || !project) return false;
  const projectId = invoice.projectId || invoice.sourceProjectId || null;
  if (!projectId || projectId !== project.id) return false;
  if (!project.finalInvoiceId || project.finalInvoiceId !== invoice.id) return false;
  const quotes = require("./quotes");
  return quotes.isInstallationQuote({ type: "project_proposal", branch: project.branch });
}

// Test send: every variant to ONE address, prefixed [TEST], with NO mark
// on any customer. Goes through the same guarded Gmail transport as a
// real welcome, so it proves the live path (images included) end to end.
// Patrick, 2026-09-13: the Gmail connector draft stripped every <img>;
// this is how the real rendering gets checked in a real inbox.
async function sendTestWelcomes({ to, portalUrl = DEFAULT_PORTAL_URL, sendMail = null } = {}) {
  const addr = String(to || "").trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(addr)) throw new Error("A valid email address is required for the test.");
  const send = sendMail || (async (msg) => {
    const transporter = getTransporter();
    if (!transporter) throw new Error("Email transport not configured (GMAIL_USER / GMAIL_APP_PASSWORD).");
    return transporter.sendMail(msg);
  });
  const results = [];
  for (const variant of VARIANTS) {
    // Render lives INSIDE the try too — a template that fails to build for
    // one variant must not throw the whole batch and leave the caller
    // unsure which of the earlier variants actually went out.
    try {
      const rendered = renderWelcomeEmail({ variant, firstName: "", portalUrl });
      const message = {
        from: `"PJL Land Services" <${fromAddress()}>`,
        to: addr,
        replyTo: fromAddress(),
        subject: `[TEST ${variant.replace(/_/g, " ")}] ${rendered.subject}`,
        text: rendered.text,
        html: rendered.html
      };
      const info = await send(message);
      logSend({ kind: "welcome", to: addr, ok: true, refId: `test-${variant}` });
      results.push({ variant, ok: true, suppressed: info?.suppressed === true });
    } catch (err) {
      logSend({ kind: "welcome", to: addr, ok: false, error: err?.message, refId: `test-${variant}` });
      results.push({ variant, ok: false, error: err?.message || String(err) });
    }
  }
  return { to: addr, results };
}

module.exports = {
  VARIANTS,
  SUBJECTS,
  MIN_AGE_MS,
  DEFAULT_PORTAL_URL,
  renderWelcomeEmail,
  variantForServiceKey,
  dueWelcomes,
  sendWelcomeFor,
  sendTestWelcomes,
  sweep,
  backfillCandidates,
  isFinalInstallationInvoice
};
