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
  await fs.writeFile(FILE, JSON.stringify(records, null, 2) + "\n", "utf8");
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
async function upsertFromLead(lead) {
  if (!lead || !lead.booking) return null;
  const records = await readAll();
  const existing = records.find((b) => b.leadId === lead.id);
  const now = new Date().toISOString();
  const booking = lead.booking;

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
  if (booking.workOrder?.id) next.workOrderIds = [booking.workOrder.id];
  next.history = [{ ts: now, action: "created_from_lead", by: "system", note: `Lead ${lead.id}` }];
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
async function cancel(id, { reason = "", by = "admin", actorName = "" } = {}) {
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
  const next = {
    ...current,
    status: "cancelled",
    cancelledAt: now,
    cancelledBy: by,
    cancellationReason: reason || "",
    updatedAt: now,
    history: [...(current.history || []), {
      ts: now,
      action: "cancelled",
      by,
      note: [
        actorName ? `${actorName} (${by})` : by,
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
async function moveAssignmentDay(id, { toDate, scheduledFor, oldDate, resetResponse = true, queueNotice = false, by = "admin" } = {}) {
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
  history.push({
    ts: now, action: "day_moved", by,
    note: `${oldDate} → ${toDate} (route day moved)`
  });

  const next = {
    ...current,
    scheduledFor: new Date(scheduledFor).toISOString(),
    assignment: { ...current.assignment, date: toDate, outreach },
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
  STATUSES,
  list,
  get,
  listByLead,
  listByProperty,
  upsertFromLead,
  createDirect,
  setAssignmentOutreach,
  markAssignmentResponded,
  moveAssignmentDay,
  setFreeBucket,
  setRequestedWindow,
  setDeclaredZones,
  update,
  reschedule,
  cancel,
  remove,
  attachWorkOrder
};
