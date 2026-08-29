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
eq("eight statuses defined", wc.STATUSES.length, 8);
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
ok("booking uses its own route, not a plain PATCH", detailJs.includes("/book"));
ok("the nav badge reads the outstanding count", navBadges.includes("/api/warranty-claims/outstanding"));
ok("the badge span exists on the admin pages", queueHtml.includes("data-warranty-badge"));

// ---------------------------------------------------------------------
console.log(`\ntest-warranty-claims: ${passed} assertions passed, ${failures.length} failed.`);
if (failures.length) {
  console.error("\nFailures:");
  for (const f of failures) console.error("  ✗ " + f);
  process.exit(1);
}
