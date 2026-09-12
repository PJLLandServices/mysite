// Booking folder (spec §4.2) — first-class booking records.
//
// Historical context: bookings live embedded as `lead.booking` on the
// lead record. That model couples a booking to exactly one lead, can't
// represent multi-WO bookings (multi-day repairs), and doesn't carry
// prep notes or sourceQuoteId per spec §4.2.
//
// This module adds bookings.json as the canonical store going forward
// while keeping lead.booking populated as a read-side cache so existing
// admin/portal/CRM code keeps working without a rewrite.
//
// Booking shape (per spec §4.2):
//   {
//     id:                 "BK-YYYY-NNNN",
//     customerEmail:      normalized
//     customerName:       string
//     customerPhone:      string
//     propertyId:         string | null   (back-ref to properties.json)
//     leadId:             string | null   (back-ref to the lead that
//                                          spawned the booking — usually
//                                          set, occasionally null for
//                                          admin-spun bookings)
//     scheduledFor:       ISO datetime
//     durationMinutes:    int
//     serviceKey:         availability.js key (spring_open_4z etc.)
//     serviceLabel:       human-readable
//     zoneCount:          int | null
//     address:            string
//     status:             confirmed | tentative | cancelled |
//                         completed | no_show
//     prepNotes:          free-text (gate code, dog warning, etc.)
//     sourceQuoteId:      "Q-YYYY-NNNN" | null (when the booking came
//                         from an accepted quote)
//     workOrderIds:       string[]    (one booking → many WOs for
//                                      multi-day repairs)
//     createdAt, updatedAt
//     history:            [{ ts, action, by, note }]   audit trail
//   }
//
// IDs follow the same per-year + zero-padded counter pattern as
// Q-YYYY-NNNN, P-YYYY-NNNN, I-YYYY-NNNN for visual consistency.

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const { writeJsonAtomic } = require("./atomic-json");

const FILE = path.join(__dirname, "..", "data", "bookings.json");

const STATUSES = new Set(["confirmed", "tentative", "cancelled", "completed", "no_show"]);

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

async function writeAll(records) {
  await ensureFile();
  await writeJsonAtomic(FILE, records);
}

// The ONE definition of "this booking still occupies the calendar".
// server.js's bookingHoldsItsSlot delegates here; the two used to be
// separate rules and drifted (see test-booking-lifecycle.mjs).
// WHY A VISIT CAME OFF THE DAY, and what each answer means to the record.
//
// Patrick: "Customer calls throughout the day (or we go to house and
// already completed) we need a way ... to be able to 'Remove visit' ...
// but record it somewhere."
//
// Recording it somewhere IS the feature — dropping the stop is the easy
// part, and already automatic (a dead booking stops holding its slot and
// leaves the route without a line of resequencing code). What matters is
// that six months later the difference between "they rang and cancelled"
// and "nobody was home" is still on the record, because those are not the
// same event and only one of them is chargeable.
//
// `outcome` is chosen HERE, from the reason, and never taken from the
// caller: a phone deciding its own booking status is a phone that can mark
// anything a no-show.
const REMOVAL_REASONS = {
  customer_cancelled: { label: "Customer cancelled", outcome: "cancelled", notify: true },
  // NOT `completed`. Marking it complete would fire the completion cascade
  // and draft an invoice for work this crew did not do. It is a
  // cancellation with a note saying the work was already there.
  already_done: { label: "Already done", outcome: "cancelled", notify: false, asksWhy: true },
  no_answer: { label: "Nobody home", outcome: "no_show", notify: true },
  no_access: { label: "Couldn't get access", outcome: "cancelled", notify: true },
  weather: { label: "Weather", outcome: "cancelled", notify: true },
};

// The reasons a CUSTOMER gives when they cancel from their own
// appointment page.
//
// Separate from REMOVAL_REASONS above, deliberately: that is the TECH's
// vocabulary for why a visit did not happen ("nobody home", "couldn't get
// access"), and a customer cancelling in advance is answering a different
// question. They share `already_done` on purpose, and BOTH write the same
// `removalCode` field, so next February the answer is one query and not
// two half-answers in different places.
//
// WHY THIS EXISTS AT ALL. The appointment page always had a cancel box —
// a free-text textarea labelled "Anything we should know? (optional)".
// Patrick, 2026-09-11, after the first assignment blast: "People came
// back canceled. We need to prompt them to request why?" Nobody types
// into an optional box. A short list they can tap is the difference
// between a number you can act on and a column of blanks.
const CUSTOMER_CANCEL_REASONS = Object.freeze({
  already_done: { label: "I've already had it done" },
  another_company: { label: "I'm using another company" },
  selling: { label: "I'm selling / have sold the property" },
  not_this_year: { label: "I don't need it this year" },
  other: { label: "Something else" }
});

function isCustomerCancelReason(code) {
  return Object.prototype.hasOwnProperty.call(CUSTOMER_CANCEL_REASONS, String(code || ""));
}

// The list the appointment page renders. The page must not carry its own
// copy of these words: a label that drifts between the button a customer
// tapped and the row Patrick reads is a reason nobody can trust.
function customerCancelReasonList() {
  return Object.entries(CUSTOMER_CANCEL_REASONS).map(([code, def]) => ({ code, label: def.label }));
}

// The label to show a human for a reason code, from either vocabulary.
// One lookup so an alert, a CRM row and a report never disagree.
function reasonLabel(code) {
  const key = String(code || "");
  return CUSTOMER_CANCEL_REASONS[key]?.label || REMOVAL_REASONS[key]?.label || "";
}

// ---- What the CUSTOMER has done about this booking --------------------
//
// A DIFFERENT QUESTION from `status`. `status` answers "does this still
// hold its slot" — it is the engine's word, read by availability, the
// cadence, the calendar and the tech's day list, and an assignment
// booking is `confirmed` from the moment PJL books it because the truck
// is coming whether or not the customer has replied.
//
// Patrick, 2026-09-11: "the bookings page shows 'confirmed' but i'd like
// to see it maybe just say 'sent' first, and then once the customer
// clicks confirm then it flicks over to confirm."
//
// He is right, and the answer is NOT to change `status` — renaming it
// would stop the follow-up cadence dead, which selects on
// `status === "confirmed"`. The acknowledgement is already recorded
// separately (when they were messaged, when and how they answered), so
// this reads it back. Defined once, here, rather than in the page that
// happens to need it first (CLAUDE.md: two copies of a state test drift).
//
// A customer who booked THEMSELVES said yes by booking — there is no
// acknowledgement to wait for, so those stay "Booked".
const CUSTOMER_STATE_LABELS = Object.freeze({
  assigned: "Assigned",
  sent: "Sent",
  confirmed: "Confirmed",
  moved: "Moved",
  window: "Time requested",
  any_time: "Any time",
  booked: "Booked",
  cancelled: "Cancelled",
  completed: "Completed",
  no_show: "No-show"
});

const REPLY_STATES = Object.freeze({
  confirm: "confirmed",
  reschedule: "moved",
  window: "window",
  free_bucket: "any_time",
  cancel: "cancelled"
});

function customerState(booking) {
  if (!booking) return "booked";
  const status = String(booking.status || "").toLowerCase();
  // A dead booking's own state is the whole answer — what they did about
  // it before it died is history, not status.
  if (DEAD_STATUSES.has(status)) return status === "no_show" ? "no_show" : status;
  if (booking.source !== "assignment") return "booked";
  const outreach = booking.assignment?.outreach || null;
  if (!outreach) return "assigned";
  if (outreach.respondedAt) return REPLY_STATES[outreach.responseVia] || "confirmed";
  if (outreach.steps && outreach.steps["1"]) return "sent";
  return "assigned";
}

function customerStateLabel(booking) {
  return CUSTOMER_STATE_LABELS[customerState(booking)] || "Booked";
}

function isRemovalReason(code) {
  return Object.prototype.hasOwnProperty.call(REMOVAL_REASONS, String(code || ""));
}

// The status a reason resolves to. Unknown codes fall back to a plain
// cancellation rather than throwing: a visit that has to come off the day
// comes off the day, and a tech on a driveway is not the person to debug
// a vocabulary mismatch.
function removalOutcome(code) {
  return REMOVAL_REASONS[String(code || "")]?.outcome || "cancelled";
}

const DEAD_STATUSES = new Set(["cancelled", "completed", "no_show"]);
function holdsItsSlot(status) {
  return !DEAD_STATUSES.has(String(status || "").toLowerCase());
}

function blank() {
  const created = new Date().toISOString();
  return {
    id: "",
    // Canonical customer reference (Brief 2). Snapshots below stay
    // for back-compat with legacy code that reads booking fields
    // directly; new bookings resolve a customer at creation and set
    // customerId.
    customerId: null,
    customerEmail: "",
    customerName: "",
    customerPhone: "",
    propertyId: null,
    leadId: null,
    scheduledFor: null,
    durationMinutes: 0,
    serviceKey: "",
    serviceLabel: "",
    zoneCount: null,
    address: "",
    status: "confirmed",
    prepNotes: "",
    // Our own address lookup failed when this was booked — no Maps key, a
    // timeout, quota. The booking was taken anyway (never turn a customer
    // down over our outage) and flagged so the address gets a human's eye
    // before a tech drives to it. Null on every normally-booked record.
    verification: null,
    sourceQuoteId: null,
    workOrderIds: [],
    // Customer self-service guard. Bumped on every reschedule (admin
    // too — admins just bypass the cap downstream). The portal cancel/
    // reschedule endpoint refuses customer reschedules once this hits 1;
    // after that the customer must call. See server.js
    // customerActionPreflight() for the gate.
    rescheduleCount: 0,
    createdAt: created,
    updatedAt: created,
    history: [{ ts: created, action: "created", by: "system", note: "" }]
  };
}

function hydrate(b) {
  const base = blank();
  return {
    ...base,
    ...b,
    workOrderIds: Array.isArray(b?.workOrderIds) ? b.workOrderIds : [],
    history: Array.isArray(b?.history) ? b.history : [],
    rescheduleCount: Number.isFinite(b?.rescheduleCount) ? b.rescheduleCount : 0
  };
}

async function nextBookingId(year) {
  const records = await readAll();
  const prefix = `BK-${year}-`;
  let max = 0;
  for (const b of records) {
    if (typeof b.id === "string" && b.id.startsWith(prefix)) {
      const n = parseInt(b.id.slice(prefix.length), 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return `${prefix}${String(max + 1).padStart(4, "0")}`;
}

async function list() {
  return readAll();
}

async function get(id) {
  const records = await readAll();
  return records.find((b) => b.id === id) || null;
}

async function listByLead(leadId) {
  const records = await readAll();
  return records.filter((b) => b.leadId === leadId);
}

async function listByProperty(propertyId) {
  const records = await readAll();
  return records.filter((b) => b.propertyId === propertyId);
}

// Mirror an existing lead.booking shape into a first-class Booking
// record. Idempotent: if a Booking already references this leadId, it
// gets updated rather than duplicated. Returns the saved record.
//
// This is the bridge between the legacy embedded-on-lead model and the
// new canonical bookings.json. The lead intake / handoff routes call
// this after they create a lead.booking; the lead.booking stays as a
// read cache for existing CRM/portal code, and the canonical record
// lives here for new code (multi-WO links, prep notes, audit trail).
//
// LIFECYCLE (spec §2.8, D2). A lead keeps ONE embedded lead.booking, but
// its canonical history can hold several records: a cancelled one and
// the re-booking Patrick made from the lead card afterwards. The existing
// branch below used to be chosen on leadId alone and never touched
// status, so a re-book landed on the CANCELLED record — start moved, WO
// appended, status still "cancelled" — and every canonical reader
// (portal, iCal, Today, reminders, reschedule) treated the live
// appointment as dead while the lead-side readers held its slot.
//
// Rule now: the existing record is reused only while it still holds its
// slot. A DEAD record (cancelled / completed / no_show) is left exactly
// as it is — its history is the audit trail — and a lead that carries a
// NEW booking (a work-order id the record has never seen, or a different
// start) gets a fresh confirmed record. A re-sync of the SAME booking
// onto a dead record (the cascade re-syncing a completed job) is a
// no-op on status: nothing revives a finished appointment by accident.
async function upsertFromLead(lead) {
  if (!lead || !lead.booking) return null;
  const records = await readAll();
  const now = new Date().toISOString();
  const booking = lead.booking;
  const forLead = records.filter((b) => b.leadId === lead.id);
  const live = forLead.find((b) => holdsItsSlot(b.status));
  const dead = forLead.find((b) => !holdsItsSlot(b.status));
  const woId = booking.workOrder?.id || null;
  const isSameBooking = (rec) => Boolean(rec) && (
    (woId && (rec.workOrderIds || []).includes(woId))
    || (booking.start && rec.scheduledFor === booking.start)
  );
  // Reuse: the live record, else a dead record that IS this booking.
  const existing = live || (dead && isSameBooking(dead) ? dead : null);
  const rebookedOver = !existing && dead ? dead : null;

  // Admin force-booking marker. When the lead.booking was created via
  // the admin Custom-time override, we mirror the flag onto the
  // canonical record and stamp a force_booked_by_admin entry so audit
  // history shows "yes, this was created outside the normal corridor
  // and hours guardrails." Idempotent: a re-sync of an already-mirrored
  // forced booking should not re-stamp the audit entry.
  const carriesForceFlag = Boolean(booking.forcedByAdmin);

  if (existing) {
    existing.customerId = lead.customerId || existing.customerId;
    existing.customerEmail = (lead.contact?.email || existing.customerEmail || "").toLowerCase();
    existing.customerName = lead.contact?.name || existing.customerName;
    existing.customerPhone = lead.contact?.phone || existing.customerPhone;
    existing.propertyId = lead.propertyId || existing.propertyId;
    existing.scheduledFor = booking.start || existing.scheduledFor;
    existing.durationMinutes = Number(booking.durationMinutes) || existing.durationMinutes;
    existing.serviceKey = booking.serviceKey || existing.serviceKey;
    existing.serviceLabel = booking.serviceLabel || existing.serviceLabel;
    existing.zoneCount = (booking.zoneCount != null) ? booking.zoneCount : existing.zoneCount;
    existing.address = lead.contact?.address || existing.address;
    if (booking.workOrder?.id && !existing.workOrderIds.includes(booking.workOrder.id)) {
      existing.workOrderIds.push(booking.workOrder.id);
    }
    if (lead.quoteId && !existing.sourceQuoteId) existing.sourceQuoteId = lead.quoteId;
    const alreadyMirroredForce = Boolean(existing.forcedByAdmin);
    if (carriesForceFlag) existing.forcedByAdmin = true;
    // Only ever set, never cleared here: a re-sync from a lead whose
    // envelope has since been rewritten must not quietly clear a flag
    // that says a human should look at this address.
    if (booking.verification) existing.verification = booking.verification;
    existing.updatedAt = now;
    existing.history.push({ ts: now, action: "synced_from_lead", by: "system", note: "" });
    if (carriesForceFlag && !alreadyMirroredForce) {
      existing.history.push({
        ts: now,
        action: "force_booked_by_admin",
        by: "admin",
        note: "Bypassed corridor + hours guardrails."
      });
    }
    await writeAll(records);
    return existing;
  }

  const next = blank();
  next.id = await nextBookingId(new Date().getUTCFullYear());
  next.customerId = lead.customerId || null;
  next.customerEmail = (lead.contact?.email || "").toLowerCase();
  next.customerName = lead.contact?.name || "";
  next.customerPhone = lead.contact?.phone || "";
  next.propertyId = lead.propertyId || null;
  next.leadId = lead.id;
  next.scheduledFor = booking.start || null;
  next.durationMinutes = Number(booking.durationMinutes) || 0;
  next.serviceKey = booking.serviceKey || "";
  next.serviceLabel = booking.serviceLabel || "";
  next.zoneCount = (booking.zoneCount != null) ? booking.zoneCount : null;
  next.address = lead.contact?.address || "";
  next.status = booking.status || "confirmed";
  next.sourceQuoteId = lead.quoteId || null;
  if (carriesForceFlag) next.forcedByAdmin = true;
  if (booking.verification) next.verification = booking.verification;
  if (booking.workOrder?.id) next.workOrderIds = [booking.workOrder.id];
  next.history = [{
    ts: now,
    action: rebookedOver ? "rebooked_from_lead" : "created_from_lead",
    by: "system",
    note: rebookedOver
      ? `Lead ${lead.id} — new booking after ${rebookedOver.status} record ${rebookedOver.id}`
      : `Lead ${lead.id}`
  }];
  if (carriesForceFlag) {
    next.history.push({
      ts: now,
      action: "force_booked_by_admin",
      by: "admin",
      note: "Bypassed corridor + hours guardrails."
    });
  }
  records.unshift(next);
  await writeAll(records);
  return next;
}

// Heal every lead-held booking into the canonical store. The Bookings
// page, capacity math over bookings.json, and anything else canonical-
// only can only see records that went through upsertFromLead — and
// until now the only thing that ran that heal for the whole lead list
// was the iCal feed, which fires only when a calendar client happens to
// fetch, and swallowed every failure without a trace ("why are the
// Willowridge bookings not on the bookings page?"). This helper is the
// one shared loop: the feed calls it, and server.js runs it as a sweep
// at boot + on an interval, so the two stores can't quietly disagree.
//
// Takes the leads array as an argument (readLeads lives in server.js —
// same circular-dep avoidance as the feed). Idempotent: a lead whose
// canonical record exists is left alone entirely (NOT re-synced — the
// feed's original semantics; edits flow through the explicit paths).
// Returns what happened so the caller can log it loudly:
//   { healed, failures: [{ leadId, name, error }] }
// A lead.booking without a start is not listable anywhere and is
// skipped silently, exactly as the feed always has.
async function healFromLeads(leads = []) {
  const records = await readAll();
  const canonicalByLead = new Set(records.map((b) => b.leadId).filter(Boolean));
  const result = { healed: 0, failures: [] };
  for (const lead of leads) {
    if (!lead?.booking?.start) continue;
    if (canonicalByLead.has(lead.id)) continue;
    try {
      const upserted = await upsertFromLead(lead);
      if (upserted) result.healed += 1;
    } catch (err) {
      // The name is best-effort — on a record broken enough to fail the
      // upsert, even reading contact can throw, and the report must not.
      let name = "";
      try { name = lead.contact?.name || ""; } catch { /* keep "" */ }
      result.failures.push({ leadId: lead.id, name, error: err?.message || String(err) });
    }
  }
  return result;
}

// Create a canonical booking record directly — the property-first path.
// Everything before the assignment writer entered bookings.json through
// upsertFromLead (a lead books, the record mirrors); an assigned booking
// has no lead behind it, only a property, so it is born canonical here.
// activeBookings() in server.js already resolves coordinates for
// lead-less records through propertyId, and the iCal feed reads this
// store — nothing downstream needs a lead to exist.
//
// The caller supplies every field; this function only stamps identity
// (id, timestamps, history) and refuses records that would be invisible
// or unattributable. NOTHING here sends anything.
async function createDirect(fields, { by = "system", note = "" } = {}) {
  if (!fields || typeof fields !== "object") throw new Error("Booking fields are required.");
  if (!fields.scheduledFor || Number.isNaN(Date.parse(fields.scheduledFor))) {
    throw new Error("A valid scheduledFor is required.");
  }
  if (!fields.serviceKey) throw new Error("A serviceKey is required.");
  if (!fields.propertyId && !fields.leadId) {
    throw new Error("A booking needs a propertyId or a leadId to belong to someone.");
  }
  if (fields.status && !STATUSES.has(fields.status)) {
    throw new Error(`Unknown booking status: ${fields.status}`);
  }
  const records = await readAll();
  const next = blank();
  next.id = await nextBookingId(new Date().getUTCFullYear());
  next.customerId = fields.customerId || null;
  next.customerEmail = String(fields.customerEmail || "").toLowerCase();
  next.customerName = fields.customerName || "";
  next.customerPhone = fields.customerPhone || "";
  next.propertyId = fields.propertyId || null;
  next.leadId = fields.leadId || null;
  next.scheduledFor = new Date(fields.scheduledFor).toISOString();
  next.durationMinutes = Number(fields.durationMinutes) || 0;
  next.serviceKey = fields.serviceKey;
  next.serviceLabel = fields.serviceLabel || "";
  next.zoneCount = (fields.zoneCount != null) ? fields.zoneCount : null;
  next.address = fields.address || "";
  next.status = fields.status || "confirmed";
  next.prepNotes = fields.prepNotes || "";
  // Provenance — how this record came to exist. "assignment" marks the
  // season writer's records; the assignment block carries what it needs
  // to be reversed and audited (season, year, plan date, bucket, code).
  if (fields.source) next.source = fields.source;
  if (fields.assignment && typeof fields.assignment === "object") {
    next.assignment = { ...fields.assignment };
  }
  next.history = [{ ts: next.createdAt, action: "created", by, note }];
  records.unshift(next);
  await writeAll(records);
  return next;
}

// Update a booking record. Allowed fields are explicit so we don't
// accept arbitrary patches (e.g., changing leadId would break the
// back-reference).
async function update(id, patch) {
  const records = await readAll();
  const idx = records.findIndex((b) => b.id === id);
  if (idx === -1) return null;
  const current = records[idx];
  const next = { ...current };
  const allowed = ["status", "prepNotes", "scheduledFor", "durationMinutes", "serviceKey", "serviceLabel", "address", "customerName", "customerPhone", "customerEmail", "zoneCount", "sourceQuoteId"];
  for (const key of allowed) {
    if (patch && Object.prototype.hasOwnProperty.call(patch, key)) next[key] = patch[key];
  }
  if (Array.isArray(patch?.workOrderIds)) next.workOrderIds = patch.workOrderIds;
  if (patch && patch.status && !STATUSES.has(patch.status)) {
    throw new Error(`Unknown booking status: ${patch.status}`);
  }
  if (patch && patch.status && patch.status !== current.status) {
    next.history = [...(next.history || []), {
      ts: new Date().toISOString(),
      action: `status:${patch.status}`,
      by: patch.by || "admin",
      note: patch.note || ""
    }];
  }
  // Audit a service-type change (Book-from-lead follow-up: the appointment
  // type is now editable after booking, which also moves duration + price).
  if (patch && patch.serviceKey && patch.serviceKey !== current.serviceKey) {
    next.history = [...(next.history || []), {
      ts: new Date().toISOString(),
      action: "service_changed",
      by: patch.by || "admin",
      note: `${current.serviceLabel || current.serviceKey || "(unset)"} → ${patch.serviceLabel || patch.serviceKey}`
    }];
  }
  next.updatedAt = new Date().toISOString();
  records[idx] = next;
  await writeAll(records);
  return next;
}

// Move a booking's scheduledFor to a new ISO timestamp + push a history
// entry naming who did it and the previous time. Idempotent: a no-op
// reschedule (same start) returns the existing record unchanged. The
// caller is responsible for verifying slot availability before invoking
// this — the helper assumes the slot has already been validated.
async function reschedule(id, { scheduledFor, by = "admin", actorName = "", reason = "" } = {}) {
  if (!scheduledFor) throw new Error("scheduledFor is required.");
  if (Number.isNaN(Date.parse(scheduledFor))) throw new Error("Invalid scheduledFor.");
  const records = await readAll();
  const idx = records.findIndex((b) => b.id === id);
  if (idx === -1) return null;
  const current = records[idx];
  if (current.scheduledFor === scheduledFor) return current;

  const previous = current.scheduledFor;
  const next = { ...current };
  next.scheduledFor = scheduledFor;
  // Counter bumps on EVERY reschedule (admin too). The customer-side
  // cap (1 max) is enforced at the portal endpoint, not here — that
  // way admin can still move the booking after the customer's
  // single self-service move without juggling a second counter.
  next.rescheduleCount = (Number.isFinite(current.rescheduleCount) ? current.rescheduleCount : 0) + 1;
  next.updatedAt = new Date().toISOString();
  next.history = [...(current.history || []), {
    ts: next.updatedAt,
    action: "rescheduled",
    by,
    note: [
      actorName ? `${actorName} (${by})` : by,
      `${previous || "(unscheduled)"} → ${scheduledFor}`,
      reason ? `reason: ${reason}` : ""
    ].filter(Boolean).join(" · ")
  }];
  records[idx] = next;
  await writeAll(records);
  return next;
}

// Soft cancel — flips status to "cancelled", stamps the cancellation
// fields, appends a history entry. Caller is responsible for sending the
// customer-facing email (the notify-customer module handles that on a
// separate code path).
//
// Returns:
//   { ok: false, status: 404 } when the booking doesn't exist
//   { ok: false, status: 409 } when the booking is already cancelled or
//                              already completed (no_show / completed are
//                              terminal — re-cancel is rejected)
//   { ok: true, booking }      on success
async function cancel(id, { reason = "", reasonCode = "", by = "admin", actorName = "" } = {}) {
  const records = await readAll();
  const idx = records.findIndex((b) => b.id === id);
  if (idx === -1) return { ok: false, status: 404, errors: ["Booking not found."] };
  const current = records[idx];
  if (current.status === "cancelled") {
    return { ok: false, status: 409, errors: ["This booking is already cancelled."] };
  }
  if (current.status === "completed" || current.status === "no_show") {
    return { ok: false, status: 409, errors: [`Can't cancel a ${current.status} booking.`] };
  }
  const now = new Date().toISOString();
  const outcome = removalOutcome(reasonCode);
  const next = {
    ...current,
    status: outcome,
    // These keep their names for every reader that already knows them,
    // including a no-show: they are the audit fields for "this came off
    // the day", and inventing a parallel set would mean two places to look
    // and one of them eventually not updated.
    cancelledAt: now,
    cancelledBy: by,
    cancellationReason: reason || "",
    // The structured half. The free text is what a human wrote; this is
    // what a query can group by next February.
    removalCode: String(reasonCode || "") || null,
    updatedAt: now,
    history: [...(current.history || []), {
      ts: now,
      action: outcome === "no_show" ? "no_show" : "cancelled",
      by,
      note: [
        actorName ? `${actorName} (${by})` : by,
        reasonCode ? `why: ${reasonCode}` : "",
        reason ? `reason: ${reason}` : ""
      ].filter(Boolean).join(" · ")
    }]
  };
  records[idx] = next;
  await writeAll(records);
  return { ok: true, booking: next };
}

// Hard delete — removes the booking record entirely. Admin-only at the
// route layer. Refuses if the booking has any linked WOs that have moved
// past the `scheduled` state (i.e. tech has touched the WO). Use Cancel
// instead in that case.
//
// Returns:
//   { ok: false, status: 404 }                — booking missing
//   { ok: false, status: 409, linkedWoId }    — has an active linked WO
//   { ok: true }                              — removed
async function remove(id, { by = "admin", isActiveWo = null } = {}) {
  const records = await readAll();
  const idx = records.findIndex((b) => b.id === id);
  if (idx === -1) return { ok: false, status: 404, errors: ["Booking not found."] };
  const current = records[idx];
  // Caller passes isActiveWo(woId) -> bool that knows the WO lifecycle.
  // Decoupled here so this lib doesn't have to require work-orders.js.
  if (typeof isActiveWo === "function" && Array.isArray(current.workOrderIds)) {
    for (const woId of current.workOrderIds) {
      try {
        if (await isActiveWo(woId)) {
          return {
            ok: false,
            status: 409,
            errors: [`Can't delete — work order ${woId} is already in progress. Cancel the booking instead.`],
            linkedWoId: woId
          };
        }
      } catch (_) { /* if the WO check throws, treat as still-active for safety */ }
    }
  }
  records.splice(idx, 1);
  await writeAll(records);
  return { ok: true, deletedId: id, deletedBy: by };
}

// Merge a patch into booking.assignment.outreach — the cadence engine's
// state block: { token, blastAt, steps: { "1": {...} }, respondedAt,
// responseVia, responseBy }. Only assignment bookings carry it. update()
// deliberately can't reach booking.assignment, so cadence state has its
// own narrow writer with its own audit entry.
async function setAssignmentOutreach(id, patch, { action = "cadence", by = "system", note = "" } = {}) {
  const records = await readAll();
  const idx = records.findIndex((b) => b.id === id);
  if (idx === -1) return null;
  const current = records[idx];
  if (!current.assignment) throw new Error(`${id} is not an assignment booking.`);
  const outreach = { ...(current.assignment.outreach || {}) };
  for (const [key, value] of Object.entries(patch || {})) {
    if (key === "steps") {
      outreach.steps = { ...(outreach.steps || {}), ...value };
    } else {
      outreach[key] = value;
    }
  }
  const next = {
    ...current,
    assignment: { ...current.assignment, outreach },
    updatedAt: new Date().toISOString()
  };
  next.history = [...(current.history || []), {
    ts: next.updatedAt, action, by, note
  }];
  records[idx] = next;
  await writeAll(records);
  return next;
}

// Patrick moved a WHOLE ROUTE DAY (stage 6): this booking rides along.
// Deliberately NOT reschedule(): the day move is plan steering, so it
// does not bump rescheduleCount (the customer keeps their one self-serve
// move, and the time sweep keeps steering the record). Cadence rule 6:
// the old confirmation was for the old date — a moved day is a new
// promise needing a new acknowledgment — so the response state resets
// (stashed into history, never lost) and, when the customer was already
// messaged, a day-move notice is queued for the cadence sweep to send
// inside the send window. A queued notice that hasn't gone out yet keeps
// its ORIGINAL oldDate through further moves: the customer is told
// "was Sept 28, now Oct 3", not a chain of intermediate hops.
async function moveAssignmentDay(id, { toDate, toBucket = null, scheduledFor, oldDate, resetResponse = true, queueNotice = false, by = "admin" } = {}) {
  const records = await readAll();
  const idx = records.findIndex((b) => b.id === id);
  if (idx === -1) return null;
  const current = records[idx];
  if (!current.assignment) throw new Error(`${id} is not an assignment booking.`);
  const now = new Date().toISOString();
  const outreach = { ...(current.assignment.outreach || {}) };
  const history = [...(current.history || [])];

  if (resetResponse && outreach.respondedAt) {
    history.push({
      ts: now, action: "response_reset", by,
      note: `Day moved — previous answer (${outreach.responseVia} at ${outreach.respondedAt}) no longer covers the new date.`
    });
    delete outreach.respondedAt;
    delete outreach.responseVia;
    delete outreach.responseBy;
  }
  if (queueNotice) {
    outreach.pendingDayMove = {
      oldDate: outreach.pendingDayMove?.oldDate || oldDate,
      newDate: toDate,
      queuedAt: now
    };
  }
  // The half-day travels too when the caller names one (a single stop
  // moved morning → afternoon is a new promise as much as a new date is).
  const bucket = toBucket === "morning" || toBucket === "afternoon" ? toBucket : current.assignment.bucket;
  history.push({
    ts: now, action: "day_moved", by,
    note: `${oldDate} → ${toDate}${bucket !== current.assignment.bucket ? ` (${current.assignment.bucket} → ${bucket})` : ""} (route day moved)`
  });

  const next = {
    ...current,
    scheduledFor: new Date(scheduledFor).toISOString(),
    assignment: { ...current.assignment, date: toDate, bucket, outreach },
    updatedAt: now,
    history
  };
  records[idx] = next;
  await writeAll(records);
  return next;
}

// The customer chose the FREE BUCKET: they're normally home (or can be
// on short notice), so the job runs whenever PJL is in the area and the
// tech calls ahead with an ETA. The booking KEEPS its current date as
// the tentative anchor — it still counts against that day's capacity
// (conservative: never overbooks) and still gets its 24-hour reminder —
// and Patrick moves it freely when a nearby day has room.
async function setFreeBucket(id, { by = "customer" } = {}) {
  const records = await readAll();
  const idx = records.findIndex((b) => b.id === id);
  if (idx === -1) return null;
  const now = new Date().toISOString();
  const next = {
    ...records[idx],
    flexBucket: { at: now, by: String(by).slice(0, 120) },
    updatedAt: now,
    history: [...(records[idx].history || []), {
      ts: now, action: "free_bucket", by,
      note: "Customer chose the free bucket — run when in the area, tech calls with an ETA."
    }]
  };
  records[idx] = next;
  await writeAll(records);
  return next;
}

// The customer's own timing constraint for their day: "not before" /
// "not after", HH:MM or null. Feeds the sequencer's requestedWindows
// seam, where a customer's ask wins over the plan's standing guess.
const WINDOW_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
async function setRequestedWindow(id, { notBefore, notAfter, by = "customer" } = {}) {
  const clean = (v) => {
    const text = String(v == null ? "" : v).trim();
    if (!text) return null;
    if (!WINDOW_RE.test(text)) throw new Error(`"${text}" is not a valid HH:MM time.`);
    return text;
  };
  const before = clean(notBefore);
  const after = clean(notAfter);
  if (before && after && before >= after) {
    throw new Error("The \"after\" time has to come before the \"before\" time.");
  }
  const records = await readAll();
  const idx = records.findIndex((b) => b.id === id);
  if (idx === -1) return null;
  const now = new Date().toISOString();
  const next = {
    ...records[idx],
    requestedWindow: (before || after)
      ? { notBefore: before, notAfter: after, at: now, by: String(by).slice(0, 120) }
      : null,
    updatedAt: now,
    history: [...(records[idx].history || []), {
      ts: now, action: "requested_window", by,
      note: (before || after)
        ? [before ? `not before ${before}` : "", after ? `not after ${after}` : ""].filter(Boolean).join(", ")
        : "cleared"
    }]
  };
  records[idx] = next;
  await writeAll(records);
  return next;
}

// The day-before reminder's once-ever mark, for SELF-BOOKED bookings
// (assignment bookings get theirs from the cadence's step 6). Marked
// BEFORE the send goes out — same rule as every cadence step: a send
// that half-fails errs quiet, never double-texts.
async function markReminderSent(id, { channel = "", by = "system" } = {}) {
  const records = await readAll();
  const idx = records.findIndex((b) => b.id === id);
  if (idx === -1) return null;
  const now = new Date().toISOString();
  const next = {
    ...records[idx],
    reminder24: { sentAt: now, channel: String(channel).slice(0, 40) },
    updatedAt: now,
    history: [...(records[idx].history || []), {
      ts: now, action: "reminder_24h", by, note: channel ? `via ${channel}` : ""
    }]
  };
  records[idx] = next;
  await writeAll(records);
  return next;
}

// The customer told us how many zones their system actually has (their
// appointment page's "update your zone count"). The booking's tier
// fields follow the real number — serviceKey/serviceLabel so the page
// and day sheet name the right bracket, durationMinutes so the
// sequencer plans the right amount of on-site time. Deliberately NOT a
// response (they haven't answered about the date) and deliberately no
// rescheduleCount bump — correcting our records costs the customer
// nothing.
async function setDeclaredZones(id, { zoneCount, serviceKey, serviceLabel, durationMinutes, by = "customer" } = {}) {
  const zones = Math.floor(Number(zoneCount) || 0);
  if (zones < 1 || zones > 50) throw new Error("Zone count must be a whole number from 1 to 50.");
  const records = await readAll();
  const idx = records.findIndex((b) => b.id === id);
  if (idx === -1) return null;
  const current = records[idx];
  if (!current.assignment) throw new Error(`${id} is not an assignment booking.`);
  const now = new Date().toISOString();
  const tierChanged = Boolean(serviceKey) && serviceKey !== current.serviceKey;
  const next = {
    ...current,
    zoneCount: zones,
    ...(tierChanged ? {
      serviceKey,
      serviceLabel: serviceLabel || current.serviceLabel,
      durationMinutes: Number(durationMinutes) > 0 ? Number(durationMinutes) : current.durationMinutes
    } : {}),
    updatedAt: now,
    history: [...(current.history || []), {
      ts: now, action: "zones_declared", by,
      note: `${zones} zones${tierChanged ? ` — service tier ${current.serviceKey} → ${serviceKey}` : ""}`
    }]
  };
  records[idx] = next;
  await writeAll(records);
  return next;
}

// The customer (or Patrick, marking a phone call) answered. First answer
// wins — a later confirm doesn't overwrite how they first responded.
async function markAssignmentResponded(id, { via = "manual", by = "admin" } = {}) {
  const records = await readAll();
  const idx = records.findIndex((b) => b.id === id);
  if (idx === -1) return null;
  const current = records[idx];
  if (!current.assignment) throw new Error(`${id} is not an assignment booking.`);
  const outreach = { ...(current.assignment.outreach || {}) };
  if (outreach.respondedAt) return current;   // already answered — keep the first
  outreach.respondedAt = new Date().toISOString();
  outreach.responseVia = String(via).slice(0, 40);
  outreach.responseBy = String(by).slice(0, 120);
  const next = {
    ...current,
    assignment: { ...current.assignment, outreach },
    updatedAt: outreach.respondedAt,
    history: [...(current.history || []), {
      ts: outreach.respondedAt,
      action: "assignment_responded",
      by,
      note: `via ${outreach.responseVia}`
    }]
  };
  records[idx] = next;
  await writeAll(records);
  return next;
}

// Attach a WO id to a booking's workOrderIds[]. Used when techs spin
// up additional WOs from a single booking (multi-day repairs).
async function attachWorkOrder(bookingId, woId) {
  if (!bookingId || !woId) return null;
  const records = await readAll();
  const idx = records.findIndex((b) => b.id === bookingId);
  if (idx === -1) return null;
  if (!records[idx].workOrderIds.includes(woId)) {
    records[idx].workOrderIds.push(woId);
    records[idx].history.push({ ts: new Date().toISOString(), action: "wo_attached", by: "system", note: woId });
    records[idx].updatedAt = new Date().toISOString();
    await writeAll(records);
  }
  return records[idx];
}

module.exports = {
  holdsItsSlot,
  customerState,
  customerStateLabel,
  CUSTOMER_STATE_LABELS,
  CUSTOMER_CANCEL_REASONS,
  isCustomerCancelReason,
  reasonLabel,
  DEAD_STATUSES,
  REMOVAL_REASONS,
  customerCancelReasonList,
  isRemovalReason,
  removalOutcome,
  STATUSES,
  list,
  get,
  listByLead,
  listByProperty,
  upsertFromLead,
  healFromLeads,
  createDirect,
  setAssignmentOutreach,
  markAssignmentResponded,
  moveAssignmentDay,
  setFreeBucket,
  setRequestedWindow,
  setDeclaredZones,
  markReminderSent,
  update,
  reschedule,
  cancel,
  remove,
  attachWorkOrder
};
