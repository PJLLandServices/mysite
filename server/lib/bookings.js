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
    history: Array.isArray(b?.history) ? b.history : []
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

  if (existing) {
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
    existing.updatedAt = now;
    existing.history.push({ ts: now, action: "synced_from_lead", by: "system", note: "" });
    await writeAll(records);
    return existing;
  }

  const next = blank();
  next.id = await nextBookingId(new Date().getUTCFullYear());
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
  if (booking.workOrder?.id) next.workOrderIds = [booking.workOrder.id];
  next.history = [{ ts: now, action: "created_from_lead", by: "system", note: `Lead ${lead.id}` }];
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
  const allowed = ["status", "prepNotes", "scheduledFor", "durationMinutes", "address", "customerName", "customerPhone", "customerEmail", "zoneCount", "sourceQuoteId"];
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
  next.updatedAt = new Date().toISOString();
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
  update,
  attachWorkOrder
};
