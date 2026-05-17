// Customers — the canonical "person" entity per the operations spec
// (PJL_OPERATIONS_DESIGN.md §2.1) and the customer/property separation
// audit (May 11, 2026).
//
// Historical context: customer data lived embedded on the lead's
// `contact` object and was snapshotted onto every property / booking /
// work order / quote / invoice / project. There was no single record
// to update when the underlying real-world fact (phone, email, name)
// changed.
//
// This module introduces customers.json as the canonical store. Other
// entities will gain a `customerId` reference field in Brief 2; their
// snapshotted customer fields remain for legal-record integrity (signed
// WO, sent quote, issued invoice). See Hard Rule #10 in the spec —
// customer/property separation is permanent.
//
// Customer shape (per spec §2.1):
//   {
//     id:                 "CUST-NNNN"
//     name:               "Full name"
//     spouseName:         "Significant other's name" (optional)
//     phone:              "(905) 555-1234"
//     spousePhone:        "..."  (optional)
//     email:              "jane@example.com"
//     spouseEmail:        "..."  (optional)
//     billingAddress:     string | null   (null = same as primary property)
//     customerSince:      ISO date — earliest interaction
//     source:             ai_chat | repair_form | phone | email | import | ...
//     status:             lead | active | inactive | lost
//     quickbooksId:       null until QB push creates them in QBO
//     internalNotes:      free-form
//     notificationPrefs:  { textReminders, emailOnly, noMarketingTexts,
//                           overrides }
//     communicationRecords: [{ ts, source, summary, notes, logId }]
//     history:            [{ ts, action, by, note, before?, after? }]
//     createdAt, updatedAt
//   }
//
// ID format: CUST-NNNN (4-digit, zero-padded, sequential, long-lived —
// no year prefix, same pattern as SUP-###). Pads naturally grow past
// 9999 without code changes.
//
// Storage: server/data/customers.json. Same flat-file pattern as the
// rest of the system. PJL's customer count is in the hundreds at most;
// rotate to SQLite if it crosses ~10,000.

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");

const FILE = path.join(__dirname, "..", "data", "customers.json");

const STATUSES = new Set(["lead", "active", "inactive", "lost"]);

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

async function writeAll(records) {
  await ensureFile();
  await fs.writeFile(FILE, JSON.stringify(records, null, 2) + "\n", "utf8");
}

// ---- Helpers ---------------------------------------------------------

function nowIso() { return new Date().toISOString(); }

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

// Digits-only phone normalization. "(905) 555-1234" → "9055551234".
// Used as the join key for phone-based matching so formatting variation
// doesn't break dedup.
function normalizePhone(value) {
  return String(value || "").replace(/\D/g, "");
}

function blankCustomer() {
  const created = nowIso();
  return {
    id: "",
    name: "",
    spouseName: "",
    phone: "",
    spousePhone: "",
    email: "",
    spouseEmail: "",
    billingAddress: null,
    customerSince: null,
    source: "",
    status: "lead",
    quickbooksId: null,
    internalNotes: "",
    notificationPrefs: {
      textReminders: true,
      emailOnly: false,
      noMarketingTexts: false,
      overrides: {}
    },
    communicationRecords: [],
    // vCard download audit log — appended whenever Patrick downloads
    // this customer's .vcf to import into iPhone Contacts. Useful so
    // a re-download is visible (intentional new copy) and a duplicate
    // import can be reasoned about. Entries: { downloadedAt, method,
    // batchId } where method is "individual" | "bulk" and batchId is
    // set on bulk downloads to group them.
    vcfDownloads: [],
    history: [{ ts: created, action: "created", by: "system", note: "" }],
    createdAt: created,
    updatedAt: created
  };
}

function hydrate(c) {
  const base = blankCustomer();
  const merged = {
    ...base,
    ...c,
    notificationPrefs: {
      ...base.notificationPrefs,
      ...(c?.notificationPrefs || {}),
      overrides: { ...(c?.notificationPrefs?.overrides || {}) }
    },
    communicationRecords: Array.isArray(c?.communicationRecords)
      ? c.communicationRecords
      : [],
    vcfDownloads: Array.isArray(c?.vcfDownloads) ? c.vcfDownloads : [],
    history: Array.isArray(c?.history) ? c.history : []
  };
  // Re-normalize email/phone on read so legacy/imported records get
  // consistent join keys without a one-shot migration.
  merged.email = normalizeEmail(merged.email);
  return merged;
}

// Trim + cap each string field defensively.
function normalizePayload(payload) {
  const cap = (val, max) => String(val == null ? "" : val).trim().slice(0, max);
  return {
    name: cap(payload?.name, 200),
    spouseName: cap(payload?.spouseName, 200),
    phone: cap(payload?.phone, 40),
    spousePhone: cap(payload?.spousePhone, 40),
    email: cap(payload?.email, 254).toLowerCase(),
    spouseEmail: cap(payload?.spouseEmail, 254).toLowerCase(),
    billingAddress: payload?.billingAddress == null
      ? null
      : cap(payload.billingAddress, 400),
    source: cap(payload?.source, 80),
    internalNotes: cap(payload?.internalNotes, 4000)
  };
}

// Next customer id. Originally produced "CUST-NNNN". After the May 2026
// xlsx renumber the canonical format is plain QuickBooks-style numeric
// strings (e.g. "19931884"). Both formats are tolerated by the parser so
// the function keeps working through the transition; new ids emit in the
// numeric form to match the renumbered set.
async function nextCustomerId() {
  const records = await readAll();
  let max = 0;
  for (const c of records) {
    if (typeof c.id !== "string") continue;
    let n = NaN;
    if (c.id.startsWith("CUST-")) n = parseInt(c.id.slice(5), 10);
    else if (/^\d+$/.test(c.id))  n = parseInt(c.id, 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return String(max + 1);
}

// ---- CRUD -----------------------------------------------------------

async function list({ filter, search } = {}) {
  const records = await readAll();
  let out = records;
  if (filter && filter.status) {
    out = out.filter((c) => c.status === filter.status);
  }
  if (filter && filter.source) {
    out = out.filter((c) => c.source === filter.source);
  }
  if (search) {
    const needle = String(search).trim().toLowerCase();
    if (needle) {
      const needleDigits = normalizePhone(needle);
      out = out.filter((c) => {
        if (c.name && c.name.toLowerCase().includes(needle)) return true;
        if (c.spouseName && c.spouseName.toLowerCase().includes(needle)) return true;
        if (c.email && c.email.includes(needle)) return true;
        if (c.spouseEmail && c.spouseEmail.includes(needle)) return true;
        if (needleDigits && normalizePhone(c.phone).includes(needleDigits)) return true;
        if (needleDigits && normalizePhone(c.spousePhone).includes(needleDigits)) return true;
        return false;
      });
    }
  }
  return out;
}

// Returns the customer plus a derived `properties[]` array. The
// properties lookup uses `property.customerId` which is populated in
// Brief 2 — before that migration runs, the array will be empty.
// That's the intended interim behaviour; the customer record itself is
// valid and complete.
async function get(id, { withProperties = true } = {}) {
  const records = await readAll();
  const customer = records.find((c) => c.id === id) || null;
  if (!customer) return null;
  if (!withProperties) return customer;
  // Lazy require to avoid load-order coupling with properties.js.
  const propertiesLib = require("./properties");
  const allProperties = await propertiesLib.list();
  const linked = allProperties.filter((p) => p.customerId === id);
  return { ...customer, properties: linked };
}

async function create(payload, { by = "system", note = "" } = {}) {
  const fields = normalizePayload(payload);
  if (!fields.name) throw new Error("Customer name is required.");

  const records = await readAll();

  // Email uniqueness — if a customer with this email already exists,
  // refuse the create. Callers that want "find or create" semantics
  // should call findByEmail() / findByIdentifier() first.
  if (fields.email) {
    const collision = records.find((c) => c.email === fields.email);
    if (collision) {
      const err = new Error(`A customer with email ${fields.email} already exists.`);
      err.code = "DUPLICATE_EMAIL";
      err.existingId = collision.id;
      throw err;
    }
  }

  const id = await nextCustomerId();
  const now = nowIso();
  const customer = hydrate({
    ...blankCustomer(),
    ...fields,
    id,
    status: STATUSES.has(payload?.status) ? payload.status : "lead",
    customerSince: payload?.customerSince || now,
    quickbooksId: payload?.quickbooksId || null,
    notificationPrefs: payload?.notificationPrefs || undefined,
    createdAt: now,
    updatedAt: now,
    history: [{ ts: now, action: "created", by, note }]
  });
  records.push(customer);
  await writeAll(records);
  return customer;
}

// Allow-listed patch update. History entry appended on every call —
// caller can pass `by` and `note` to label the audit row. If `patch`
// includes `before`/`after` shapes for a specific field, those are
// recorded in the history entry to support a diff viewer later.
async function update(id, patch, { by = "admin", note = "", action = "updated" } = {}) {
  const records = await readAll();
  const idx = records.findIndex((c) => c.id === id);
  if (idx === -1) return null;

  const current = records[idx];
  const allowed = [
    "name", "spouseName",
    "phone", "spousePhone",
    "email", "spouseEmail",
    "billingAddress",
    "customerSince",
    "source",
    "status",
    "quickbooksId",
    "internalNotes",
    "notificationPrefs"
  ];

  const next = { ...current };
  const changes = {};
  for (const key of allowed) {
    if (!patch || !Object.prototype.hasOwnProperty.call(patch, key)) continue;
    if (key === "status" && !STATUSES.has(patch.status)) {
      throw new Error(`Unknown customer status: ${patch.status}`);
    }
    if (key === "email" && patch.email) {
      const normalized = normalizeEmail(patch.email);
      const collision = records.find((c) => c.id !== id && c.email === normalized);
      if (collision) {
        const err = new Error(`Email ${normalized} is already used by ${collision.id}.`);
        err.code = "DUPLICATE_EMAIL";
        err.existingId = collision.id;
        throw err;
      }
      changes.email = { before: current.email, after: normalized };
      next.email = normalized;
      continue;
    }
    if (key === "notificationPrefs" && patch.notificationPrefs) {
      next.notificationPrefs = {
        ...current.notificationPrefs,
        ...patch.notificationPrefs,
        overrides: {
          ...(current.notificationPrefs?.overrides || {}),
          ...(patch.notificationPrefs.overrides || {})
        }
      };
      changes.notificationPrefs = true;
      continue;
    }
    if (current[key] !== patch[key]) {
      changes[key] = { before: current[key], after: patch[key] };
      next[key] = patch[key];
    }
  }

  next.updatedAt = nowIso();
  next.history = [
    ...(current.history || []),
    {
      ts: next.updatedAt,
      action,
      by,
      note,
      ...(Object.keys(changes).length ? { changes } : {})
    }
  ];
  records[idx] = next;
  await writeAll(records);
  return next;
}

// Soft-delete via status → "inactive". Used as the default "remove"
// path because a customer linked from any signed WO / sent quote /
// issued invoice must remain resolvable forever for legal/audit reasons.
async function remove(id, { by = "admin", note = "" } = {}) {
  return update(
    id,
    { status: "inactive" },
    { by, note, action: "soft_deleted" }
  );
}

// Hard-delete — actually removes the record from customers.json.
// Refuses if any entity references this customer. Caller must use
// merge() first when they want to combine duplicates, or accept
// loss-of-link when nothing is yet attached (typical for test data
// and accidental near-duplicates with no bookings/WOs/etc yet).
//
// Returns { ok: true, customer } on success, or
//         { ok: false, error, references } when blocked.
async function hardDelete(id) {
  const records = await readAll();
  const idx = records.findIndex((c) => c.id === id);
  if (idx === -1) return { ok: false, error: "Customer not found." };

  const dataDir = path.join(__dirname, "..", "data");
  const filesToCheck = [
    "leads.json", "properties.json", "bookings.json",
    "work-orders.json", "quotes.json", "invoices.json", "projects.json"
  ];
  const references = {};
  for (const file of filesToCheck) {
    const fullPath = path.join(dataDir, file);
    if (!fsSync.existsSync(fullPath)) continue;
    try {
      const raw = await fs.readFile(fullPath, "utf8");
      const arr = JSON.parse(raw || "[]");
      if (!Array.isArray(arr)) continue;
      const matches = arr.filter((r) => r && r.customerId === id);
      if (matches.length) {
        references[file.replace(".json", "")] = matches.map((r) => r.id).filter(Boolean);
      }
    } catch (err) {
      console.warn(`[hardDelete] couldn't check ${file}:`, err.message);
    }
  }
  if (Object.keys(references).length) {
    return {
      ok: false,
      error: "Customer is referenced by other records. Use merge to combine them, or remove the references first.",
      references
    };
  }
  const removed = records.splice(idx, 1)[0];
  await writeAll(records);
  return { ok: true, customer: removed };
}

// ---- Matching --------------------------------------------------------
//
// These are the canonical "find this customer" entry points used by
// lead intake, magic-link auth, and the customer/property handoff
// conflict detector. Centralized here so the matching rules from spec
// §3.1 live in one place.

async function findByEmail(email) {
  const target = normalizeEmail(email);
  if (!target) return null;
  const records = await readAll();
  return records.find((c) => c.email === target || c.spouseEmail === target) || null;
}

async function findByPhone(phone) {
  const target = normalizePhone(phone);
  if (!target) return null;
  const records = await readAll();
  return records.find(
    (c) => normalizePhone(c.phone) === target || normalizePhone(c.spousePhone) === target
  ) || null;
}

// Per spec §3.1 — match by email FIRST, phone SECOND. The match order
// matters: email is more reliable as a unique identifier. A shared
// household phone with two distinct email addresses gets two customer
// records, which is correct (spouses with separate logins).
async function findByIdentifier(identifier) {
  if (!identifier) return null;
  const trimmed = String(identifier).trim();
  if (!trimmed) return null;
  const byEmail = await findByEmail(trimmed);
  if (byEmail) return byEmail;
  const byPhone = await findByPhone(trimmed);
  if (byPhone) return byPhone;
  return null;
}

// ---- Communication records ------------------------------------------

async function addCommunication(id, record) {
  const records = await readAll();
  const idx = records.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  const entry = {
    ts: record?.ts || nowIso(),
    source: String(record?.source || "").slice(0, 40),
    summary: String(record?.summary || "").slice(0, 400),
    notes: String(record?.notes || "").slice(0, 4000),
    logId: record?.logId || null
  };
  records[idx].communicationRecords = [
    ...(records[idx].communicationRecords || []),
    entry
  ];
  records[idx].updatedAt = nowIso();
  await writeAll(records);
  return records[idx];
}

// ---- Merge -----------------------------------------------------------
//
// Brief 4 — when two customer records turn out to be the same person
// (typical case: an xlsx-imported placeholder customer overlaps with a
// real lead-derived customer), merge the secondary INTO the primary.
//
// Side effects:
//   1. Every entity (leads, properties, bookings, WOs, quotes,
//      invoices, projects) with customerId === secondaryId gets
//      re-pointed to primaryId.
//   2. Communication records get concatenated and deduped.
//   3. Primary's blank fields get filled from secondary (name,
//      spouse info, billing address, source, qbId). Primary's
//      non-empty fields are authoritative.
//   4. Primary's notificationPrefs stay untouched (person's
//      choice — not merged from a placeholder).
//   5. A merge entry is appended to primary's history.
//   6. Secondary is removed from customers.json.
//
// Direct JSON-file ops deliberately bypass each entity lib's update()
// — those are designed for granular patches, not bulk customerId
// rewrites. The operation is one-shot and well-scoped.
async function mergeCustomers(primaryId, secondaryId, { by = "admin", note = "" } = {}) {
  if (!primaryId || !secondaryId) throw new Error("Both customer IDs are required.");
  if (primaryId === secondaryId) throw new Error("Cannot merge a customer into itself.");

  const records = await readAll();
  const primaryIdx = records.findIndex((c) => c.id === primaryId);
  const secondaryIdx = records.findIndex((c) => c.id === secondaryId);
  if (primaryIdx === -1) throw new Error(`Primary customer ${primaryId} not found.`);
  if (secondaryIdx === -1) throw new Error(`Secondary customer ${secondaryId} not found.`);

  const primary = { ...records[primaryIdx] };
  const secondary = records[secondaryIdx];

  // Re-point every entity carrying customerId.
  const dataDir = path.join(__dirname, "..", "data");
  const filesToUpdate = [
    "leads.json", "properties.json", "bookings.json",
    "work-orders.json", "quotes.json", "invoices.json", "projects.json"
  ];
  let entitiesUpdated = 0;
  for (const file of filesToUpdate) {
    const fullPath = path.join(dataDir, file);
    if (!fsSync.existsSync(fullPath)) continue;
    try {
      const raw = await fs.readFile(fullPath, "utf8");
      const arr = JSON.parse(raw || "[]");
      if (!Array.isArray(arr)) continue;
      let changed = 0;
      for (const r of arr) {
        if (r && r.customerId === secondaryId) {
          r.customerId = primaryId;
          changed++;
        }
      }
      if (changed) {
        await fs.writeFile(fullPath, JSON.stringify(arr, null, 2) + "\n", "utf8");
        entitiesUpdated += changed;
      }
    } catch (err) {
      console.warn(`[mergeCustomers] couldn't update ${file}:`, err.message);
    }
  }

  // Fill primary's blank fields from secondary.
  for (const field of [
    "name", "spouseName", "phone", "spousePhone",
    "email", "spouseEmail", "billingAddress",
    "source", "quickbooksId", "internalNotes"
  ]) {
    if (!primary[field] && secondary[field]) primary[field] = secondary[field];
  }

  // Concat + dedupe communication records (key by ts + source + summary).
  const seen = new Set();
  const allComms = [
    ...(Array.isArray(primary.communicationRecords) ? primary.communicationRecords : []),
    ...(Array.isArray(secondary.communicationRecords) ? secondary.communicationRecords : [])
  ];
  primary.communicationRecords = allComms.filter((c) => {
    const key = `${c.ts}|${c.source}|${c.summary}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).sort((a, b) => String(a.ts || "").localeCompare(String(b.ts || "")));

  // History entry on primary.
  const ts = nowIso();
  primary.history = [
    ...(Array.isArray(primary.history) ? primary.history : []),
    {
      ts,
      action: "merged_in",
      by,
      note: note || `Merged ${secondaryId} (${secondary.name || "unnamed"}) into this record. ${entitiesUpdated} entity ${entitiesUpdated === 1 ? "reference" : "references"} re-pointed.`
    }
  ];
  primary.updatedAt = ts;

  records[primaryIdx] = primary;
  records.splice(secondaryIdx, 1);
  await writeAll(records);

  return {
    customer: primary,
    entitiesUpdated,
    removedCustomer: { id: secondary.id, name: secondary.name }
  };
}

// ---- vCard generation ------------------------------------------------
//
// Renders customer records as VCARD 3.0 for iPhone Contacts import. The
// motivating use case is Siri callability from the truck — "Hey Siri,
// call <FirstName> from PJL Land Services" matches on the FN + ORG
// fields. Version 3.0 chosen for broadest iOS / macOS / iCloud
// compatibility. Single ORG value (no parenthetical) so Siri's fuzzy
// matcher doesn't get confused.
//
// Bulk export concatenates multiple BEGIN:VCARD…END:VCARD blocks into
// one .vcf file — macOS Contacts and iCloud.com both accept this for
// batch import. Each individual record's REV field uses the customer's
// updatedAt timestamp so re-imports de-dupe correctly.

const VCARD_ORG = "PJL Land Services";

// Escape RFC 6350 special characters. Same shape as the lead-side
// renderVCard() in server.js so output is consistent.
function escapeVCardValue(value) {
  return String(value == null ? "" : value)
    .replace(/\\/g, "\\\\")
    .replace(/\r?\n/g, "\\n")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,");
}

// Split a single "name" string into family / given for the structured N
// field. Heuristic: split on the LAST space — "Mary Anne Smith" becomes
// given="Mary Anne", family="Smith". Empty input yields blanks; a single
// token goes into `given` with family blank (iOS still imports cleanly).
function splitName(fullName) {
  const trimmed = String(fullName || "").trim();
  if (!trimmed) return { given: "", family: "" };
  const idx = trimmed.lastIndexOf(" ");
  if (idx === -1) return { given: trimmed, family: "" };
  return {
    given: trimmed.slice(0, idx).trim(),
    family: trimmed.slice(idx + 1).trim()
  };
}

// Compact ISO 8601 for REV — "20260516T093000Z". Falls back to "now" if
// the customer record lacks an updatedAt for some reason.
function vcardRev(iso) {
  const d = iso ? new Date(iso) : new Date();
  const valid = !Number.isNaN(d.getTime()) ? d : new Date();
  return valid.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
}

// Resolve the address that lands in ADR. The spec says home address;
// our schema has billingAddress (often null = "use primary property"),
// so when billingAddress is blank we look at the first property in the
// decorated customer (`customer.properties[0].address`). If neither is
// present we omit ADR entirely — iOS displays the contact fine without
// an address and the user can edit later.
function resolveAddress(customer) {
  if (customer?.billingAddress) return String(customer.billingAddress);
  if (Array.isArray(customer?.properties) && customer.properties.length) {
    return String(customer.properties[0].address || "");
  }
  return "";
}

// Build a single VCARD 3.0 block. CRLF line endings per RFC 6350. The
// trailing CRLF after END:VCARD is required so concatenation produces a
// valid multi-card .vcf without an extra separator.
function toVCard(customer) {
  if (!customer) return "";
  const { given, family } = splitName(customer.name);
  const fullName = customer.name || customer.id || "";
  const address = resolveAddress(customer);

  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `N:${escapeVCardValue(family)};${escapeVCardValue(given)};;;`,
    `FN:${escapeVCardValue(fullName)}`,
    `ORG:${escapeVCardValue(VCARD_ORG)}`
  ];
  if (customer.phone) {
    lines.push(`TEL;TYPE=CELL,VOICE:${escapeVCardValue(customer.phone)}`);
  }
  if (customer.email) {
    lines.push(`EMAIL;TYPE=INTERNET:${escapeVCardValue(customer.email)}`);
  }
  if (address) {
    // ADR slots: po-box;ext;street;locality;region;postal;country.
    // v1 dumps the resolved address string into the street slot; iOS
    // displays it as a single-line address. A future brief can parse
    // structured locality / region / postal from Google Places.
    lines.push(`ADR;TYPE=HOME:;;${escapeVCardValue(address)};;;;`);
  }
  lines.push(`REV:${vcardRev(customer.updatedAt)}`);
  lines.push("END:VCARD");
  return lines.join("\r\n") + "\r\n";
}

// Concatenate VCARDs back-to-back. Already-CRLF-terminated by toVCard(),
// so no extra separator needed.
function toVCardBatch(customerList) {
  if (!Array.isArray(customerList) || !customerList.length) return "";
  return customerList.map(toVCard).filter(Boolean).join("");
}

// Append a download audit entry. method = "individual" | "bulk".
// batchId is supplied for bulk so a single click produces one shared id
// across every customer in the selection. Does not throw on missing
// customer — returns null so a logging failure can't break the
// download itself.
async function recordVcfDownload(id, method, batchId = null) {
  const records = await readAll();
  const idx = records.findIndex((c) => c.id === id);
  if (idx === -1) return null;
  const entry = {
    downloadedAt: nowIso(),
    method: method === "bulk" ? "bulk" : "individual",
    batchId: method === "bulk" ? (batchId || null) : null
  };
  records[idx].vcfDownloads = [
    ...(Array.isArray(records[idx].vcfDownloads) ? records[idx].vcfDownloads : []),
    entry
  ];
  records[idx].updatedAt = nowIso();
  await writeAll(records);
  return records[idx];
}

// One-shot batch recorder for bulk downloads. Reads + writes
// customers.json once even when many ids are involved — avoids the
// N reads / N writes / last-write-wins race that a loop of individual
// recordVcfDownload calls would create. Returns the count of records
// that were actually updated (missing ids are silently skipped, same
// shape as the bulk endpoint's overall skip behaviour).
async function recordVcfDownloadBatch(ids, batchId) {
  const idSet = new Set((Array.isArray(ids) ? ids : []).map(String));
  if (!idSet.size) return 0;
  const records = await readAll();
  const ts = nowIso();
  let updated = 0;
  for (const r of records) {
    if (!idSet.has(r.id)) continue;
    r.vcfDownloads = [
      ...(Array.isArray(r.vcfDownloads) ? r.vcfDownloads : []),
      { downloadedAt: ts, method: "bulk", batchId: batchId || null }
    ];
    r.updatedAt = ts;
    updated++;
  }
  if (updated) await writeAll(records);
  return updated;
}

module.exports = {
  STATUSES,
  normalizeEmail,
  normalizePhone,
  list,
  get,
  create,
  update,
  remove,
  hardDelete,
  findByEmail,
  findByPhone,
  findByIdentifier,
  addCommunication,
  mergeCustomers,
  toVCard,
  toVCardBatch,
  recordVcfDownload,
  recordVcfDownloadBatch
};
