// Properties — the long-lived "system profile" for each property PJL services.
//
// One CUSTOMER (identified by normalized email) can have MANY properties
// (residential + cottage + commercial site, etc.). Each property is the
// canonical record of:
//   - Address (display + geocoded lat/lng)
//   - System profile (controller location, shutoff, valve boxes, blowout points)
//   - Zone list (zone number + label, e.g. "Zone 1 — Front lawn")
//   - Photos (deferred to Phase 5; field is here so we don't need to migrate later)
//   - Linked leads / work orders (back-references)
//
// Auto-link logic:
//   When a new lead/booking comes in we try to attach it to an existing
//   property using a hybrid match:
//     1. Same customer email
//     2. AND either:
//        a. Exact-string match on the formatted address, OR
//        b. Geocoded lat/lng within MATCH_RADIUS_METERS of a saved property
//   If both checks pass → link to existing property.
//   If email matches but no address match → new property under same customer.
//   If email doesn't match → brand-new customer + new property.
//
// Storage: server/data/properties.json. Same flat-file pattern as leads.json
// and schedule.json. Fine for PJL's volume; rotate to SQLite if it ever
// crosses ~5,000 properties.

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const FILE = path.join(__dirname, "..", "data", "properties.json");

// 50m radius for "this is the same property." Tight enough that
// adjacent townhouses don't get conflated; loose enough that a customer
// who types "123 Main" once and "123 Main St" the next still matches.
const MATCH_RADIUS_METERS = 50;

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
    if (!Array.isArray(parsed)) return [];
    const hydrated = parsed.map(hydrate);

    // One-time backfill: assign P-YYYY-NNNN codes to any legacy records
    // missing one. Sorted by createdAt so older properties get the lower
    // numbers. Idempotent — once every record has a code, this branch
    // does nothing on subsequent reads.
    const missing = hydrated.filter((p) => !p.code);
    if (missing.length) {
      const maxByYear = {};
      for (const p of hydrated) {
        if (p.code) {
          const m = p.code.match(/^P-(\d{4})-(\d+)$/);
          if (m) {
            const yr = m[1];
            const n = parseInt(m[2], 10);
            if (n > (maxByYear[yr] || 0)) maxByYear[yr] = n;
          }
        }
      }
      const chronological = [...missing].sort(
        (a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0)
      );
      for (const p of chronological) {
        const created = new Date(p.createdAt || Date.now());
        const year = String(created.getUTCFullYear());
        const next = (maxByYear[year] || 0) + 1;
        p.code = `P-${year}-${String(next).padStart(4, "0")}`;
        maxByYear[year] = next;
      }
      await writeAll(hydrated);
    }

    return hydrated;
  } catch {
    return [];
  }
}

async function writeAll(properties) {
  await ensureFile();
  await fs.writeFile(FILE, JSON.stringify(properties, null, 2) + "\n", "utf8");
}

// ---- Helpers ---------------------------------------------------------

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeAddress(value) {
  return String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
}

function haversineMeters(a, b) {
  if (!a || !b || a.lat == null || b.lat == null) return Infinity;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const R = 6371000;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Default shape for a new property record. Every field defaults to a sensible
// empty value so the admin UI can write arbitrary subsets without us having
// to hydrate missing keys at every read.
function blankProperty() {
  return {
    id: crypto.randomUUID(),
    code: "",                     // Human-readable P-YYYY-NNNN, set by the
                                  // caller via nextPropertyCode(...) — leaving
                                  // it on the blank so hydrate spread keeps it.
    customerEmail: "",
    customerName: "",
    customerPhone: "",
    address: "",                 // free-text formatted address shown in UI
    addressNormalized: "",        // lower-cased, whitespace-collapsed for matching
    coords: null,                 // { lat, lng, formattedAddress } from geocoder
    system: {
      controllerLocation: "",     // e.g. "Garage, north wall"
      controllerBrand: "",        // e.g. "Hunter HPC-400"
      shutoffLocation: "",        // e.g. "Basement utility room"
      blowoutLocation: "",        // e.g. "Rear hose bib, beside deck"
      valveBoxes: [],             // [{ id, location, valveCount, notes }]
      zones: [],                  // [{ number, label, notes }]
      notes: ""                   // free-form system-wide notes
    },
    photos: [],                   // [{ id, slot, url, uploadedAt }]   — Phase 5
    leadIds: [],                  // back-refs to leads attached to this property
    workOrderIds: [],             // back-refs to work orders (Phase 2)
    // Deferred recommendations — the "fall finds, spring fixes" engine
    // (spec §5). Sources:
    //   - Customer declined an item during on-site Issues→Draft Quote review
    //   - Fall-closing tech tagged a found issue for spring follow-up
    //     (find_only mode — fall closings can never auto-quote per rule #7)
    //   - Spring carry-forward "Customer declined" → re-defers, increments
    //     reDeferralCount
    // Each entry:
    //   {
    //     id, fromWoId, fromZone, type, qty, notes, declinedAt, reason,
    //     photoIds, suggestedPriceSnapshot, status,
    //     severity:           "normal" | "emergency",
    //     reDeferralCount:    integer (0+; ≥3 trips the forced-decision flag)
    //     lastTouchedAt:      <iso> — bumped on any state change
    //     preAuthorization:   null | { signedAt, customerName, imageData,
    //                                  ip, userAgent }
    //                         Stamped when the customer pre-authorizes from
    //                         the portal. NOT a binding contract — the
    //                         spring WO sign-off is (rule #11). It's a
    //                         non-binding promise that lets the tech skip
    //                         the on-site sales conversation.
    //     resolution:         null | { resolvedAt, resolvedBy,
    //                                  resolvedInWoId, note }
    //   }
    // Status enum: open | pre_authorized | in_progress | resolved |
    //              dismissed | re_deferred
    deferredIssues: [],
    // Service records — append-only history of completed visits at this
    // property (spec §4.3.4 completion cascade). Each entry:
    //   { id, woId, woType, completedAt, techNotes,
    //     summary,                       // 1-line description
    //     lineItems: [...],              // snapshotted from the on-site quote
    //     subtotal, hst, total,
    //     warrantyMonths,                // 12 for repairs, 36 for installs
    //     warrantyExpiresAt,
    //     invoiceId,                     // pointer into invoices.json
    //     promotedPhotoIds: []           // photos copied to property.photos
    //   }
    serviceRecords: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

// Compute the next P-YYYY-NNNN code given the live property list. Per-year
// counter — the spec mirrors the Q-YYYY-NNNN (Quotes) and WO-XXXXXXXX
// (Work Orders) ID schemes for visual consistency across folders.
function nextPropertyCode(properties, year) {
  const prefix = `P-${year}-`;
  let max = 0;
  for (const p of properties) {
    if (typeof p?.code === "string" && p.code.startsWith(prefix)) {
      const n = parseInt(p.code.slice(prefix.length), 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return `${prefix}${String(max + 1).padStart(4, "0")}`;
}

// Backfill the deferredIssue shape onto entries written before the §5
// schema landed. Pure key-defaulting — never overwrites a value that's
// already set. Used by `hydrate` and by the lifecycle endpoints that
// touch a single entry.
function hydrateDeferred(entry) {
  if (!entry || typeof entry !== "object") return entry;
  return {
    id: entry.id,
    fromWoId: entry.fromWoId || null,
    fromZone: Number.isFinite(Number(entry.fromZone)) ? Number(entry.fromZone) : null,
    type: entry.type || "other",
    qty: Number.isFinite(Number(entry.qty)) && Number(entry.qty) > 0 ? Number(entry.qty) : 1,
    notes: entry.notes || "",
    declinedAt: entry.declinedAt || null,
    reason: entry.reason || "customer_declined",
    photoIds: Array.isArray(entry.photoIds) ? entry.photoIds : [],
    suggestedPriceSnapshot: entry.suggestedPriceSnapshot || null,
    status: entry.status || "open",
    severity: entry.severity === "emergency" ? "emergency" : "normal",
    reDeferralCount: Number.isFinite(Number(entry.reDeferralCount)) ? Number(entry.reDeferralCount) : 0,
    lastTouchedAt: entry.lastTouchedAt || entry.declinedAt || null,
    preAuthorization: entry.preAuthorization && typeof entry.preAuthorization === "object" ? entry.preAuthorization : null,
    resolution: entry.resolution && typeof entry.resolution === "object" ? entry.resolution : null
  };
}

// Backfill any missing keys on properties read from disk so older records
// keep working as the schema grows. Pure shape-merge, no value mutation.
function hydrate(p) {
  const base = blankProperty();
  return {
    ...base,
    ...p,
    system: { ...base.system, ...(p.system || {}) },
    photos: Array.isArray(p?.photos) ? p.photos : [],
    leadIds: Array.isArray(p?.leadIds) ? p.leadIds : [],
    workOrderIds: Array.isArray(p?.workOrderIds) ? p.workOrderIds : [],
    deferredIssues: Array.isArray(p?.deferredIssues) ? p.deferredIssues.map(hydrateDeferred) : [],
    serviceRecords: Array.isArray(p?.serviceRecords) ? p.serviceRecords : []
  };
}

// Append a service record to a property. Called by the completion
// cascade (spec §4.3.4) when a WO transitions to status=completed.
// Returns the saved entry or null if the property is missing.
async function addServiceRecord(propertyId, payload) {
  if (!propertyId) return null;
  const properties = await readAll();
  const idx = properties.findIndex((p) => p.id === propertyId);
  if (idx === -1) return null;
  const target = properties[idx];
  const now = new Date().toISOString();
  const id = "sr_" + Math.random().toString(36).slice(2, 10) + "_" + Date.now();
  const entry = {
    id,
    woId: payload?.woId || null,
    woType: payload?.woType || "service_visit",
    completedAt: payload?.completedAt || now,
    techNotes: payload?.techNotes || "",
    summary: payload?.summary || "",
    lineItems: Array.isArray(payload?.lineItems) ? payload.lineItems : [],
    subtotal: Number.isFinite(Number(payload?.subtotal)) ? Number(payload.subtotal) : 0,
    hst: Number.isFinite(Number(payload?.hst)) ? Number(payload.hst) : 0,
    total: Number.isFinite(Number(payload?.total)) ? Number(payload.total) : 0,
    warrantyMonths: Number.isFinite(Number(payload?.warrantyMonths)) ? Number(payload.warrantyMonths) : 12,
    warrantyExpiresAt: payload?.warrantyExpiresAt || null,
    invoiceId: payload?.invoiceId || null,
    promotedPhotoIds: Array.isArray(payload?.promotedPhotoIds) ? payload.promotedPhotoIds : []
  };
  if (!Array.isArray(target.serviceRecords)) target.serviceRecords = [];
  target.serviceRecords.unshift(entry);
  target.updatedAt = now;
  properties[idx] = target;
  await writeAll(properties);
  return entry;
}

async function findServiceRecordByWo(propertyId, woId) {
  if (!propertyId || !woId) return null;
  const properties = await readAll();
  const target = properties.find((p) => p.id === propertyId);
  if (!target) return null;
  return (target.serviceRecords || []).find((r) => r.woId === woId) || null;
}

// Patch the property's system block with updates the tech captured on
// the WO (e.g. zone description changes, controller location changes).
// Used by the completion cascade. Per-field merge — never overwrites a
// value with empty.
async function applySystemUpdates(propertyId, systemPatch) {
  if (!propertyId || !systemPatch || typeof systemPatch !== "object") return null;
  const properties = await readAll();
  const idx = properties.findIndex((p) => p.id === propertyId);
  if (idx === -1) return null;
  const target = properties[idx];
  target.system = target.system || {};
  for (const key of ["controllerLocation", "controllerBrand", "shutoffLocation", "blowoutLocation", "notes"]) {
    const v = systemPatch[key];
    if (typeof v === "string" && v.trim()) target.system[key] = v.trim();
  }
  if (Array.isArray(systemPatch.zones)) {
    // Per-zone update: match by `number`, then merge fields. Never delete
    // existing zones from the property — those are admin-managed.
    const existingByNum = new Map((target.system.zones || []).map((z) => [Number(z.number), z]));
    for (const z of systemPatch.zones) {
      const num = Number(z.number);
      if (!Number.isFinite(num) || num <= 0) continue;
      const current = existingByNum.get(num) || { number: num };
      if (typeof z.label === "string" && z.label.trim() && !current.label) current.label = z.label.trim();
      if (typeof z.location === "string" && z.location.trim() && !current.location) current.location = z.location.trim();
      if (Array.isArray(z.sprinklerTypes) && z.sprinklerTypes.length && !current.sprinklerTypes?.length) current.sprinklerTypes = z.sprinklerTypes.slice();
      if (Array.isArray(z.coverage) && z.coverage.length && !current.coverage?.length) current.coverage = z.coverage.slice();
      if (typeof z.notes === "string" && z.notes.trim()) current.notes = z.notes.trim();
      existingByNum.set(num, current);
    }
    target.system.zones = Array.from(existingByNum.values()).sort((a, b) => (a.number || 0) - (b.number || 0));
  }
  target.updatedAt = new Date().toISOString();
  properties[idx] = target;
  await writeAll(properties);
  return target;
}

// ---- Auto-match / upsert --------------------------------------------

// Find the best property match for a new lead based on its contact email
// + address (and optional geocoded coords). Returns the matched property
// or null if nothing came close.
async function findMatch({ email, address, coords }) {
  const properties = await readAll();
  const targetEmail = normalizeEmail(email);
  if (!targetEmail) return null;

  const candidates = properties.filter((p) => p.customerEmail === targetEmail);
  if (!candidates.length) return null;

  const targetAddrNorm = normalizeAddress(address);

  // 1. Exact normalized address match wins.
  const exact = candidates.find((p) => p.addressNormalized && p.addressNormalized === targetAddrNorm);
  if (exact) return exact;

  // 2. Geocoded distance match (when both sides have coords).
  if (coords && coords.lat != null) {
    let best = null;
    let bestDist = Infinity;
    for (const p of candidates) {
      if (!p.coords || p.coords.lat == null) continue;
      const dist = haversineMeters(coords, p.coords);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    if (best && bestDist <= MATCH_RADIUS_METERS) return best;
  }

  return null;
}

// Find existing properties at this address that belong to a DIFFERENT
// customer (different email). Used by the conflict-ownership check —
// could be the new owner of an old customer's house. Spec §3.1.
function findOwnershipConflicts(properties, address, coords, excludeEmail) {
  const targetAddrNorm = normalizeAddress(address);
  if (!targetAddrNorm && !(coords && coords.lat != null)) return [];
  const conflicts = [];
  for (const p of properties) {
    if (p.customerEmail === excludeEmail) continue;
    if (!p.customerEmail) continue; // unattributed properties don't conflict
    let isMatch = false;
    if (p.addressNormalized && p.addressNormalized === targetAddrNorm) isMatch = true;
    if (!isMatch && coords && coords.lat != null && p.coords && p.coords.lat != null) {
      if (haversineMeters(coords, p.coords) <= MATCH_RADIUS_METERS) isMatch = true;
    }
    if (isMatch) conflicts.push(p);
  }
  return conflicts;
}

// Match outcome — drives whether we auto-link, suggest a link to an
// existing property under the same customer, or create a brand-new
// customer + property record. The CRM uses the `status` to decide if
// Patrick needs to confirm the link manually.
//
//   "linked"              — strong match (same email + same address). Auto-attached.
//   "new"                 — no email match, no address conflict. Fresh customer + property.
//   "suggested"           — email matches an existing customer but the address
//                           doesn't (different property under same customer).
//   "conflict-ownership"  — known property at this address but a DIFFERENT
//                           customer email. Could be the new owner of an old
//                           customer's house (spec §3.1 "do NOT auto-merge").
//                           Property is created for the new customer; the
//                           existing-owner property is surfaced for Patrick
//                           to review.
//   "no-email"            — no email at all; can't match.
//
// `attachLead` always returns { property, status, suggestions[], conflicts[] }.
async function attachLead({ leadId, email, name, phone, address, coords }) {
  const properties = await readAll();
  const targetEmail = normalizeEmail(email);
  if (!targetEmail) return { property: null, status: "no-email", suggestions: [], conflicts: [] };

  // Strong match first — same customer + same property.
  let property = await findMatch({ email, address, coords });

  if (property) {
    const idx = properties.findIndex((p) => p.id === property.id);
    if (idx !== -1) {
      const updated = properties[idx];
      if (name && !updated.customerName) updated.customerName = name;
      if (phone && !updated.customerPhone) updated.customerPhone = phone;
      if (coords && coords.lat != null && (!updated.coords || updated.coords.lat == null)) {
        updated.coords = coords;
      }
      if (leadId && !updated.leadIds.includes(leadId)) updated.leadIds.push(leadId);
      updated.updatedAt = new Date().toISOString();
      properties[idx] = updated;
      property = updated;
    }
    await writeAll(properties);
    return { property, status: "linked", suggestions: [], conflicts: [] };
  }

  // Same customer (email matches), different address — suggest manual merge.
  const sameCustomer = properties.filter((p) => p.customerEmail === targetEmail);
  // Different customer at the same address — flag as ownership conflict
  // (spec §3.1: don't auto-merge, surface for Patrick to confirm). This
  // protects against an old customer's contact data getting attached to
  // the new owner's house.
  const ownershipConflicts = findOwnershipConflicts(properties, address, coords, targetEmail);

  property = blankProperty();
  property.code = nextPropertyCode(properties, String(new Date().getUTCFullYear()));
  property.customerEmail = targetEmail;
  property.customerName = name || "";
  property.customerPhone = phone || "";
  property.address = address || "";
  property.addressNormalized = normalizeAddress(address);
  property.coords = (coords && coords.lat != null) ? coords : null;
  if (leadId) property.leadIds.push(leadId);
  properties.unshift(property);
  await writeAll(properties);

  let status = "new";
  if (ownershipConflicts.length) status = "conflict-ownership";
  else if (sameCustomer.length) status = "suggested";

  return {
    property,
    status,
    suggestions: sameCustomer.map((p) => ({
      id: p.id,
      address: p.address,
      bookingCount: (p.leadIds || []).length
    })),
    conflicts: ownershipConflicts.map((p) => ({
      id: p.id,
      address: p.address,
      previousCustomerName: p.customerName || "",
      previousCustomerEmail: p.customerEmail || "",
      bookingCount: (p.leadIds || []).length
    }))
  };
}

// Move a lead from one property to another. Used by the CRM when Patrick
// confirms a suggested link (e.g. "this booking is actually for the same
// property as last spring's job"). The leadId is removed from the source's
// leadIds and added to the target's. If the source is left orphaned (no
// leads, no other linkage) we do NOT auto-delete it — Patrick can clean
// up via the property index. Safer than auto-delete.
async function relinkLead({ leadId, fromPropertyId, toPropertyId }) {
  if (!leadId || !toPropertyId || fromPropertyId === toPropertyId) return null;
  const properties = await readAll();
  const target = properties.find((p) => p.id === toPropertyId);
  if (!target) return null;

  if (fromPropertyId) {
    const source = properties.find((p) => p.id === fromPropertyId);
    if (source) {
      source.leadIds = (source.leadIds || []).filter((id) => id !== leadId);
      source.updatedAt = new Date().toISOString();
    }
  }
  if (!target.leadIds.includes(leadId)) target.leadIds.push(leadId);
  target.updatedAt = new Date().toISOString();
  await writeAll(properties);
  return target;
}

// ---- CRUD for the admin UI ------------------------------------------

async function list() {
  return readAll();
}

async function get(id) {
  const properties = await readAll();
  return properties.find((p) => p.id === id) || null;
}

async function update(id, patch) {
  const properties = await readAll();
  const idx = properties.findIndex((p) => p.id === id);
  if (idx === -1) return null;
  const current = properties[idx];

  // Patch is shallow-merged at the top level. `system` is merged one level
  // deep so the admin page can update individual fields without resending
  // the entire system block.
  const next = {
    ...current,
    ...patch,
    system: { ...current.system, ...(patch.system || {}) },
    updatedAt: new Date().toISOString()
  };
  // If address changed, refresh the normalized cache.
  if (patch.address != null && patch.address !== current.address) {
    next.addressNormalized = normalizeAddress(patch.address);
  }
  properties[idx] = next;
  await writeAll(properties);
  return next;
}

async function findByLeadId(leadId) {
  const properties = await readAll();
  return properties.find((p) => p.leadIds.includes(leadId)) || null;
}

// Hard-delete a single property by id. Returns the deleted record (or null
// if not found) so the caller can report it back to the UI / audit log.
// Linked leads are NOT deleted — the caller is responsible for clearing
// `lead.propertyId` on any leads that pointed at this property (server
// route does that so it can write leads.json in the same operation).
async function remove(id) {
  const properties = await readAll();
  const idx = properties.findIndex((p) => p.id === id);
  if (idx === -1) return null;
  const [removed] = properties.splice(idx, 1);
  await writeAll(properties);
  return removed;
}

// Bulk-delete by id list. Returns { deletedIds[], affectedLeadIds[] } so
// the caller can clear those leads' propertyId in one leads.json write.
// `ids` of `"*"` (string) deletes EVERYTHING — used by the nuclear "delete
// all customers" path. Pass an array for normal multi-select delete.
async function removeMany(ids) {
  const properties = await readAll();
  let toRemove;
  if (ids === "*") {
    toRemove = properties.slice();
  } else {
    const set = new Set((Array.isArray(ids) ? ids : []).filter(Boolean));
    toRemove = properties.filter((p) => set.has(p.id));
  }
  if (!toRemove.length) return { deletedIds: [], affectedLeadIds: [] };

  const removeIds = new Set(toRemove.map((p) => p.id));
  const remaining = properties.filter((p) => !removeIds.has(p.id));
  await writeAll(remaining);

  // Flatten every lead-id back-reference so the server route can null out
  // those leads' propertyId in a single leads.json write.
  const affectedLeadIds = [];
  for (const p of toRemove) {
    for (const id of (p.leadIds || [])) {
      if (id) affectedLeadIds.push(id);
    }
  }
  return {
    deletedIds: toRemove.map((p) => p.id),
    affectedLeadIds
  };
}

async function findByCustomerEmail(email) {
  const properties = await readAll();
  const target = normalizeEmail(email);
  return properties.filter((p) => p.customerEmail === target);
}

// Bulk-upsert for imports (CSV / xlsx). Each `record` is a partial property
// shape — the same fields the admin import UI extracts from a spreadsheet
// row. Match priority:
//   1. Same email + same normalized address  → update existing
//   2. Same email + no other property        → update existing (single match)
//   3. Same normalized address (no email)    → update existing
//   4. Otherwise                              → create new
//
// Returns { created, updated, errors, properties[] } so the import UI can
// show a per-row outcome summary.
async function bulkUpsert(records) {
  const properties = await readAll();
  const summary = { created: 0, updated: 0, errors: [], properties: [] };
  const now = new Date().toISOString();

  for (let i = 0; i < records.length; i++) {
    const r = records[i] || {};
    try {
      const email = normalizeEmail(r.customerEmail);
      const addrNorm = normalizeAddress(r.address);

      // Try to find a matching existing property to UPDATE.
      let target = null;
      if (email) {
        target = properties.find((p) =>
          p.customerEmail === email && p.addressNormalized && p.addressNormalized === addrNorm
        );
        if (!target) {
          // Email-only match (single property under this customer) is safe.
          const sameEmail = properties.filter((p) => p.customerEmail === email);
          if (sameEmail.length === 1) target = sameEmail[0];
        }
      }
      if (!target && addrNorm) {
        target = properties.find((p) => p.addressNormalized === addrNorm && !p.customerEmail);
      }

      if (target) {
        // Update — but never blank out fields that already have a value.
        target.customerName = target.customerName || r.customerName || "";
        target.customerEmail = target.customerEmail || email;
        target.customerPhone = target.customerPhone || r.customerPhone || "";
        if (!target.address && r.address) {
          target.address = r.address;
          target.addressNormalized = addrNorm;
        }
        const sysIn = r.system || {};
        target.system = target.system || {};
        if (!target.system.controllerLocation) target.system.controllerLocation = sysIn.controllerLocation || "";
        if (!target.system.controllerBrand) target.system.controllerBrand = sysIn.controllerBrand || "";
        if (!target.system.shutoffLocation) target.system.shutoffLocation = sysIn.shutoffLocation || "";
        if (!target.system.blowoutLocation) target.system.blowoutLocation = sysIn.blowoutLocation || "";
        if (!target.system.notes) target.system.notes = sysIn.notes || "";
        // Append valve boxes if the existing property has none — never
        // overwrite an admin-curated valve box list with import data.
        if (Array.isArray(sysIn.valveBoxes) && sysIn.valveBoxes.length && !target.system.valveBoxes?.length) {
          target.system.valveBoxes = sysIn.valveBoxes;
        }
        if (Array.isArray(sysIn.zones) && sysIn.zones.length && !target.system.zones?.length) {
          target.system.zones = sysIn.zones;
        }
        target.updatedAt = now;
        summary.updated += 1;
        summary.properties.push(target);
      } else {
        // Create new.
        const created = blankProperty();
        created.code = nextPropertyCode(properties, String(new Date().getUTCFullYear()));
        created.customerName = r.customerName || "";
        created.customerEmail = email;
        created.customerPhone = r.customerPhone || "";
        created.address = r.address || "";
        created.addressNormalized = addrNorm;
        const sysIn = r.system || {};
        created.system = {
          ...created.system,
          controllerLocation: sysIn.controllerLocation || "",
          controllerBrand: sysIn.controllerBrand || "",
          shutoffLocation: sysIn.shutoffLocation || "",
          blowoutLocation: sysIn.blowoutLocation || "",
          notes: sysIn.notes || "",
          valveBoxes: Array.isArray(sysIn.valveBoxes) ? sysIn.valveBoxes : [],
          zones: Array.isArray(sysIn.zones) ? sysIn.zones : []
        };
        created.createdAt = now;
        created.updatedAt = now;
        properties.unshift(created);
        summary.created += 1;
        summary.properties.push(created);
      }
    } catch (err) {
      summary.errors.push({ row: i, message: err.message || "unknown error" });
    }
  }

  await writeAll(properties);
  return summary;
}

// Append a deferred issue to a property. Source-of-truth write — used by:
//   - On-site Quote accept flow (declined items sink here)
//   - Fall-closing tech "Add to deferred recommendations" button
//   - Spring carry-forward "Customer declined" path (re-defers via
//     updateDeferredIssue + reDeferralCount, NOT a new entry — this
//     function is only for first-time defers)
//   - Emergency override (severity="emergency", routes a follow-up WO)
// Returns the saved entry (id stamped) or null if the property was missing.
// We don't dedupe here — the same physical issue can be deferred across
// different visits and they need separate audit trails.
async function addDeferredIssue(propertyId, payload) {
  if (!propertyId) return null;
  const properties = await readAll();
  const idx = properties.findIndex((p) => p.id === propertyId);
  if (idx === -1) return null;
  const target = properties[idx];
  const now = new Date().toISOString();
  const id = "def_" + Math.random().toString(36).slice(2, 10) + "_" + Date.now();
  const entry = hydrateDeferred({
    id,
    fromWoId: payload?.fromWoId || null,
    fromZone: payload?.fromZone,
    type: typeof payload?.type === "string" ? payload.type : "other",
    qty: payload?.qty,
    notes: typeof payload?.notes === "string" ? payload.notes.slice(0, 1000) : "",
    declinedAt: payload?.declinedAt || now,
    reason: typeof payload?.reason === "string" ? payload.reason : "customer_declined",
    photoIds: Array.isArray(payload?.photoIds) ? payload.photoIds.slice(0, 20) : [],
    suggestedPriceSnapshot: payload?.suggestedPriceSnapshot || null,
    status: "open",
    severity: payload?.severity === "emergency" ? "emergency" : "normal",
    reDeferralCount: 0,
    lastTouchedAt: now
  });
  if (!Array.isArray(target.deferredIssues)) target.deferredIssues = [];
  target.deferredIssues.unshift(entry);
  target.updatedAt = now;
  properties[idx] = target;
  await writeAll(properties);
  return entry;
}

// Look up a single deferred entry. Returns { property, entry, index } or
// null if either the property or the entry is missing. Helper for the
// lifecycle endpoints that need to mutate one entry without rewriting
// the whole array.
async function getDeferredIssue(propertyId, deferredId) {
  if (!propertyId || !deferredId) return null;
  const properties = await readAll();
  const property = properties.find((p) => p.id === propertyId);
  if (!property) return null;
  const list = Array.isArray(property.deferredIssues) ? property.deferredIssues : [];
  const index = list.findIndex((d) => d.id === deferredId);
  if (index === -1) return null;
  return { property, entry: list[index], index };
}

// Mutate a single deferred entry. `patch` is shallow-merged onto the
// existing entry; `lastTouchedAt` is always bumped. The status enum is
// validated — unknown values are rejected. Returns the saved entry or
// null if the property/entry isn't found. Re-deferral count increments
// must be passed explicitly in the patch (this layer doesn't infer it).
async function updateDeferredIssue(propertyId, deferredId, patch) {
  if (!propertyId || !deferredId) return null;
  const properties = await readAll();
  const idx = properties.findIndex((p) => p.id === propertyId);
  if (idx === -1) return null;
  const property = properties[idx];
  const list = Array.isArray(property.deferredIssues) ? property.deferredIssues : [];
  const entryIdx = list.findIndex((d) => d.id === deferredId);
  if (entryIdx === -1) return null;

  const now = new Date().toISOString();
  const allowedStatuses = new Set(["open", "pre_authorized", "in_progress", "resolved", "dismissed", "re_deferred"]);
  const next = { ...list[entryIdx] };

  if (patch && typeof patch === "object") {
    if (typeof patch.status === "string" && allowedStatuses.has(patch.status)) {
      next.status = patch.status;
    }
    if (Number.isFinite(Number(patch.reDeferralCount))) {
      next.reDeferralCount = Number(patch.reDeferralCount);
    }
    if (typeof patch.declinedAt === "string") next.declinedAt = patch.declinedAt;
    if (typeof patch.notes === "string") next.notes = patch.notes.slice(0, 1000);
    if (patch.severity === "emergency" || patch.severity === "normal") next.severity = patch.severity;
    if (Array.isArray(patch.photoIds)) next.photoIds = patch.photoIds.slice(0, 20);
    if (patch.suggestedPriceSnapshot !== undefined) next.suggestedPriceSnapshot = patch.suggestedPriceSnapshot;
    if (patch.preAuthorization === null || (patch.preAuthorization && typeof patch.preAuthorization === "object")) {
      next.preAuthorization = patch.preAuthorization;
    }
    if (patch.resolution === null || (patch.resolution && typeof patch.resolution === "object")) {
      next.resolution = patch.resolution;
    }
  }
  next.lastTouchedAt = now;

  list[entryIdx] = hydrateDeferred(next);
  property.deferredIssues = list;
  property.updatedAt = now;
  properties[idx] = property;
  await writeAll(properties);
  return list[entryIdx];
}

// Fetch a property's deferred issues, optionally filtered by status. Pass
// a string ("open"), an array (["open","pre_authorized"]), or null for
// everything. Returns [] if the property is missing.
async function listDeferred(propertyId, { status } = {}) {
  if (!propertyId) return [];
  const properties = await readAll();
  const target = properties.find((p) => p.id === propertyId);
  if (!target) return [];
  const all = Array.isArray(target.deferredIssues) ? target.deferredIssues : [];
  if (!status) return all;
  const wanted = new Set(Array.isArray(status) ? status : [status]);
  return all.filter((d) => wanted.has(d.status));
}

module.exports = {
  attachLead,
  relinkLead,
  findMatch,
  findByLeadId,
  findByCustomerEmail,
  list,
  get,
  update,
  remove,
  removeMany,
  bulkUpsert,
  addDeferredIssue,
  getDeferredIssue,
  updateDeferredIssue,
  listDeferred,
  addServiceRecord,
  findServiceRecordByWo,
  applySystemUpdates
};
