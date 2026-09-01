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
//     billingName:        ""     (empty = bill to `name`; set when the
//                                 invoice is issued to a different person
//                                 or company, e.g. "LCIG Investment Inc.")
//     billingEmail:       ""     (empty = invoice email goes to `email`)
//     billingAddress:     string | null   (null = same as primary property)
//     accountType:        "residential" | "commercial"  (default residential)
//     commercial:         null | { careOf, poRequired, paymentTerms,
//                                  contacts: [...] }
//                         Null on residential. Org-wide signatories live
//                         here; per-site contacts live on the PROPERTY
//                         (property.siteContacts) — see billing-parties.js
//                         and PJL_OPERATIONS_DESIGN §2.1.
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
// Contact-id helpers only — the bill-to resolver itself is not used here.
// Safe to require at load time: billing-parties.js requires no siblings.
const { isContactId, coerceContactId } = require("./billing-parties");

const FILE = path.join(__dirname, "..", "data", "customers.json");

const STATUSES = new Set(["lead", "active", "inactive", "lost"]);

// ---- File I/O ---------------------------------------------------------

async function ensureFile() {
  await fs.mkdir(path.dirname(FILE), { recursive: true });
  if (!fsSync.existsSync(FILE)) {
    await fs.writeFile(FILE, "[]\n", "utf8");
  }
}

// True when a raw (pre-hydrate) record carries a commercial contact that has
// no usable con_ id. Drives the one-time backfill in readAll().
function needsContactIdBackfill(c) {
  const contacts = (c && c.commercial && Array.isArray(c.commercial.contacts))
    ? c.commercial.contacts : [];
  return contacts.some((k) => k && typeof k === "object" && !isContactId(k.id));
}

async function readAll() {
  await ensureFile();
  try {
    const raw = await fs.readFile(FILE, "utf8");
    const parsed = JSON.parse(raw || "[]");
    if (!Array.isArray(parsed)) return [];
    const hydrated = parsed.map(hydrate);

    // One-time backfill: persist the con_ ids hydrate() just minted for
    // contacts written before ids existed. Without this write the id would
    // be re-rolled on every read and nothing could reference a contact.
    // Same pattern as the P-YYYY-NNNN backfill in properties.readAll().
    // Idempotent — once every contact carries an id this does nothing.
    if (parsed.some(needsContactIdBackfill)) {
      await writeAll(hydrated);
    }

    return hydrated;
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
    billingName: "",
    billingEmail: "",
    // Billing CC (addendum, Jul 2026) — an extra address that gets a copy
    // of the INVOICE email. The party who accepts the work is often not the
    // party who pays it: a commercial owner signs the quote while his
    // bookkeeper handles payment. Account-level default; a property can
    // override it per site (property.billingCcEmail) for a condo corp with
    // its own accounts-payable desk. Lives beside the other billing fields
    // rather than inside `commercial` because `commercial` is null on
    // residential accounts, and a residential customer can have a
    // bookkeeper too. Blank = no CC, which is the overwhelming majority.
    // Applies to invoices ONLY — never to quotes (see billing-parties.js).
    billingCcEmail: "",
    billingAddress: null,
    // Account type + commercial block (commercial intake, 2026-07).
    // accountType mirrors lead.accountType so the customer record itself
    // carries the residential/commercial distinction (previously only on
    // the lead). `commercial` mirrors lead.commercial: the contacts[] list
    // (each with a role + function flags isSiteContact / isAuthorizedSignatory)
    // plus poRequired / paymentTerms. The contact flagged isAuthorizedSignatory
    // becomes the default quote.acceptor at send time. Null on residential
    // accounts, where the customer IS the signer. hydrate() spreads these
    // blank defaults over legacy records on read, so no one-shot migration
    // is needed.
    //   commercial: { careOf, poRequired, paymentTerms,
    //     contacts: [{ id, name, role, email, phone,
    //                  isSiteContact, isAuthorizedSignatory }] }
    // Each contact carries a stable `con_xxxxxxxx` id (minted by
    // billing-parties.coerceContactId) so a rename doesn't change who the
    // contact IS. Normalized on read as well as write — see hydrate().
    accountType: "residential",
    commercial: null,
    customerSince: null,
    source: "",
    status: "lead",
    quickbooksId: null,
    internalNotes: "",
    notificationPrefs: {
      textReminders: true,
      // Spouse-CC SMS — gated independently from textReminders so a
      // household can opt the primary out while the spouse stays
      // subscribed (or vice versa). Defaults true. Only relevant when
      // copySpouseOnInvoices is also true AND spousePhone is set.
      spouseTextReminders: true,
      emailOnly: false,
      noMarketingTexts: false,
      overrides: {}
    },
    // When true AND spouseEmail/spousePhone are populated, every
    // invoice email + SMS that targets this customer ALSO goes to the
    // spouse. Pre-checks the per-send "CC spouse" checkbox on the
    // invoice admin page; Patrick can still override per-send.
    // Default false — opt-in feature.
    copySpouseOnInvoices: false,
    // Per-customer negotiated rate agreements — labour override (and
    // any future per-unit overrides) for repeat contractors with
    // standing fair-trade deals (e.g. GreenTree @ $85/hr). Sparse:
    // most customers have no entry. Snapshots onto a project_proposal
    // quote at creation via quotes.snapshotRatesFromCustomer; the
    // quote then carries its own customRates frozen for legal-record
    // integrity (Hard Rule #2). Brief 1 (May 2026).
    negotiatedRates: {
      labour: null
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
    negotiatedRates: {
      ...base.negotiatedRates,
      ...(c?.negotiatedRates || {})
    },
    // Commercial block — normalized on READ, not just on write, so a
    // hand-edited customers.json can't serve a malformed block to the
    // resolver (contacts as a string, role flags as "yes", unknown keys).
    // Mirrors the siteContacts guard in properties.hydrate(). Stays null
    // for residential accounts: normalizeCommercialBlock returns null when
    // there is nothing usable, so residential records are untouched.
    commercial: normalizeCommercialBlock(c?.commercial),
    communicationRecords: Array.isArray(c?.communicationRecords)
      ? c.communicationRecords
      : [],
    vcfDownloads: Array.isArray(c?.vcfDownloads) ? c.vcfDownloads : [],
    history: Array.isArray(c?.history) ? c.history : []
  };
  // Re-normalize email/phone on read so legacy/imported records get
  // consistent join keys without a one-shot migration.
  merged.email = normalizeEmail(merged.email);
  // Same treatment for the billing CC — it's fed straight to a mail
  // transport's `cc:`, so it must be trimmed and lower-cased regardless of
  // how it was typed or imported.
  merged.billingCcEmail = normalizeEmail(merged.billingCcEmail).slice(0, 254);
  return merged;
}

// Trim + cap each string field defensively.
// Commercial contact (commercial intake). role = what they ARE (enum,
// free-capped here — the server route coerces to the enum); the two
// function flags = what they DO. Mirrors lead.commercial.additionalContacts.
const COMMERCIAL_ROLE_SET = new Set(["site_contact", "property_manager", "accounts_payable", "owner_board", "other"]);
function normalizeCommercialContact(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const cap = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
  const role = cap(raw.role, 40);
  const c = {
    // Stable identity — see billing-parties.coerceContactId. A well-formed
    // incoming id is kept (the editor round-trips it via data-cid), so
    // renaming a contact doesn't make it a different person to Phase 1.
    id: coerceContactId(raw.id),
    name: cap(raw.name, 200),
    role: COMMERCIAL_ROLE_SET.has(role) ? role : (role ? "other" : ""),
    email: cap(raw.email, 254).toLowerCase(),
    phone: cap(raw.phone, 40),
    isSiteContact: raw.isSiteContact === true || raw.isSiteContact === "true",
    isAuthorizedSignatory: raw.isAuthorizedSignatory === true || raw.isAuthorizedSignatory === "true"
  };
  // `id` is deliberately NOT part of the "is there anything here" test — it's
  // always populated, so counting it would keep every empty row.
  return (c.name || c.email || c.phone || c.role || c.isSiteContact || c.isAuthorizedSignatory) ? c : null;
}

// Maximum contacts on one record. Shared with properties.MAX_CONTACTS —
// the two lists are the same shape and are edited by the same UI patterns.
const MAX_CONTACTS = 10;

// Commercial block: contacts[] + PO / payment-terms. Returns null when
// there is nothing usable so residential accounts stay block-less.
//
// `enforceCap` splits the two directions deliberately (addendum, Jul 2026):
//
//   WRITE (create / update, enforceCap: true) — an over-cap list is
//   REJECTED with a clear error. This used to silently trim to the first
//   10, which on a billing/profile-accuracy slice is the wrong failure
//   mode: the contact quietly dropped could be the authorized signatory,
//   and nobody would learn about it until a quote had no valid acceptor.
//
//   READ (hydrate, enforceCap: false) — never throws and never trims. A
//   record that is already over-cap on disk keeps every contact, so the
//   act of reading can't destroy data; the step-0 audit reports it and a
//   human removes the extras. Throwing here would be worse than trimming:
//   readAll() swallows exceptions and would return an EMPTY customer list.
function normalizeCommercialBlock(raw, { enforceCap = false } = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const cap = (v, n) => String(v == null ? "" : v).trim().slice(0, n);
  const contactsIn = Array.isArray(raw.contacts) ? raw.contacts
    : (Array.isArray(raw.additionalContacts) ? raw.additionalContacts : []);
  // Counted AFTER dropping empty rows, so an editor with a blank trailing
  // row isn't rejected for a contact that was never going to be saved.
  const contacts = contactsIn.map(normalizeCommercialContact).filter(Boolean);
  if (enforceCap && contacts.length > MAX_CONTACTS) {
    const err = new Error(
      `A customer can have at most ${MAX_CONTACTS} commercial contacts (received ${contacts.length}). ` +
      `Remove the extras before saving — none were saved.`
    );
    err.code = "CONTACT_CAP_EXCEEDED";
    err.limit = MAX_CONTACTS;
    err.received = contacts.length;
    throw err;
  }
  const block = {
    // careOf — the management company / party the invoice is addressed
    // THROUGH ("YRSCC #1233 c/o RMSCO Management Services Ltd."). Standard
    // for commercial: the entity legally owes, the management co receives
    // and pays. Persisted here so invoice.billTo.careOf and the acceptor's
    // organization both resolve from one structured field.
    careOf: cap(raw.careOf, 200),
    poRequired: raw.poRequired === true || raw.poRequired === "true",
    paymentTerms: cap(raw.paymentTerms, 40),
    contacts
  };
  return (contacts.length || block.careOf || block.poRequired || block.paymentTerms) ? block : null;
}

// Resolve the default quote acceptor from a customer's commercial contacts.
// Returns { acceptor, ambiguous, options }:
//   - exactly one isAuthorizedSignatory  → { acceptor, ambiguous:false }
//   - multiple isAuthorizedSignatory     → { acceptor:null, ambiguous:true, options:[…] }
//   - none                               → { acceptor:null, ambiguous:false }
// The acceptor object matches quote.acceptor's shape; organization is
// pulled from the customer's billing/entity name (best-effort).
function resolveAcceptor(customer) {
  const contacts = (customer && customer.commercial && Array.isArray(customer.commercial.contacts))
    ? customer.commercial.contacts : [];
  const signatories = contacts.filter((c) => c && c.isAuthorizedSignatory);
  if (signatories.length === 0) return { acceptor: null, ambiguous: false, options: [] };
  // Organization = the party the signatory ACTS FOR. On a c/o account the
  // signatory works for the management company (Gurdip → RMSCO), so careOf
  // wins; without a c/o it's the billed entity itself.
  const organization = ((customer.commercial && customer.commercial.careOf) || customer.billingName || "").trim();
  const toAcceptor = (c) => ({
    name: c.name || "", email: c.email || "", phone: c.phone || "",
    role: c.role || "", organization, isAuthorizedSignatory: true
  });
  if (signatories.length > 1) {
    return { acceptor: null, ambiguous: true, options: signatories.map(toAcceptor) };
  }
  return { acceptor: toAcceptor(signatories[0]), ambiguous: false, options: [] };
}

function normalizePayload(payload) {
  const cap = (val, max) => String(val == null ? "" : val).trim().slice(0, max);
  return {
    name: cap(payload?.name, 200),
    spouseName: cap(payload?.spouseName, 200),
    phone: cap(payload?.phone, 40),
    spousePhone: cap(payload?.spousePhone, 40),
    email: cap(payload?.email, 254).toLowerCase(),
    spouseEmail: cap(payload?.spouseEmail, 254).toLowerCase(),
    billingName: cap(payload?.billingName, 200),
    billingEmail: cap(payload?.billingEmail, 254).toLowerCase(),
    billingCcEmail: cap(payload?.billingCcEmail, 254).toLowerCase(),
    billingAddress: payload?.billingAddress == null
      ? null
      : cap(payload.billingAddress, 400),
    accountType: payload?.accountType === "commercial" ? "commercial" : "residential",
    // Write path — an over-cap contact list throws rather than trimming.
    commercial: normalizeCommercialBlock(payload?.commercial, { enforceCap: true }),
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
    "billingName",
    "billingEmail",
    "billingCcEmail",
    "billingAddress",
    "accountType",
    "commercial",
    "customerSince",
    "source",
    "status",
    "quickbooksId",
    "internalNotes",
    "notificationPrefs",
    "negotiatedRates",
    "copySpouseOnInvoices"
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
    if (key === "billingCcEmail") {
      // Normalized like `email` but deliberately WITHOUT the uniqueness
      // check — a bookkeeper legitimately CCs on many customers' invoices,
      // and this is not an identity/join key. Empty string clears the CC.
      const normalized = normalizeEmail(patch.billingCcEmail).slice(0, 254);
      if (current.billingCcEmail !== normalized) {
        changes.billingCcEmail = { before: current.billingCcEmail, after: normalized };
        next.billingCcEmail = normalized;
      }
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
    if (key === "negotiatedRates" && patch.negotiatedRates) {
      // Coerce numeric values, drop anything else. null clears the
      // override (so customer falls back to the catalog default).
      const incoming = patch.negotiatedRates;
      const safe = { ...(current.negotiatedRates || {}) };
      for (const rateKey of Object.keys(incoming)) {
        const val = incoming[rateKey];
        if (val === null) {
          safe[rateKey] = null;
        } else if (Number.isFinite(Number(val))) {
          safe[rateKey] = Number(val);
        }
      }
      changes.negotiatedRates = { before: current.negotiatedRates, after: safe };
      next.negotiatedRates = safe;
      continue;
    }
    if (key === "accountType") {
      const at = patch.accountType === "commercial" ? "commercial" : "residential";
      if (current.accountType !== at) {
        changes.accountType = { before: current.accountType, after: at };
        next.accountType = at;
      }
      continue;
    }
    if (key === "commercial") {
      // null clears the block; an object is normalized to
      // { poRequired, paymentTerms, contacts:[{…, isSiteContact,
      // isAuthorizedSignatory}] }. Full-replace (the admin/customer UI
      // always sends the whole contacts list).
      // Write path — an over-cap contact list throws (CONTACT_CAP_EXCEEDED)
      // and the whole PATCH fails, rather than saving a silently trimmed
      // list. Nothing has been written at this point, so the record is
      // untouched.
      const cb = patch.commercial == null
        ? null
        : normalizeCommercialBlock(patch.commercial, { enforceCap: true });
      changes.commercial = { before: current.commercial, after: cb };
      next.commercial = cb;
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

// Stores carrying a customerId. Same list as mergeCustomers' re-point
// pass — the two must stay in step: anything merge can re-point is
// something delete has to account for.
//
// deleted-invoices.json (the void-invoice tombstone log) is deliberately
// absent — see the note on DELETED_FILE in lib/invoices.js.
const CUSTOMER_LINK_FILES = [
  "leads.json", "properties.json", "bookings.json",
  "work-orders.json", "quotes.json", "invoices.json", "projects.json"
];

// A record in the Trash carries `deletedAt` (leads, quotes, properties,
// work-orders all use that one marker; bookings and projects have no
// soft-delete, and a deleted invoice leaves invoices.json entirely for
// the tombstone log). It is gone from every index, so it is NOT a live
// link — see the split in scanCustomerLinks().
function isTrashed(record) {
  return Boolean(record && typeof record.deletedAt === "string" && record.deletedAt);
}

// Split everything pointing at this customer into what is live and what
// is already in the Trash. Both maps are { store: [ids] }, keyed by the
// file's base name ("quotes", "work-orders", …).
async function scanCustomerLinks(id) {
  const dataDir = path.join(__dirname, "..", "data");
  const live = {};
  const trashed = {};
  for (const file of CUSTOMER_LINK_FILES) {
    const fullPath = path.join(dataDir, file);
    if (!fsSync.existsSync(fullPath)) continue;
    try {
      const raw = await fs.readFile(fullPath, "utf8");
      const arr = JSON.parse(raw || "[]");
      if (!Array.isArray(arr)) continue;
      const store = file.replace(".json", "");
      const matches = arr.filter((r) => r && r.customerId === id);
      const liveIds = matches.filter((r) => !isTrashed(r)).map((r) => r.id).filter(Boolean);
      const trashedIds = matches.filter(isTrashed).map((r) => r.id).filter(Boolean);
      if (liveIds.length) live[store] = liveIds;
      if (trashedIds.length) trashed[store] = trashedIds;
    } catch (err) {
      console.warn(`[hardDelete] couldn't check ${file}:`, err.message);
    }
  }
  return { live, trashed };
}

// Permanently remove the Trash records named in `trashed` ({ store: [ids] }).
// Direct JSON-file ops for the same reason mergeCustomers uses them: this
// is a bulk cross-store pass, not a granular per-entity patch. What it does
// to each record is what the 30-day Trash purge does — splice it out, no
// history (the record itself is going). Returns { store: [ids] } actually
// removed.
async function purgeTrashedLinks(id, trashed) {
  const dataDir = path.join(__dirname, "..", "data");
  const purged = {};
  for (const [store, ids] of Object.entries(trashed)) {
    const idSet = new Set(ids);
    const fullPath = path.join(dataDir, `${store}.json`);
    if (!fsSync.existsSync(fullPath)) continue;
    const raw = await fs.readFile(fullPath, "utf8");
    const arr = JSON.parse(raw || "[]");
    if (!Array.isArray(arr)) continue;
    // Re-assert both conditions at the moment of the write: only this
    // customer's records, and only ones still in the Trash. A restore
    // between the scan and here takes the record back out of scope.
    const kept = arr.filter((r) => !(r && idSet.has(r.id) && r.customerId === id && isTrashed(r)));
    const removedCount = arr.length - kept.length;
    if (!removedCount) continue;
    const removedIds = arr
      .filter((r) => r && idSet.has(r.id) && r.customerId === id && isTrashed(r))
      .map((r) => r.id);
    await fs.writeFile(fullPath, JSON.stringify(kept, null, 2) + "\n", "utf8");
    purged[store] = removedIds;
  }
  return purged;
}

// Hard-delete — actually removes the record from customers.json.
// Refuses if any LIVE entity references this customer. Caller must use
// merge() first when they want to combine duplicates, or accept
// loss-of-link when nothing is yet attached (typical for test data
// and accidental near-duplicates with no bookings/WOs/etc yet).
//
// Records already in the Trash do not block (CRM-16). They are invisible
// everywhere in the CRM — the customer page's own tabs are built from
// list() calls that filter them out — so counting them made the refusal
// name links the operator could not see and had no way to act on from
// this page. But they cannot simply be ignored either: restoring one
// after its customer is gone would strand it exactly the way CRM-15's
// booking was stranded. So a Trash-only customer needs a second, explicit
// confirm, and the delete then purges those Trash records with it. The
// caller passes { purgeTrashed: true } for that confirm.
//
// Returns { ok: true, customer, purged } on success, or
//         { ok: false, code, error, references, trashed } when blocked:
//           code "linked"       — live links; Merge (or delete them) first
//           code "trashed_only" — nothing live, N records in the Trash;
//                                 re-call with purgeTrashed to go ahead
async function hardDelete(id, { purgeTrashed = false } = {}) {
  const records = await readAll();
  const idx = records.findIndex((c) => c.id === id);
  if (idx === -1) return { ok: false, error: "Customer not found." };

  const { live, trashed } = await scanCustomerLinks(id);
  if (Object.keys(live).length) {
    return {
      ok: false,
      code: "linked",
      error: "Customer is referenced by other records. Use merge to combine them, or remove the references first.",
      references: live,
      ...(Object.keys(trashed).length ? { trashed } : {})
    };
  }
  if (Object.keys(trashed).length && !purgeTrashed) {
    return {
      ok: false,
      code: "trashed_only",
      error: "Nothing live is linked to this customer, but records in the Trash still are. Deleting the customer permanently deletes those Trash records too.",
      trashed
    };
  }

  // Purge BEFORE removing the customer: a failed write leaves the
  // customer in place with its Trash records intact, which is a state the
  // operator can retry from. The reverse order would strand them.
  const purged = Object.keys(trashed).length ? await purgeTrashedLinks(id, trashed) : {};

  const removed = records.splice(idx, 1)[0];
  await writeAll(records);
  return { ok: true, customer: removed, purged };
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
    "email", "spouseEmail", "billingName", "billingEmail", "billingAddress",
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
  normalizeCommercialContact,
  normalizeCommercialBlock,
  resolveAcceptor,
  list,
  get,
  create,
  update,
  remove,
  hardDelete,
  scanCustomerLinks,
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
