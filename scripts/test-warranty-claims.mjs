// Warranty claims — regression cover. Node-only, no server, no network:
// runs inside `npm run build:check` alongside the other test-*.mjs files.
//
// What this pins, and why each one is here rather than left to a manual
// walk:
//
//   1. The claim NUMBER FORMAT. It is Patrick's spec, it is printed in
//      every customer email, and it is the record id and the on-disk
//      directory name. A silent change to it orphans every stored file.
//   2. The per-year SEQUENCE, including the January reset and the
//      derive-from-store rule that stops a restored backup from
//      re-issuing a number.
//   3. The TRANSITION RULES — a denial without a written explanation and
//      a dispute against anything but a denial are the two things the
//      brief says must never happen.
//   4. PATH SAFETY on the claim id, which reaches path.join().
//   5. The INVOICE REFERENCE parser, whose job is to be generous with
//      what customers type without ever inventing a match.
//   6. The EMAIL BUILDERS: subject-line convention, and that customer
//      content is HTML-escaped rather than interpolated raw.
//   7. The SERVER WIRING, source-level: the routes exist, the admin ones
//      are gated, and the customer projection cannot leak the status
//      token. Source-level by design — proving these at runtime needs a
//      booted server, and build:check is node-only (same call as CRM-15
//      and CRM-17).
//
// Run alone:  node scripts/test-warranty-claims.mjs

import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const wc = require(path.join(ROOT, "server/lib/warranty-claims.js"));
const link = require(path.join(ROOT, "server/lib/warranty-claim-link.js"));
const notify = require(path.join(ROOT, "server/lib/notify-warranty.js"));

let passed = 0;
const failures = [];

function ok(name, cond, detail) {
  if (cond) { passed++; return; }
  failures.push(detail === undefined ? name : `${name} — got ${JSON.stringify(detail)}`);
}
function eq(name, actual, expected) {
  ok(name, Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected), actual);
}

// ---------------------------------------------------------------------
// 1. Claim number format — YYYY-MM-DD-000YYYYNNNN
// ---------------------------------------------------------------------
const D = { year: "2026", month: "08", day: "29" };

eq("first claim of 2026 formats correctly",
  wc.formatClaimNumber(D, 1), "2026-08-29-00020260001");
eq("the brief's own example round-trips",
  wc.formatClaimNumber(D, 9657), "2026-08-29-00020269657");
eq("serial is zero-padded to four",
  wc.formatClaimNumber(D, 42), "2026-08-29-00020260042");
eq("a different day changes only the date part",
  wc.formatClaimNumber({ year: "2026", month: "01", day: "03" }, 7), "2026-01-03-00020260007");
eq("the year appears twice — filed date and serial",
  wc.formatClaimNumber({ year: "2027", month: "12", day: "31" }, 1), "2027-12-31-00020270001");

// A four-digit serial caps at 9999 claims/year. Rather than wrap (which
// would issue a DUPLICATE number) the field widens.
eq("a five-figure year widens rather than wraps",
  wc.formatClaimNumber(D, 12345), "2026-08-29-000202612345");
ok("the widened form is still a valid claim number",
  wc.isValidClaimNumber(wc.formatClaimNumber(D, 12345)));

// ---------------------------------------------------------------------
// 2. Per-year sequence, derived from the store
// ---------------------------------------------------------------------
eq("an empty store starts at 1", wc.nextSequenceForYear([], 2026), 1);
eq("continues from the highest serial in that year",
  wc.nextSequenceForYear([{ seqYear: 2026, seq: 3 }, { seqYear: 2026, seq: 7 }], 2026), 8);
eq("ignores other years when counting",
  wc.nextSequenceForYear([{ seqYear: 2025, seq: 99 }], 2026), 1);
eq("resets each January",
  wc.nextSequenceForYear([{ seqYear: 2026, seq: 412 }], 2027), 1);
// The derive-from-store rule is what makes a restored backup safe: it
// reads the max ISSUED, so it can never hand out a number already taken.
eq("takes the max, not the count (gaps never re-issue)",
  wc.nextSequenceForYear([{ seqYear: 2026, seq: 1 }, { seqYear: 2026, seq: 9 }], 2026), 10);
eq("survives a malformed record", wc.nextSequenceForYear([{ seqYear: 2026, seq: "x" }], 2026), 1);

// ---------------------------------------------------------------------
// 3. Path safety — the id reaches path.join()
// ---------------------------------------------------------------------
ok("a real claim number validates", wc.isValidClaimNumber("2026-08-29-00020260001"));
for (const evil of [
  "../../../etc/passwd",
  "2026-08-29-00020260001/../../x",
  "2026-08-29-00020260001/x",
  "..%2f..%2fserver.js",
  "2026-08-29-0002026000",      // serial too short
  "26-08-29-00020260001",       // year too short
  "2026-08-29-11120260001",     // missing the 000 prefix
  "",
  null,
  undefined,
  "2026-08-29-00020260001\n"
]) {
  ok(`rejects ${JSON.stringify(evil)}`, wc.isValidClaimNumber(evil) === false, evil);
}

// ---------------------------------------------------------------------
// 4. Transition rules
// ---------------------------------------------------------------------
const received = { status: "received" };
const denied = { status: "denied" };

ok("deny with no explanation is refused",
  wc.canTransition(received, "denied", { note: "" }).ok === false);
ok("deny with a too-short explanation is refused",
  wc.canTransition(received, "denied", { note: "no" }).ok === false);
ok("the refusal explains it is for the customer",
  /explanation for the customer/i.test(wc.canTransition(received, "denied", { note: "" }).error));
ok("deny with a real explanation is allowed",
  wc.canTransition(received, "denied", { note: "Outside the one-year service window." }).ok === true);

ok("asking for info with no message is refused",
  wc.canTransition(received, "info_requested", { note: "" }).ok === false);
ok("asking for info with a message is allowed",
  wc.canTransition(received, "info_requested", { note: "Which zone is affected?" }).ok === true);

ok("a dispute against a live claim is refused",
  wc.canTransition(received, "disputed").ok === false);
ok("a dispute against a denial is allowed",
  wc.canTransition(denied, "disputed").ok === true);
ok("only a denied claim can be disputed (message)",
  /only a denied claim/i.test(wc.canTransition(received, "disputed").error));

ok("an unknown status is refused", wc.canTransition(received, "cancelled").ok === false);
ok("statuses with no note requirement pass note-free",
  wc.canTransition(received, "under_review").ok === true);

// Every status must be reachable and labelled — an unlabelled status
// would render as a raw enum key in a customer's inbox.
eq("ten statuses defined", wc.STATUSES.length, 10);
for (const s of wc.STATUSES) {
  ok(`${s} has an admin label`, typeof wc.STATUS_LABELS[s] === "string" && wc.STATUS_LABELS[s].length > 0);
  ok(`${s} has customer-facing wording`, typeof wc.STATUS_CUSTOMER_TEXT[s] === "string" && wc.STATUS_CUSTOMER_TEXT[s].length > 20);
}

// ---------------------------------------------------------------------
// 5. Open / closed / stale — what drives the reminders
// ---------------------------------------------------------------------
const now = Date.parse("2026-08-29T12:00:00Z");
const at = (hoursAgo) => new Date(now - hoursAgo * 3600_000).toISOString();

ok("received is open", wc.isOpen({ status: "received" }));
ok("resolved is closed", !wc.isOpen({ status: "resolved" }));
ok("denied is closed", !wc.isOpen({ status: "denied" }));
// A dispute puts the claim back on the worklist — this is the whole
// point of the dispute route.
ok("disputed re-opens the claim", wc.isOpen({ status: "disputed" }));
ok("service_booked is still open", wc.isOpen({ status: "service_booked" }));

ok("an open claim under 24h is not stale",
  !wc.isStale({ status: "received", lastStatusAt: at(23) }, now));
ok("an open claim past 24h is stale",
  wc.isStale({ status: "received", lastStatusAt: at(25) }, now));
ok("a closed claim is never stale however old",
  !wc.isStale({ status: "resolved", lastStatusAt: at(900) }, now));
ok("a disputed claim goes stale like any other open one",
  wc.isStale({ status: "disputed", lastStatusAt: at(48) }, now));
eq("hoursSinceStatus reports whole hours",
  wc.hoursSinceStatus({ lastStatusAt: at(30) }, now), 30);
eq("stale threshold is the 24h we promise the customer", wc.STALE_AFTER_MS, 24 * 60 * 60 * 1000);

// ---------------------------------------------------------------------
// 6. Invoice reference parsing
// ---------------------------------------------------------------------
const years = ["2026", "2025"];
const cands = (s) => link.invoiceIdCandidates(s, { years });

eq("a canonical id parses", cands("I-2026-0042"), ["I-2026-0042"]);
eq("spaces and casing are tolerated", cands("i 2026 42"), ["I-2026-0042"]);
eq("prose around the number is tolerated", cands("Invoice #2026-0042"), ["I-2026-0042"]);
eq("a bare number is tried against their invoice years",
  cands("42"), ["I-2026-0042", "I-2025-0042"]);
eq("a hash-prefixed bare number behaves the same",
  cands("#0042"), ["I-2026-0042", "I-2025-0042"]);
eq("no digits yields no guesses", cands("the one from last spring"), []);
eq("an empty reference yields nothing", cands(""), []);

// A reference carrying its own year must produce exactly ONE candidate.
// Falling through to the bare-number branch would re-read the year as a
// sequence (I-2026-0042 -> also I-2026-2026), and those are not near
// misses — they are valid ids that could belong to someone else.
eq("a year-bearing reference yields exactly one candidate", cands("I-2026-0042").length, 1);
ok("and never derives a candidate from the year digits",
  !cands("I-2026-0042").includes("I-2026-2026"));

// ---------------------------------------------------------------------
// 7. Email builders
// ---------------------------------------------------------------------
const sampleClaim = {
  id: "2026-08-29-00020260001",
  status: "denied",
  statusToken: "a".repeat(32),
  claimant: { firstName: "Dana", lastName: "Whitfield", name: "Dana Whitfield",
              email: "dana@example.com", phone: "905-555-0142", address: "12 Maple Grove" },
  invoiceRef: "I-2026-0042",
  description: "Zone 3 valve leaking.",
  attachments: [{ n: 1, kind: "invoice", filename: "inv.pdf", mediaType: "application/pdf", bytes: 1000 }],
  createdAt: "2026-08-29T10:00:00Z",
  denial: { reason: "Outside the window.", at: "2026-08-29T11:00:00Z" },
  link: {},
  history: []
};

const ack = notify.buildAckEmail({ ...sampleClaim, status: "received" });
ok("the acknowledgement names the claim number in the subject", ack.subject.includes(sampleClaim.id));
ok("the acknowledgement promises 24 hours", /24 hours/i.test(ack.html));
ok("it mentions the allocated department", /allocated/i.test(ack.html));
ok("it points at the portal/status link", ack.html.includes("warranty-claim-status.html"));
ok("it gives the urgent phone route", ack.html.includes("905"));
ok("the plain-text part carries the number too", ack.text.includes(sampleClaim.id));

const status = notify.buildStatusEmail(sampleClaim, { note: "Outside the window.", previousStatus: "under_review" });
ok("status emails use the RE: File Number convention",
  status.subject.startsWith("RE: Warranty Claim File Number"));
ok("the subject carries the claim number", status.subject.includes(sampleClaim.id));
ok("a denial carries the explanation", status.html.includes("Outside the window."));
ok("a denial offers the dispute route", /dispute/i.test(status.html));
ok("a denial states the service-call fee condition", /service-call fee/i.test(status.html));

const booked = notify.buildStatusEmail({ ...sampleClaim, status: "contact_customer", denial: null }, {});
ok("contact_customer promises first available contact", /first available time/i.test(booked.html));

// Customer-supplied text is escaped, never interpolated raw — a claim
// description is attacker-controlled input that lands in Patrick's inbox.
const xss = notify.buildTeamEmail({
  ...sampleClaim,
  claimant: { ...sampleClaim.claimant, name: '<script>alert(1)</script>' },
  description: '<img src=x onerror="alert(2)">',
  invoiceRef: '"><b>bold</b>'
}, { context: {} });
ok("a script tag in the name is escaped", !xss.html.includes("<script>"));
ok("the escaped form is present instead", xss.html.includes("&lt;script&gt;"));
ok("an onerror img in the description is escaped", !xss.html.includes("<img src=x"));
ok("a quote-break in the invoice ref is escaped", !xss.html.includes('"><b>bold</b>'));

// ---------------------------------------------------------------------
// 8. Server wiring — source-level
// ---------------------------------------------------------------------
const server = readFileSync(path.join(ROOT, "server/server.js"), "utf8");

ok("the store is wired in", server.includes('require("./lib/warranty-claims")'));
ok("the cross-check is wired in", server.includes('require("./lib/warranty-claim-link")'));
ok("the mailer is wired in", server.includes('require("./lib/notify-warranty")'));
ok("the handler is dispatched from handleApi", server.includes("handleWarrantyClaimsApi(req, res, pathname)"));

// Public intake must stay public; everything else under /api/warranty-claims
// must stay behind the admin gate. If these two lines ever swap order the
// intake 401s for real customers, or the queue opens to the world.
ok("the public intake is explicitly ungated",
  server.includes('if (pathname === "/api/warranty-claims" && method === "POST") return null;'));
ok("the rest of the CRM API is admin-gated",
  server.includes('if (pathname === "/api/warranty-claims" || pathname.startsWith("/api/warranty-claims/")) return "user";'));
ok("the ungate precedes the gate (order decides)",
  server.indexOf('"/api/warranty-claims" && method === "POST"') <
  server.indexOf('pathname.startsWith("/api/warranty-claims/")) return "user"'));
ok("the CRM queue page is admin-gated",
  server.includes('if (pathname === "/admin/warranty-claims" || pathname === "/admin/warranty-claims/") return "user";'));

ok("the queue page routes to its HTML", server.includes('relative: "/warranty-claims.html"'));
ok("the detail page routes to its HTML", server.includes('relative: "/warranty-claim.html"'));

// The customer projection is the boundary that keeps CRM research off the
// customer's screen. These three fields leaking would expose who we think
// they are, what else they've been invoiced, and the credential itself.
const projection = server.slice(
  server.indexOf("function publicWarrantyClaim("),
  server.indexOf("async function handleWarrantyClaimsApi(")
);
ok("the customer projection exists", projection.length > 100);
ok("the projection never emits statusToken", !/statusToken/.test(projection));
ok("the projection never emits the CRM link block", !/\blink\s*:/.test(projection));
ok("the projection filters history to entries with a status", projection.includes("filter((h) => h.to)"));
// The note rule: only the two notes written FOR the customer come through.
ok("the projection gates notes to info_requested/denied/customer",
  projection.includes('h.to === "info_requested" || h.to === "denied" || h.by === "customer"'));

// The reminder sweep must not fire an all-clear digest.
ok("the reminder sweep is scheduled", server.includes("sweepWarrantyClaims"));
ok("the sweep returns early when nothing is stale", server.includes("if (!stale.length) return;"));

// ---------------------------------------------------------------------
// 9. Public pages
// ---------------------------------------------------------------------
const form = readFileSync(path.join(ROOT, "warranty-claim.html"), "utf8");
const statusPage = readFileSync(path.join(ROOT, "warranty-claim-status.html"), "utf8");
const warrantyPage = readFileSync(path.join(ROOT, "warranty.html"), "utf8");

for (const field of ["firstName", "lastName", "phone", "email", "invoiceRef", "description", "invoiceFiles"]) {
  ok(`the form collects ${field}`, form.includes(`name="${field}"`) || form.includes(`id="wc-${field}"`) || form.includes(`'${field}'`));
}
ok("the form posts to the intake route", form.includes("/api/warranty-claims"));
ok("the form carries the honeypot", form.includes('name="contact_website"'));
ok("the form carries the time-trap", form.includes("data-pjl-ts"));
ok("the form loads the anti-bot helper", form.includes("js/anti-bot.js"));
ok("the form accepts PDF, PNG and JPEG", form.includes("application/pdf") && form.includes("image/png") && form.includes("image/jpeg"));
ok("the hero clears the fixed nav per convention", form.includes("var(--hero-nav-clearance)"));

// The status page URL always carries a live claim token, so it must never
// be indexed.
ok("the status page is noindex", /name="robots"\s+content="noindex/.test(statusPage));
ok("the status page states the fee condition before disputing",
  /service-call fee/i.test(statusPage));
ok("the status page requires ticking the acceptance box",
  statusPage.includes('id="wcs-fee-accept"'));
ok("the status page hero clears the nav", statusPage.includes("var(--hero-nav-clearance)"));

ok("the warranty page's claim CTA points at the form",
  warrantyPage.includes('href="warranty-claim.html"'));
ok("no 'File a warranty claim' CTA still points at contact.html",
  !/href="contact\.html"[^>]*>\s*File a warranty claim/i.test(warrantyPage));

// ---------------------------------------------------------------------
// 10. CRM pages
// ---------------------------------------------------------------------
const queueHtml = readFileSync(path.join(ROOT, "server/warranty-claims.html"), "utf8");
const detailHtml = readFileSync(path.join(ROOT, "server/warranty-claim.html"), "utf8");
const detailJs = readFileSync(path.join(ROOT, "server/warranty-claim.js"), "utf8");
const navBadges = readFileSync(path.join(ROOT, "server/nav-badges.js"), "utf8");

ok("the queue page has a reminder band", queueHtml.includes('id="wcqReminder"'));
ok("the queue page has status filters", queueHtml.includes("data-status-filter"));

// The six tools the brief names.
for (const action of ["under_review", "contact_customer", "info_requested", "service_booked", "resolved", "denied"]) {
  ok(`the detail page offers "${action}"`, detailHtml.includes(`data-action="${action}"`));
}
ok("deny is marked note-required in the UI too",
  /denied:\s*\{[^}]*noteRequired:\s*true/s.test(detailJs));
ok("info_requested is marked note-required in the UI too",
  /info_requested:\s*\{[^}]*noteRequired:\s*true/s.test(detailJs));
// Booking and approve both do more than flip a status (one mints a
// session, the other creates a work order), so both leave the PATCH path.
ok("booking uses its own route, not a plain PATCH",
  detailJs.includes('action === "service_booked" ? "book"'));
ok("the nav badge reads the outstanding count", navBadges.includes("/api/warranty-claims/outstanding"));
ok("the badge span exists on the admin pages", queueHtml.includes("data-warranty-badge"));

// ---------------------------------------------------------------------
// 11. Approve → work order → on-site conversion (the warranty escape hatch)
// ---------------------------------------------------------------------
const workOrders = require(path.join(ROOT, "server/lib/work-orders.js"));
const feeWaiver = require(path.join(ROOT, "server/lib/service-fee-waiver.js"));

// The two states added with the work-order hand-off.
ok("approved is a status", wc.STATUSES.includes("approved"));
ok("converted is a status", wc.STATUSES.includes("converted"));
// `approved` must stay OPEN: the claim is accepted but the repair has not
// happened, so it still owes the customer a visit and must stay in the
// queue and the reminder counts.
ok("approved is OPEN — the repair still has to happen", wc.isOpen({ status: "approved" }));
ok("converted is closed", !wc.isOpen({ status: "converted" }));
ok("an approved claim goes stale like any other open one",
  wc.isStale({ status: "approved", lastStatusAt: at(30) }, now));

// A conversion is a statement about a visit that happened. With no work
// order there was no visit, and the honest outcome is a plain denial.
ok("cannot convert a claim with no work order",
  wc.canTransition({ status: "approved" }, "converted", { note: "a long enough reason" }).ok === false);
ok("the refusal points at denial instead",
  /deny the claim instead/i.test(wc.canTransition({ status: "approved" }, "converted", { note: "a long enough reason" }).error));
ok("can convert a claim that has one",
  wc.canTransition({ status: "approved", workOrderId: "WO-1" }, "converted", { note: "a long enough reason" }).ok === true);

// Telling a customer that a visit promised free is now chargeable is the
// most contested thing this system does — it can never happen silently.
ok("converting requires a written reason",
  wc.canTransition({ status: "approved", workOrderId: "WO-1" }, "converted", { note: "" }).ok === false);
ok("the reason requirement is worded for a conversion, not a denial",
  /chargeable service call/i.test(wc.canTransition({ status: "approved", workOrderId: "WO-1" }, "converted", { note: "" }).error));

// The waiver reason the approve route stamps has to exist in the shared
// vocabulary, or the customer-facing label silently degrades to "No charge".
ok("'warranty' is a valid waiver reason", feeWaiver.WAIVER_REASONS.includes("warranty"));
eq("and reads as 'Warranty visit' to the customer",
  feeWaiver.friendlyWaiverReason({ waived: true, reason: "warranty" }), "Warranty visit");

// warrantyClaim must survive hydrate(). hydrate() rebuilds a WO key by key
// and readAll() writes the result back, so a field it forgets is DELETED
// on the next read — the trap documented at properties.js commPrefs.
ok("warrantyClaim is scope-protected (freezes at signature)",
  workOrders.SCOPE_PROTECTED_FIELDS.includes("warrantyClaim"));
ok("serviceFeeWaiver is scope-protected too",
  workOrders.SCOPE_PROTECTED_FIELDS.includes("serviceFeeWaiver"));
ok("a scope-protected change is detected on a locked WO",
  workOrders.findProtectedFieldTouched({ warrantyClaim: { claimId: "x" } }) === "warrantyClaim");
ok("a locked WO reports its scope frozen", workOrders.isScopeFrozen({ locked: true }) === true);
ok("an unlocked WO does not — this is the on-site window the conversion uses",
  workOrders.isScopeFrozen({ locked: false }) === false);

// Source-level: the WO model and the routes.
const woLib = readFileSync(path.join(ROOT, "server/lib/work-orders.js"), "utf8");
ok("blank() declares warrantyClaim", /\n\s*warrantyClaim: null,/.test(woLib));
ok("hydrate() rebuilds warrantyClaim (or it is erased on read)",
  woLib.includes("warrantyClaim: (w?.warrantyClaim && typeof w.warrantyClaim === \"object\" && w.warrantyClaim.claimId)"));
ok("create() accepts warrantyClaim", /async function create\(\{[^}]*warrantyClaim = null/s.test(woLib));
ok("update() persists warrantyClaim",
  woLib.includes('Object.prototype.hasOwnProperty.call(patch, "warrantyClaim")'));
// The pair "approved under claim X, then converted for reason Y" is the
// audit trail; dropping the approval half would leave a chargeable WO with
// no record it was ever a warranty visit.
ok("hydrate keeps `converted` alongside the original approval",
  /warrantyClaim[\s\S]{0,900}converted: \(w\.warrantyClaim\.converted/.test(woLib));

ok("the approve route exists", server.includes('/^\\/api\\/warranty-claims\\/([^/]+)\\/approve$/'));
ok("approve refuses to raise a second work order", server.includes("This claim already has work order"));
ok("approve waives the fee through the shared normalizer",
  /normalizeServiceFeeWaiver\(\s*\{ waived: true, reason: "warranty"/.test(server));
ok("approve requires a property to send a tech to",
  server.includes("there's no address to send a tech to"));
ok("approve stamps the claim, invoice and prior WO onto the work order",
  /warrantyClaim: \{[\s\S]{0,400}claimedInvoiceId: claim\.link\?\.invoiceId/.test(server));

// The conversion gate.
ok("the conversion is detected on the fee-waiver route", server.includes("isWarrantyConversion"));
ok("it fires only when a warranty waiver is actually being lifted",
  /isWarrantyConversion = Boolean\(\s*\n\s*!waiving &&/.test(server));
ok("it will not re-fire on an already-converted WO",
  /!warrantyProvenance\.converted/.test(server));
ok("a conversion demands a written reason", server.includes("conversionReason.length < 10"));
ok("the refusal names the claim and the work order",
  server.includes("was raised free of charge under warranty claim"));
ok("the conversion writes back to the claim", server.includes('warrantyClaims.setStatus(warrantyProvenance.claimId, "converted"'));
ok("and emails the customer the reason",
  /claimConversion[\s\S]{0,600}notifyWarranty\.sendStatusUpdate/.test(server));
// Ordering matters: the money change must be durable first. The reverse
// would risk a converted claim pointing at a WO still marked free.
ok("the claim write-back happens after the work-order update",
  server.indexOf("const updated = await workOrders.update(woPatch") === -1 &&
  server.indexOf("woPatch.warrantyClaim") < server.indexOf('warrantyClaims.setStatus(warrantyProvenance.claimId, "converted"'));
ok("a failed write-back is logged loudly rather than swallowed",
  server.includes("converted to chargeable but claim"));
// The pre-existing lock guard is what forces an unlock after signature.
ok("the fee-waiver route still refuses a signed work order",
  server.includes("Work order is signed and locked — the waiver can't change."));

// Customer wording for the two new states.
const approvedEmail = notify.buildStatusEmail({ ...sampleClaim, status: "approved", denial: null }, {});
ok("the approval email says there is no charge", /no charge/i.test(approvedEmail.html));
ok("and that a work order was raised", /work order/i.test(approvedEmail.html));
const convertedEmail = notify.buildStatusEmail({ ...sampleClaim, status: "converted", denial: null },
  { note: "Impact damage from a lawnmower, not our valve work." });
ok("the conversion email carries the reason", convertedEmail.html.includes("Impact damage from a lawnmower"));
// They authorised and signed on site — the email is a record of what they
// already agreed to, not a fresh refusal.
ok("the conversion email points at the signature they gave on site", /signed/i.test(convertedEmail.html));
ok("its plain-text half says so too", /signed/i.test(convertedEmail.text));
ok("a converted claim is never offered a dispute",
  wc.canTransition({ status: "converted", workOrderId: "WO-1" }, "disputed").ok === false);

// UI surfaces.
const woHtml = readFileSync(path.join(ROOT, "server/work-order.html"), "utf8");
const woJs = readFileSync(path.join(ROOT, "server/work-order.js"), "utf8");
const techHtml = readFileSync(path.join(ROOT, "server/work-order-tech.html"), "utf8");
const techJs = readFileSync(path.join(ROOT, "server/work-order-tech.js"), "utf8");

ok("the admin WO page shows the warranty panel", woHtml.includes('id="woWarrantyPanel"'));
ok("it names the prior work being honoured", woHtml.includes('id="woWarrantyPrior"'));
ok("it offers the convert control", woHtml.includes('id="woWarrantyConvertOpenBtn"'));
ok("the convert control demands a reason", woHtml.includes('id="woWarrantyConvertReason"'));
ok("and warns that the customer reads it", /customer reads this/i.test(woHtml));
ok("the admin page renders the panel", woJs.includes("renderWorkOrderWarranty"));
ok("the convert control posts through the same fee route (one code path for the money)",
  /postServiceFeeWaiver\(\{ waived: false, reason: reason \}\)/.test(woJs));
ok("the panel re-renders after a waiver change",
  /renderServiceFeeWaiver\(loadedWorkOrder\);\s*\n\s*renderWorkOrderWarranty\(loadedWorkOrder\);/.test(woJs));
ok("a failed claim write-back is surfaced to the admin",
  woJs.includes("could not be updated"));
// ONE path to lifting a warranty waiver. The generic "Remove" button on
// the waiver banner posts with no reason, so on a warranty WO it would
// always 422 — and its error lands in the collapsed waiver form where
// nobody can read it, making it look like a dead button.
ok("the generic waiver Remove is hidden on a live warranty WO",
  woJs.includes("removeBtn.hidden = locked || liveWarranty"));

// ---- The fee waiver is ADMIN ONLY (Patrick's ruling, 2026-08-29) ------
// Waiving or restoring the $95 changes what the customer pays, and on a
// warranty WO it decides whether the claim was honoured. A tech who finds
// a claim doesn't stack up reaches out to the office.
ok("the waiver route is gated to admin",
  server.includes('if (/^\\/api\\/work-orders\\/[^/]+\\/service-fee-waiver$/.test(pathname)) return "admin";'));
// needsAuth returns on FIRST match, so the specific rule is only load-
// bearing while it sits above the generic /api/work-orders "user" rule.
// Swap the two lines and every tech silently regains the control.
ok("and that rule sits ABOVE the generic work-orders rule",
  server.indexOf('service-fee-waiver$/.test(pathname)) return "admin"') <
  server.indexOf('if (pathname.startsWith("/api/work-orders")) return "user";'));
// Server is the source of truth; the UI gating below is convenience.
ok("waiving is hidden from a non-admin", woJs.includes("offer.hidden = !viewerIsAdmin"));
ok("removing is hidden from a non-admin", woJs.includes("|| !viewerIsAdmin"));
ok("converting requires admin in the UI too", woJs.includes("const canConvert = viewerIsAdmin"));
ok("a non-admin is told to contact the office instead",
  woJs.includes("woWarrantyAdminOnly"));
ok("and that note names the office", /contact the office/i.test(woHtml));
// The role resolves asynchronously AFTER the WO renders, so without a
// re-render the controls would keep whatever state they loaded with.
// They default hidden (fail closed), so this is what reveals them.
ok("the money controls re-render once the role resolves",
  /renderUnlockControls\(loadedWorkOrder\);[\s\S]{0,400}renderServiceFeeWaiver\(loadedWorkOrder\);[\s\S]{0,120}renderWorkOrderWarranty\(loadedWorkOrder\);/.test(woJs));
// A tech must keep the rest of their job — this is a scalpel, not a
// lockout of the work-order API. Exactly two work-order routes are
// admin-gated: unlock/relock (pre-existing, the same class of decision)
// and the fee waiver. Anything else appearing here means the lock was
// widened past what Patrick asked for.
const adminWoRoutes = (server.match(/^\s*if \(\/\^\\\/api[^\n]*work-orders[^\n]*return "admin";/gm) || []);
eq("exactly two work-order routes are admin-only", adminWoRoutes.length, 2);
ok("one of them is the pre-existing unlock/relock",
  adminWoRoutes.some((l) => l.includes("unlock|relock")), adminWoRoutes);
ok("the other is the fee waiver",
  adminWoRoutes.some((l) => l.includes("service-fee-waiver")), adminWoRoutes);
ok("a warranty WO is 'live' only until it is converted",
  /liveWarranty = [^;]*!wo\.warrantyClaim\.converted/.test(woJs));
// An error written into a hidden panel is worse than no error.
ok("a refused fee change falls back to an alert when its panel is hidden",
  woJs.includes("errEl.offsetParent === null) alert(msg)"));

ok("the tech UI shows the warranty banner", techHtml.includes('id="techWarranty"'));
ok("the tech banner names the claim", techHtml.includes('id="techWarrantyClaim"'));
ok("the tech is told to call the office rather than converting on a phone",
  /call the office/i.test(techHtml));
ok("the tech UI renders it", techJs.includes("renderTechWarranty"));
// Lifting a customer's waiver is a desk decision made against the full
// claim, not a tap in a driveway — the tech surface must stay read-only.
ok("the tech UI offers NO convert control", !techHtml.includes("woWarrantyConvertOpenBtn"));
ok("the tech banner flips to a chargeable warning once converted",
  techHtml.includes('id="techWarrantyConverted"'));
ok("and reminds the tech a signature is needed",
  /must sign for the work/i.test(techHtml));

const claimDetailHtml = readFileSync(path.join(ROOT, "server/warranty-claim.html"), "utf8");
ok("the claim page offers approve", claimDetailHtml.includes('data-action="approved"'));
ok("the claim page shows the raised work order", claimDetailHtml.includes('id="wcdWorkOrderCard"'));
ok("approve posts to its own route", detailJs.includes('action === "approved" ? "approve"'));
ok("approve is hidden once a work order exists",
  detailJs.includes("approveBtn.hidden = Boolean(payload.claim.workOrderId)"));
// Converting is a decision made by whoever attended, on the work order.
ok("the claim page does NOT offer convert as a button",
  !claimDetailHtml.includes('data-action="converted"'));

// ---------------------------------------------------------------------
console.log(`\ntest-warranty-claims: ${passed} assertions passed, ${failures.length} failed.`);
if (failures.length) {
  console.error("\nFailures:");
  for (const f of failures) console.error("  ✗ " + f);
  process.exit(1);
}
