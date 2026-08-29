// Warranty claims — the customer-facing "my PJL work broke inside the
// warranty window" intake, and the queue Patrick works it from.
//
// Distinct from lib/warranty.js, which is the warranty POLICY (how many
// months a work order's type earns). This module is the CLAIM: who asked,
// what for, what they attached, and where it got to. The two meet in
// lib/warranty-claim-link.js, which uses the policy to answer "is the work
// they're claiming against actually still under warranty?".
//
// CLAIM NUMBER — the format is Patrick's, recorded verbatim from the brief:
//
//     YYYY-MM-DD-000YYYYNNNN
//     └ filed date ┘└─ serial ─┘
//
//   e.g. 2026-08-29-00020260001
//
// The serial is `000` + the four-digit year + a four-digit per-year
// sequence that resets each January. The year appears twice on purpose —
// once in the filed date, once inside the serial — because that is the
// shape Patrick specified and it is what customers will read back over the
// phone. The number IS the record id: there is no second internal id to
// keep in sync, and every path that takes a claim id validates it against
// CLAIM_NUMBER_RE before touching disk.
//
// Because a sequential number is guessable, it is NOT the credential for
// the customer's status page. Each claim carries a separate 32-hex
// `statusToken` (same model as the permanent /portal/<token>): the number
// identifies, the token authorizes.
//
// STATUS ENUM — the six states Patrick asked for, plus the two terminal
// ones the queue needs to be able to empty:
//
//   received          filed, nobody has looked at it yet (the resting
//                     state every claim starts in)
//   under_review      "Warranty claim under review"
//   info_requested    a "RE: Warranty Claim File Number …" email went out
//                     asking the customer something
//   contact_customer  the customer has been told PJL will call them at the
//                     first available time
//   service_booked    a warranty service call is on the calendar
//   resolved          made right — terminal, and the only happy ending
//   denied            refused; a written explanation is REQUIRED (see
//                     canTransition) and the customer gets a dispute path
//   disputed          the customer disputed a denial and accepted that a
//                     service-call fee applies if the claim turns out not
//                     to match the work performed. Re-opens the claim.
//
// OPEN vs CLOSED drives the "outstanding claims" reminders: everything
// except resolved/denied is outstanding, and `disputed` is deliberately
// open — a dispute puts the claim back in Patrick's queue.
//
// Storage: server/data/warranty-claims.json, atomic writes (stage to .tmp,
// fsync, rename) — the quote-requests.js pattern. Uploaded files live at
// server/data/warranty-claim-files/<claimNumber>/<n>.<ext>; only their
// metadata is stored here, same split as lead photos.

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const FILE = path.join(__dirname, "..", "data", "warranty-claims.json");

// Serial is 4 digits, so 9999 claims in one year. If PJL ever files a
// ten-thousandth claim in a single year the sequence widens rather than
// wrapping — a duplicate claim number would be far worse than a long one.
const CLAIM_NUMBER_RE = /^\d{4}-\d{2}-\d{2}-000\d{4}\d{4,}$/;

const STATUSES = [
  "received",
  "under_review",
  "info_requested",
  "contact_customer",
  "service_booked",
  "resolved",
  "denied",
  "disputed"
];

const STATUS_LABELS = {
  received: "Received",
  under_review: "Under review",
  info_requested: "Info requested",
  contact_customer: "Contacting customer",
  service_booked: "Service call booked",
  resolved: "Resolved",
  denied: "Denied",
  disputed: "Disputed"
};

// What the CUSTOMER is told each status means. Kept here rather than in
// the mailer so the status page and the email can never describe the same
// status differently.
const STATUS_CUSTOMER_TEXT = {
  received: "We've received your warranty claim. Our warranty department is reviewing it and will be in contact within 24 hours.",
  under_review: "Your claim is being reviewed by our warranty department against the original work order and invoice.",
  info_requested: "We've emailed you a few questions about this claim. We'll pick it straight back up as soon as you reply.",
  contact_customer: "A PJL Land Services team member will contact you directly at the first available time.",
  service_booked: "Your warranty service call is booked. You'll get the appointment details separately.",
  resolved: "This warranty claim has been resolved. Thank you for giving us the chance to make it right.",
  denied: "This warranty claim was not approved. The explanation is in the email we sent you — if you disagree, you can dispute it.",
  disputed: "Your dispute has been received and your claim has been re-opened for review."
};

// Terminal-ish states. Everything else counts as outstanding and shows up
// in the reminder badge + the CRM's "needs an update" list.
const CLOSED_STATUSES = new Set(["resolved", "denied"]);

// Statuses that REQUIRE a written note before the transition is allowed.
// Denial is the one Patrick called out explicitly ("email required to
// explain"); info_requested is the same shape — an email the customer will
// read, so it cannot go out empty.
const NOTE_REQUIRED_STATUSES = new Set(["denied", "info_requested"]);
const MIN_NOTE_LEN = 10;

// How long a claim may sit untouched before the queue nags. Patrick's
// promise to the customer is 24 hours, so that is the clock the reminder
// runs on.
const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

// ---- File I/O ---------------------------------------------------------

async function ensureFile() {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  if (!fsSync.existsSync(FILE)) {
    await fs.writeFile(FILE, "[]\n", "utf8");
  }
}

async function readAll() {
  await ensureFile();
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed = JSON.parse(raw || "[]");
    return Array.isArray(parsed) ? parsed.map(hydrate) : [];
  } catch {
    return [];
  }
}

// Atomic write: stage to .tmp, fsync, rename — a crash mid-write can't
// leave a truncated store. Same as quote-requests.js writeAll.
async function writeAll(records) {
  await ensureFile();
  const json = JSON.stringify(records, null, 2) + "\n";
  const tmp = FILE + ".tmp";
  const handle = await fs.open(tmp, "w");
  try {
    await handle.writeFile(json, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await fs.rename(tmp, FILE);
}

// ---- Claim numbering --------------------------------------------------

function nowIso() { return new Date().toISOString(); }

// Filed-date parts in America/Toronto, not UTC. A claim filed at 9pm on
// the 29th in Newmarket must read 29, not the 30th — the number is a
// human-facing reference and it has to match the day the customer
// remembers filing it.
function torontoDateParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Toronto",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value || "";
  return { year: get("year"), month: get("month"), day: get("day") };
}

// Build the number from a filed date + a per-year sequence.
//   formatClaimNumber({year:"2026",month:"08",day:"29"}, 1)
//     -> "2026-08-29-00020260001"
function formatClaimNumber({ year, month, day }, sequence) {
  const seq = String(Math.max(1, Math.floor(Number(sequence) || 1))).padStart(4, "0");
  return `${year}-${month}-${day}-000${year}${seq}`;
}

// The per-year sequence is derived from the STORE, not from a counter
// file: the highest serial already issued for this year, plus one. That
// makes it self-healing — a hand-edited store or a restored backup can
// never hand out a number that is already taken.
function nextSequenceForYear(records, year) {
  let max = 0;
  for (const rec of records) {
    if (rec?.seqYear !== Number(year)) continue;
    const n = Number(rec.seq);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 1;
}

function isValidClaimNumber(value) {
  return typeof value === "string" && CLAIM_NUMBER_RE.test(value);
}

// ---- Hydration --------------------------------------------------------

function str(value, max) {
  const s = typeof value === "string" ? value.trim() : "";
  return max ? s.slice(0, max) : s;
}

function hydrateAttachment(att) {
  const n = Number(att?.n);
  return {
    n: Number.isFinite(n) && n > 0 ? Math.floor(n) : 1,
    // "invoice" — the copy of the invoice being claimed against.
    // "evidence" — photos/PDFs of the fault itself.
    kind: att?.kind === "invoice" ? "invoice" : "evidence",
    filename: str(att?.filename, 200),
    mediaType: str(att?.mediaType, 100) || "application/octet-stream",
    bytes: Number.isFinite(Number(att?.bytes)) ? Number(att.bytes) : 0,
    ext: str(att?.ext, 10) || "bin",
    addedAt: str(att?.addedAt) || nowIso()
  };
}

function hydrateHistory(entry) {
  return {
    ts: str(entry?.ts) || nowIso(),
    from: STATUSES.includes(entry?.from) ? entry.from : null,
    to: STATUSES.includes(entry?.to) ? entry.to : null,
    action: str(entry?.action, 60) || "status_change",
    by: str(entry?.by, 80) || "system",
    note: str(entry?.note, 4000),
    // Whether the customer was emailed about this entry. Recorded so the
    // CRM can show "customer notified" per row and so a resend is a
    // deliberate act rather than a guess.
    notified: entry?.notified === true
  };
}

function hydrate(rec) {
  const status = STATUSES.includes(rec?.status) ? rec.status : "received";
  const seq = Number(rec?.seq);
  const seqYear = Number(rec?.seqYear);
  const first = str(rec?.claimant?.firstName, 80);
  const last = str(rec?.claimant?.lastName, 80);
  return {
    id: str(rec?.id, 40),
    claimNumber: str(rec?.claimNumber, 40) || str(rec?.id, 40),
    seq: Number.isFinite(seq) ? seq : 0,
    seqYear: Number.isFinite(seqYear) ? seqYear : 0,
    status,
    claimant: {
      firstName: first,
      lastName: last,
      name: str(rec?.claimant?.name, 160) || [first, last].filter(Boolean).join(" "),
      email: str(rec?.claimant?.email, 200).toLowerCase(),
      phone: str(rec?.claimant?.phone, 40),
      address: str(rec?.claimant?.address, 300)
    },
    // Exactly what the customer typed in the invoice-reference box. Kept
    // raw and separate from the matched invoice id — the customer's memory
    // of their invoice number is evidence, not a foreign key.
    invoiceRef: str(rec?.invoiceRef, 120),
    description: str(rec?.description, 8000),
    attachments: Array.isArray(rec?.attachments) ? rec.attachments.map(hydrateAttachment) : [],
    // Cross-check result from lib/warranty-claim-link.js. Never trusted as
    // a decision — it is a research aid that says "this looks like customer
    // C, property P, invoice I" and shows its work via matchedBy.
    link: rec?.link && typeof rec.link === "object" ? {
      customerId: str(rec.link.customerId, 40) || null,
      propertyId: str(rec.link.propertyId, 40) || null,
      invoiceId: str(rec.link.invoiceId, 40) || null,
      workOrderId: str(rec.link.workOrderId, 40) || null,
      matchedBy: Array.isArray(rec.link.matchedBy) ? rec.link.matchedBy.map((m) => str(m, 60)).filter(Boolean) : [],
      confidence: ["strong", "partial", "none"].includes(rec.link.confidence) ? rec.link.confidence : "none",
      warranty: rec.link.warranty && typeof rec.link.warranty === "object" ? rec.link.warranty : null,
      checkedAt: str(rec.link.checkedAt) || null
    } : null,
    // Secret for the public status page. Minted at create(); never
    // regenerated, so a link in an old email keeps working.
    statusToken: str(rec?.statusToken, 64),
    bookingId: str(rec?.bookingId, 40) || null,
    workOrderId: str(rec?.workOrderId, 40) || null,
    // Booking-session token minted by the "book a warranty service call"
    // action. hydrate() rebuilds this record key by key and writeAll()
    // persists the hydrated result, so a key missing from THIS list isn't
    // merely hidden — it is deleted on the next read (the trap documented
    // at properties.js commPrefs). Anything setStatus() writes via
    // `extra` must therefore appear here.
    bookingSessionToken: str(rec?.bookingSessionToken, 80) || null,
    // Denial explanation — required, and shown to the customer verbatim.
    denial: rec?.denial && typeof rec.denial === "object" ? {
      reason: str(rec.denial.reason, 4000),
      by: str(rec.denial.by, 80),
      at: str(rec.denial.at) || null
    } : null,
    // Customer's dispute of a denial. feeAccepted records that they ticked
    // the "I accept a service-call fee applies if the claim doesn't match
    // the work performed" box — that acceptance is the whole point of the
    // dispute gate, so it is stored, not just validated.
    dispute: rec?.dispute && typeof rec.dispute === "object" ? {
      raisedAt: str(rec.dispute.raisedAt) || null,
      reason: str(rec.dispute.reason, 4000),
      feeAccepted: rec.dispute.feeAccepted === true
    } : null,
    history: Array.isArray(rec?.history) ? rec.history.map(hydrateHistory) : [],
    createdAt: str(rec?.createdAt) || nowIso(),
    updatedAt: str(rec?.updatedAt) || str(rec?.createdAt) || nowIso(),
    // Stamped on every status change. The reminder clock runs off this,
    // NOT off updatedAt — attaching a note or re-running the cross-check
    // updates the record without meaning anyone moved the claim forward.
    lastStatusAt: str(rec?.lastStatusAt) || str(rec?.createdAt) || nowIso()
  };
}

// ---- Derived state ----------------------------------------------------

function isOpen(claim) {
  return !CLOSED_STATUSES.has(claim?.status);
}

// A claim is stale when it is open and nothing has moved it for 24h. The
// `received` state is the one that matters most — that is the promise to
// the customer — but an open claim parked in any state needs the nag.
function isStale(claim, now = Date.now()) {
  if (!isOpen(claim)) return false;
  const ts = Date.parse(claim?.lastStatusAt || claim?.createdAt || "");
  if (!Number.isFinite(ts)) return false;
  return now - ts > STALE_AFTER_MS;
}

function hoursSinceStatus(claim, now = Date.now()) {
  const ts = Date.parse(claim?.lastStatusAt || claim?.createdAt || "");
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, Math.round((now - ts) / 3_600_000));
}

// Decorate a claim with the fields every surface wants but nothing should
// store (they are functions of the clock).
function decorate(claim, now = Date.now()) {
  return {
    ...claim,
    statusLabel: STATUS_LABELS[claim.status] || claim.status,
    open: isOpen(claim),
    stale: isStale(claim, now),
    hoursSinceStatus: hoursSinceStatus(claim, now)
  };
}

// ---- Transition rules -------------------------------------------------

// Returns { ok: true } or { ok: false, error }. Deliberately permissive
// about ORDER — a real claim can bounce between review, questions and a
// phone call in any sequence — and strict about the two things that must
// never happen silently:
//
//   1. A denial with no written explanation. Patrick's rule.
//   2. A dispute raised anywhere except against a denial. The dispute
//      button only exists because a claim was refused.
function canTransition(claim, nextStatus, { note = "" } = {}) {
  if (!STATUSES.includes(nextStatus)) {
    return { ok: false, error: `Unknown warranty claim status "${nextStatus}".` };
  }
  if (!claim) return { ok: false, error: "Claim not found." };
  if (nextStatus === "disputed" && claim.status !== "denied") {
    return { ok: false, error: "Only a denied claim can be disputed." };
  }
  if (NOTE_REQUIRED_STATUSES.has(nextStatus)) {
    const trimmed = String(note || "").trim();
    if (trimmed.length < MIN_NOTE_LEN) {
      const what = nextStatus === "denied"
        ? "Denying a claim needs a written explanation for the customer"
        : "Asking the customer for more information needs a written message";
      return { ok: false, error: `${what} (at least ${MIN_NOTE_LEN} characters).` };
    }
  }
  return { ok: true };
}

// ---- CRUD -------------------------------------------------------------

async function list() {
  return readAll();
}

async function get(id) {
  if (!isValidClaimNumber(id)) return null;
  const records = await readAll();
  return records.find((r) => r.id === id) || null;
}

async function getByStatusToken(token) {
  const t = String(token || "").trim();
  if (t.length < 16) return null;
  const records = await readAll();
  return records.find((r) => r.statusToken && r.statusToken === t) || null;
}

// Create a claim. `input` is the already-validated intake payload; this
// module does not sanitize HTML or check field presence — the route does
// that, because the error messages belong to the form.
//
// Returns the stored claim. The claim number is allocated inside the same
// read-modify-write as the append, so two simultaneous submissions cannot
// be handed the same serial.
async function create(input) {
  const records = await readAll();
  const now = nowIso();
  const dateParts = torontoDateParts(new Date());
  const year = Number(dateParts.year);
  const seq = nextSequenceForYear(records, year);
  const claimNumber = formatClaimNumber(dateParts, seq);

  const first = str(input?.firstName, 80);
  const last = str(input?.lastName, 80);
  const claim = hydrate({
    id: claimNumber,
    claimNumber,
    seq,
    seqYear: year,
    status: "received",
    claimant: {
      firstName: first,
      lastName: last,
      name: [first, last].filter(Boolean).join(" "),
      email: str(input?.email, 200).toLowerCase(),
      phone: str(input?.phone, 40),
      address: str(input?.address, 300)
    },
    invoiceRef: str(input?.invoiceRef, 120),
    description: str(input?.description, 8000),
    attachments: Array.isArray(input?.attachments) ? input.attachments : [],
    link: null,
    statusToken: crypto.randomBytes(16).toString("hex"),
    history: [{
      ts: now,
      from: null,
      to: "received",
      action: "filed",
      by: "customer",
      note: "",
      notified: false
    }],
    createdAt: now,
    updatedAt: now,
    lastStatusAt: now
  });

  records.unshift(claim);
  await writeAll(records);
  return claim;
}

// Apply a mutation to one claim under a fresh read-modify-write, so
// concurrent writers can't clobber each other. `mutator` receives the
// hydrated record and may mutate it in place; returning false aborts the
// write and yields { ok: false, error }.
async function mutate(id, mutator) {
  if (!isValidClaimNumber(id)) return { ok: false, error: "Invalid claim number." };
  const records = await readAll();
  const index = records.findIndex((r) => r.id === id);
  if (index === -1) return { ok: false, error: "Claim not found." };
  const claim = records[index];
  const result = mutator(claim);
  if (result && result.ok === false) return result;
  claim.updatedAt = nowIso();
  records[index] = hydrate(claim);
  await writeAll(records);
  return { ok: true, claim: records[index] };
}

// Move a claim to a new status, appending history. `notified` records
// whether the caller went on to email the customer — the caller passes it
// in after the send resolves, because only it knows.
async function setStatus(id, nextStatus, { note = "", by = "admin", action = "status_change", extra = null } = {}) {
  return mutate(id, (claim) => {
    const check = canTransition(claim, nextStatus, { note });
    if (!check.ok) return { ok: false, error: check.error };
    const now = nowIso();
    const from = claim.status;
    claim.status = nextStatus;
    claim.lastStatusAt = now;
    if (nextStatus === "denied") {
      claim.denial = { reason: String(note || "").trim(), by: String(by || "admin"), at: now };
    }
    if (extra && typeof extra === "object") Object.assign(claim, extra);
    claim.history.push({
      ts: now,
      from,
      to: nextStatus,
      action,
      by,
      note: String(note || "").trim(),
      notified: false
    });
    return { ok: true };
  });
}

// Record that the customer was emailed about the most recent history
// entry. Split from setStatus so a mail failure never rolls back a status
// change Patrick already made in the UI.
async function markNotified(id, { historyIndex = null } = {}) {
  return mutate(id, (claim) => {
    if (!claim.history.length) return { ok: true };
    const i = historyIndex == null ? claim.history.length - 1 : historyIndex;
    if (i < 0 || i >= claim.history.length) return { ok: true };
    claim.history[i].notified = true;
    return { ok: true };
  });
}

async function setLink(id, link) {
  return mutate(id, (claim) => {
    claim.link = { ...(link || {}), checkedAt: nowIso() };
    return { ok: true };
  });
}

async function setAttachments(id, attachments) {
  return mutate(id, (claim) => {
    claim.attachments = Array.isArray(attachments) ? attachments : [];
    return { ok: true };
  });
}

// Customer-raised dispute of a denial. feeAccepted MUST be true — the
// acceptance is the gate, so a dispute without it is refused rather than
// silently recorded as un-accepted.
async function raiseDispute(id, { reason = "", feeAccepted = false } = {}) {
  if (feeAccepted !== true) {
    return { ok: false, error: "You must accept that a service-call fee may apply before disputing." };
  }
  const claim = await get(id);
  const check = canTransition(claim, "disputed");
  if (!check.ok) return check;
  const now = nowIso();
  return mutate(id, (c) => {
    if (c.status !== "denied") return { ok: false, error: "Only a denied claim can be disputed." };
    c.dispute = { raisedAt: now, reason: String(reason || "").trim().slice(0, 4000), feeAccepted: true };
    c.status = "disputed";
    c.lastStatusAt = now;
    c.history.push({
      ts: now,
      from: "denied",
      to: "disputed",
      action: "disputed",
      by: "customer",
      note: String(reason || "").trim(),
      notified: false
    });
    return { ok: true };
  });
}

// Outstanding-work summary for the nav badge and the Today page.
async function outstandingSummary(now = Date.now()) {
  const records = await readAll();
  const open = records.filter(isOpen);
  const stale = open.filter((c) => isStale(c, now));
  return {
    open: open.length,
    stale: stale.length,
    // Newest-first is how the queue reads everywhere else; the reminder
    // list wants the opposite — oldest untouched claim is the urgent one.
    oldest: stale.length
      ? stale.slice().sort((a, b) => Date.parse(a.lastStatusAt) - Date.parse(b.lastStatusAt))[0].id
      : null
  };
}

module.exports = {
  STATUSES,
  STATUS_LABELS,
  STATUS_CUSTOMER_TEXT,
  CLOSED_STATUSES,
  NOTE_REQUIRED_STATUSES,
  MIN_NOTE_LEN,
  STALE_AFTER_MS,
  CLAIM_NUMBER_RE,
  isValidClaimNumber,
  formatClaimNumber,
  nextSequenceForYear,
  torontoDateParts,
  canTransition,
  isOpen,
  isStale,
  hoursSinceStatus,
  decorate,
  list,
  get,
  getByStatusToken,
  create,
  setStatus,
  markNotified,
  setLink,
  setAttachments,
  raiseDispute,
  outstandingSummary
};
