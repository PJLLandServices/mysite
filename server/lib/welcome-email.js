// New-customer welcome email.
//
// One email, sent ONCE per customer, the first time they book with us:
// how routing works, what we record, how the season runs, how billing
// works. The approved design lives beside this file as welcome-email.html
// (a 600px table-layout email, images hosted on pjllandservices.com) and
// is used byte-for-byte except for the deliberate substitutions below.
//
// Four variants:
//   spring_opening — its OWN design, welcome-email-spring.html.
//   fall_closing   — its OWN design, welcome-email-fall.html.
//                    Both rewritten Sep 2026 against Patrick's ops specs
//                    (SPRING_OPENING_SPEC.md / FALL_CLOSING_SPEC.md and
//                    friends) — every §9 in those specs is explicit that
//                    internal routing/driving-cost/one-person-operation
//                    reasoning never reaches the customer, which the
//                    original shared draft violated. Neither file
//                    participates in the booking-cut / seasons-insert /
//                    warranty-swap logic below — keep them self-contained.
//   service        — shared design (welcome-email.html), the "HOW YOUR
//                    BOOKING GOT MADE" band and its body come out; a
//                    repair customer has not met the season plan.
//   installation   — shared design, same cut, replaced by "HOW YOUR
//                    SEASONS WORK FROM HERE", and the warranty copy leads
//                    with three years.
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

const TEMPLATE_FILE = path.join(__dirname, "welcome-email.html");
let templateCache = null;
function template() {
  if (templateCache === null) templateCache = fs.readFileSync(TEMPLATE_FILE, "utf8");
  return templateCache;
}

// Spring's and fall's own designs — see the note at the top of this file.
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

// ---- Markers inside welcome-email.html ---------------------------------
// The template is sliced on its own section comments, so the design file
// can be re-exported from the editor without touching this module as long
// as those comments survive.
const BOOKING_START = "          <!-- ═══ BOOKING ═══ -->";
const BOOKING_END = "          <!-- curve into green -->";
const PORTAL_HREF = `href="${DEFAULT_PORTAL_URL}"`;
const UNSUBSCRIBE_HREF = `href="${DEFAULT_UNSUBSCRIBE_HREF}"`;
const WARRANTY_SERVICE_COPY =
  "Parts and labour on every repair we carry out. If something we touched gives you trouble, we come back. New system installations carry three years.";
const WARRANTY_INSTALLATION_COPY =
  "Your new system carries three years, parts and labour. If something we installed gives you trouble, we come back. Repairs we carry out afterwards carry one year.";

// Paragraph styling lifted from the removed block, verbatim.
const PARA_STYLE = "font-family:'DM Sans',Arial,Helvetica,sans-serif; font-size:16px; line-height:28px; color:#3D4A40;";
function para(text, first) {
  return `              <div class="txt" style="${PARA_STYLE}${first ? "" : " padding-top:16px;"}">\n                ${text}\n              </div>\n`;
}

const SEASONS_PARAGRAPHS = [
  "You never have to book a spring opening or a fall closing. Your property is on our season plan. Ahead of each season we place it on a route day, and the appointment comes to you by email and text with a link to your own appointment page.",
  "What we promise is a half-day, never a minute. Morning means an 8am to 12pm arrival window, afternoon means 12pm to 5pm. The exact minute belongs to the route and shifts as the day gets tuned, so you&rsquo;ll never be given a time that changes on you later.",
  "From your appointment page you can confirm, move to another open day, cancel, or tell us to come whenever we&rsquo;re in the area. You don&rsquo;t have to reply at all. Nobody gets un-booked for staying quiet, and you&rsquo;ll get a reminder text the day before.",
  "Our routes are built by area, sequencing streets and subdivisions so the day runs in order. Tight routes across York Region and the GTA mean less fuel and less windshield time, and that saving goes back into what we charge you."
];

function seasonsSection() {
  return (
    "          <!-- ═══ SEASONS ═══ -->\n" +
    "          <tr>\n" +
    "            <td style=\"background-color:#E8811F; padding:0;\">\n" +
    "              <div class=\"gutter\" style=\"font-family:'Barlow Condensed','Arial Narrow',Arial,sans-serif; font-size:22px; line-height:24px; font-weight:700; letter-spacing:1px; color:#FFFFFF; padding:16px 46px;\">\n" +
    "                HOW YOUR SEASONS WORK FROM HERE\n" +
    "              </div>\n" +
    "            </td>\n" +
    "          </tr>\n" +
    "          <tr>\n" +
    "            <td class=\"gutter\" style=\"background-color:#FFFDF8; padding:34px 46px 40px 46px;\">\n" +
    SEASONS_PARAGRAPHS.map((t, i) => para(t, i === 0)).join("") +
    "            </td>\n" +
    "          </tr>\n\n"
  );
}

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
  if (at === -1) throw new Error(`welcome-email.html: ${what} marker not found`);
  return html.slice(0, at) + replacement + html.slice(at + needle.length);
}

function renderHtml({ variant, portalUrl, unsubscribeUrl }) {
  // Spring and fall are fully separate designs — no booking cut, no
  // seasons insert, no warranty swap. Just the two universal link
  // substitutions.
  if (variant === "spring_opening" || variant === "fall_closing") {
    let seasonHtml = variant === "spring_opening" ? springTemplate() : fallTemplate();
    seasonHtml = replaceOnce(seasonHtml, PORTAL_HREF, `href="${escapeHtml(portalUrl || DEFAULT_PORTAL_URL)}"`, `${variant} portal button`);
    if (unsubscribeUrl) {
      seasonHtml = replaceOnce(seasonHtml, UNSUBSCRIBE_HREF, `href="${escapeHtml(unsubscribeUrl)}"`, `${variant} unsubscribe link`);
    }
    return seasonHtml;
  }
  let html = template();
  if (variant === "service" || variant === "installation") {
    const start = html.indexOf(BOOKING_START);
    const end = html.indexOf(BOOKING_END);
    if (start === -1 || end === -1 || end < start) {
      throw new Error("welcome-email.html: booking section markers not found");
    }
    html = html.slice(0, start) + (variant === "installation" ? seasonsSection() : "") + html.slice(end);
  }
  if (variant === "installation") {
    html = replaceOnce(html, WARRANTY_SERVICE_COPY, WARRANTY_INSTALLATION_COPY, "warranty copy");
  }
  html = replaceOnce(html, PORTAL_HREF, `href="${escapeHtml(portalUrl || DEFAULT_PORTAL_URL)}"`, "portal button");
  if (unsubscribeUrl) {
    html = replaceOnce(html, UNSUBSCRIBE_HREF, `href="${escapeHtml(unsubscribeUrl)}"`, "unsubscribe link");
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
  lines.push("Summer: our team is available for whatever your system throws at you, and repairs are often same-day. Fall: closings run through the same booking, no need to ask.");
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
  lines.push("Spring: anything noted on this visit gets addressed when we turn your system back on, with every system running by the May 24 long weekend. Summer: our team is available for whatever your system needs, and most repairs are same-day.");
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

function renderText({ variant, firstName, portalUrl, unsubscribeUrl }) {
  if (variant === "spring_opening") return renderSpringText({ firstName, portalUrl, unsubscribeUrl });
  if (variant === "fall_closing") return renderFallText({ firstName, portalUrl, unsubscribeUrl });
  const lines = [];
  const name = String(firstName || "").trim();
  lines.push(name ? `Hi ${name},` : "Hi,");
  lines.push("");
  lines.push("You're in the book. Letting someone onto your property is a big ask, and we don't take it lightly. Five minutes here and you'll know exactly how we run.");
  lines.push("");
  if (variant === "installation") {
    lines.push("HOW YOUR SEASONS WORK FROM HERE");
    lines.push("You never have to book a spring opening or a fall closing. Your property is on our season plan; ahead of each season we place it on a route day and the appointment comes to you by email and text with a link to your own appointment page. What we promise is a half-day, never a minute: morning is an 8am to 12pm arrival window, afternoon is 12pm to 5pm. From your appointment page you can confirm, move to another open day, cancel, or tell us to come whenever we're in the area. You don't have to reply at all, and you'll get a reminder text the day before. Our routes are built by area, and that saving goes back into what we charge you.");
    lines.push("");
  }
  lines.push("ON THE DAY");
  lines.push("1. We show up when we said, inside the window you booked.");
  lines.push("2. We find the fault first, before we touch anything.");
  lines.push("3. It's fixed, or it's quoted — a straight answer on what it is and what it costs before we order a thing.");
  lines.push("");
  lines.push("YOU GET THE RESULTS, NOT JUST THE REPAIR");
  lines.push("Every service is written up on a work order: what we found, what we did, and the health of the system. Your shut-off, blow-out connection, controller, valve boxes and every zone go on your property file and stay there.");
  lines.push("");
  lines.push("YOUR YEAR WITH US");
  lines.push("Spring — openings, every system on by the May long weekend. Summer — repairs, usually same-day, and free site meetings. Fall — closings, booked from mid-September, done before the freeze. You'll hear from us ahead of each season.");
  lines.push("");
  lines.push("PLANNING A LANDSCAPE RENOVATION?");
  lines.push("Call us once you've got the landscape plan in hand and we'll plan around it. Bringing us in afterwards means cutting back into finished work.");
  lines.push("");
  lines.push("WE STAND BEHIND THE WORK");
  lines.push(variant === "installation"
    ? "Your new system carries three years, parts and labour. If something we installed gives you trouble, we come back. Repairs we carry out afterwards carry one year."
    : "Parts and labour on every repair we carry out. If something we touched gives you trouble, we come back. New system installations carry three years.");
  lines.push("");
  lines.push("PAYING US — COMPLETELY PAPERLESS");
  lines.push("Our technicians carry secure card readers (Visa, Mastercard, Amex, tap or insert); e-transfer works too. Prefer not to pay at the door? We'll send the invoice and you can pay it from your phone. Your invoice, receipt and work order live in your portal:");
  lines.push(portalUrl || DEFAULT_PORTAL_URL);
  lines.push("");
  lines.push("SEND A NEIGHBOUR OR FRIEND OUR WAY");
  lines.push("10% off your seasonal service charge when they book an appointment. Applied once per seasonal service; can't be combined with other savings.");
  lines.push("");
  lines.push("Anything at all — (905) 960-0181 or info@pjllandservices.com.");
  lines.push("Glad to have you with us.");
  lines.push("");
  lines.push("PJL Land Services · Newmarket, Ontario · pjllandservices.com");
  lines.push(`You're receiving this because you booked a service with us. Unsubscribe: ${unsubscribeUrl || DEFAULT_UNSUBSCRIBE_HREF}`);
  return lines.join("\n");
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
function dueWelcomes({ bookings: all = [], customers: custs = [], now = new Date(), settings = null } = {}) {
  if (settings?.welcomeEmail?.enabled !== true) return [];
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now) || Date.now();
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
    const age = nowMs - (Date.parse(b.createdAt) || 0);
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
//   by            — "sweep" | "admin"
//   markCustomer  — (customerId, mark) => Promise; default customers.update
//   sendMail      — (message) => Promise<info>; default: guarded transport
//   portalUrlFor  — (booking, customer) => absolute portal URL
//   unsubscribeUrlFor — optional (customer) => URL
//   now           — Date
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
  now = new Date()
} = {}) {
  if (!customer || !customer.id) throw new Error("welcome: customer required");
  const v = normalizeVariant(variant);
  const to = emailFor(customer, booking);
  if (!to) throw new Error(`welcome: ${customer.id} has no email`);

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
      await sendWelcomeFor({ customer, booking, variant, by: "sweep", markCustomer, sendMail, portalUrlFor, unsubscribeUrlFor, now });
      result.sent += 1;
    } catch (err) {
      result.errors.push({ bookingId: booking.id, customerId: customer.id, error: err?.message || String(err) });
    }
  }
  return result;
}

// Customers who have an earliest slot-holding booking and no mark —
// the backfill list for /admin/welcome-email. Ignores the toggle and the
// 30-minute age (this is a human reading a table, not a robot sending).
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
