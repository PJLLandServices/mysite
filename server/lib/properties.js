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
    // Deferred recommendations — items the customer declined during an
    // on-site Issues→Draft Quote review, OR fall-closing finds that the
    // tech logged for spring follow-up. Spec §5 (the carry-forward
    // engine). This slice ships the storage + property-page display;
    // the full carry-forward banner / portal pre-auth / 3-year flag
    // lives in a future slice. Each entry:
    //   { id, fromWoId, fromZone, type, qty, notes, declinedAt,
    //     reason, photoIds, suggestedPriceSnapshot, status }
    // status: open | resolved | dismissed | re_deferred (full lifecycle
    // unused yet — populated as we build §5 features).
    deferredIssues: [],
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
    deferredIssues: Array.isArray(p?.deferredIssues) ? p.deferredIssues : []
  };
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

// Match outcome — drives whether we auto-link, suggest a link to an
// existing property under the same customer, or create a brand-new
// customer + property record. The CRM uses the `status` to decide if
// Patrick needs to confirm the link manually.
//
//   "linked"     — strong match (same email + same address). Auto-attached.
//   "new"        — no email match anywhere. Brand-new customer + property.
//   "suggested"  — email matches an existing customer but the address
//                  doesn't (different property under same customer, OR
//                  the address typed was different enough it didn't match).
//                  We create the new property AND tag the lead with a
//                  pointer to the candidate so Patrick can confirm/reject.
//
// `attachLead` always returns { property, status, suggestions[] }.
async function attachLead({ leadId, email, name, phone, address, coords }) {
  const properties = await readAll();
  const targetEmail = normalizeEmail(email);
  if (!targetEmail) return { property: null, status: "no-email", suggestions: [] };

  // Strong match first — same customer + same property.
  let property = await findMatch({ email, address, coords });

  if (property) {
    // Refresh contact info (the latest lead might have a corrected name/phone).
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
    return { property, status: "linked", suggestions: [] };
  }

  // No address match — but maybe the email matches an existing customer.
  // If so, create the new property AND surface the existing ones as
  // suggestions so Patrick can manually merge if it's actually the same site.
  const sameCustomer = properties.filter((p) => p.customerEmail === targetEmail);

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

  return {
    property,
    status: sameCustomer.length ? "suggested" : "new",
    // Lightweight suggestion shape — just enough for the CRM to render
    // "this might be: <address> · <booking count>" without a second fetch.
    suggestions: sameCustomer.map((p) => ({
      id: p.id,
      address: p.address,
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

// Append a deferred issue to a property. Source-of-truth write (the
// on-site Quote accept flow uses this to sink declined items; future
// fall-closing find_only flow uses this too). Returns the saved entry
// (with id stamped) or null if the property was missing. Idempotency
// is handled at the caller — we don't dedupe here because the same
// physical issue can be deferred in different visits.
async function addDeferredIssue(propertyId, payload) {
  if (!propertyId) return null;
  const properties = await readAll();
  const idx = properties.findIndex((p) => p.id === propertyId);
  if (idx === -1) return null;
  const target = properties[idx];
  const now = new Date().toISOString();
  const id = "def_" + Math.random().toString(36).slice(2, 10) + "_" + Date.now();
  const entry = {
    id,
    fromWoId: payload?.fromWoId || null,
    fromZone: Number.isFinite(Number(payload?.fromZone)) ? Number(payload.fromZone) : null,
    type: typeof payload?.type === "string" ? payload.type : "other",
    qty: Number.isFinite(Number(payload?.qty)) && Number(payload.qty) > 0 ? Number(payload.qty) : 1,
    notes: typeof payload?.notes === "string" ? payload.notes.slice(0, 1000) : "",
    declinedAt: payload?.declinedAt || now,
    reason: typeof payload?.reason === "string" ? payload.reason : "customer_declined",
    photoIds: Array.isArray(payload?.photoIds) ? payload.photoIds.slice(0, 20) : [],
    suggestedPriceSnapshot: payload?.suggestedPriceSnapshot || null,
    status: "open"
  };
  if (!Array.isArray(target.deferredIssues)) target.deferredIssues = [];
  target.deferredIssues.unshift(entry);
  target.updatedAt = now;
  properties[idx] = target;
  await writeAll(properties);
  return entry;
}

// Fetch a property's open deferred issues. Returns [] if missing.
async function listDeferred(propertyId) {
  if (!propertyId) return [];
  const properties = await readAll();
  const target = properties.find((p) => p.id === propertyId);
  if (!target) return [];
  return Array.isArray(target.deferredIssues) ? target.deferredIssues : [];
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
  listDeferred
};
