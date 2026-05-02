// Work Orders — the tech-side document that captures what actually
// happened on a visit. Distinct from `lead.booking.workOrder`, which
// is the customer-facing envelope (status / total / price label) shown
// on the portal card. The two share an ID so customer + tech see the
// same WO-XXXXXXXX, but the detailed per-zone state lives here.
//
// Each WO is per-property + per-visit. A property with two visits a
// year (spring + fall) accumulates two work orders annually.
//
// Templates:
//   spring_opening  — pre-populates the zone grid from the property
//                     so the tech can walk row-by-row checking heads.
//   fall_closing    — same scaffolding (the work is different but the
//                     row-per-zone shape is identical).
//   service_visit   — empty zone grid; tech adds zones as they touch
//                     them. Used for repair-only / one-off visits.
//
// Per-zone status (the dropdown from the spec):
//   "" (blank, not yet checked)
//   working_well
//   adjusted
//   repair_required
//   other
//
// Storage: server/data/work-orders.json. Same flat-file pattern as
// leads.json / properties.json. PJL-scale is fine; rotate to SQLite
// when WO count crosses ~10,000.
//
// Future phases (NOT done in this slice):
//   - additionalRepairs[] beyond the zone grid
//   - line items + auto-invoice
//   - "Send for approval" → customer accepts → status flow
//   - GPS pings + job timer
// The fields exist as empty placeholders so we don't have to migrate
// records when those phases land.

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const FILE = path.join(__dirname, "..", "data", "work-orders.json");

const TEMPLATES = {
  spring_opening: { label: "Spring Opening", scaffoldFromProperty: true },
  fall_closing:   { label: "Fall Closing",   scaffoldFromProperty: true },
  service_visit:  { label: "Service Visit",  scaffoldFromProperty: false }
};

// Map a booking's serviceKey (from availability.js BOOKABLE_SERVICES) to
// the right WO template. Used by the today's-schedule page to spin up
// a WO on-tap with the correct scaffolding. Defaults to service_visit
// for anything unrecognized — safer than throwing on a tech tap.
function templateForServiceKey(serviceKey) {
  const key = String(serviceKey || "");
  if (key.startsWith("spring_open_")) return "spring_opening";
  if (key.startsWith("fall_close_"))  return "fall_closing";
  // sprinkler_repair, hydrawise_retrofit, site_visit and any future
  // one-off services all open as service_visit — the WO is the same
  // shape regardless of the booked label.
  return "service_visit";
}

const ZONE_STATUSES = ["", "working_well", "adjusted", "repair_required", "other"];

// Standard zone checks per spec §4.3.2 walk-through. Five tap-boxes the
// tech ticks off per zone — granular evidence behind the ZONE_STATUSES
// summary. Stored as booleans on `zone.checks` so we can both render the
// individual ticks AND aggregate "X/5 passed" badges in the zone list.
const ZONE_CHECK_KEYS = ["operated", "pressureGood", "coverageGood", "noLeaks", "allHeadsFunctional"];

// Issue types per spec §4.3.2 — the tech tags each issue with a category
// so it can roll up into a draft quote (Tier 3). The keys roughly map to
// pricing.json item categories: head_replacement, manifold rebuilds,
// wire diagnostic / wire run, pipe break repair. "other" is the escape
// hatch for anything that doesn't fit (custom on-site quote).
const ZONE_ISSUE_TYPES = ["broken_head", "leak", "valve", "wire", "pipe", "other"];

// Service-specific checklists per spec §4.3.2. Spring openings get a
// 4-step "service-specific steps" block; fall closings get a 6-step
// winterization block. Service visits (one-off repairs) have no
// service-specific steps — the zone walk-through and tech notes carry
// everything they need. Each step has a stable key (so booleans
// persist across schema iterations) plus a customer-facing label.
const SERVICE_CHECKLISTS = {
  spring_opening: [
    { key: "water_on",                  label: "Water turned on at main shut-off" },
    { key: "backflow_check",            label: "Backflow visual check" },
    { key: "controller_programmed",     label: "Controller programmed for season" },
    { key: "walkthrough_with_customer", label: "Walk-through with customer (if home)" }
  ],
  fall_closing: [
    { key: "controller_off",            label: "Controller set to off / winter mode" },
    { key: "water_off",                 label: "Water shut off at main" },
    { key: "compressor_connected",      label: "Compressor connected at blow-out" },
    { key: "zones_blown_clear",         label: "All zones blown clear" },
    { key: "compressor_disconnected",   label: "Compressor disconnected" },
    { key: "system_winterized",         label: "System winterized" }
  ],
  service_visit: []
};

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

// Match the customer-facing booking WO ID format. Same alphabet (no
// I/O/0/1) so they can be read aloud over the phone unambiguously.
function makeWorkOrderId() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id = "WO-";
  const bytes = crypto.randomBytes(8);
  for (let i = 0; i < 8; i++) id += alphabet[bytes[i] % alphabet.length];
  return id;
}

function blankWorkOrder() {
  return {
    // The customer-facing ID is also the primary key. Eight chars from
    // the unambiguous alphabet — collisions are vanishingly unlikely
    // at PJL scale, and we re-roll if we ever see one.
    id: makeWorkOrderId(),
    type: "service_visit",          // see TEMPLATES
    status: "scheduled",             // scheduled | on_site | awaiting_approval | approved | completed | cancelled
    propertyId: null,
    leadId: null,
    customerName: "",
    customerEmail: "",
    customerPhone: "",
    address: "",
    scheduledFor: null,              // ISO datetime — copied from lead.booking.start when created
    zones: [],                       // [{ number, location, sprinklerTypes, coverage, status, notes }]
    additionalRepairs: [],           // Phase 2+ free-form line items (valves/mainline/wire/etc.)
    lineItems: [],                   // Phase 4 — invoice line items
    diagnosis: "",                   // copied from booking handoff if present
    techNotes: "",                   // tech's overall visit notes
    // AI Intake Guarantee — copied from the source Quote when this WO is
    // created from a lead with an accepted ai_repair_quote. When `applies`
    // is true, the tech UI shows a banner: "Labour locked for [scope] — do
    // not bill additional labour." Spec rule 6 (§4.3.3): tech honours the
    // quoted scope regardless of time on-site.
    intakeGuarantee: {
      applies: false,
      scope: "",
      sourceQuoteId: null
    },
    // Service-specific checklist — keyed by step key from
    // SERVICE_CHECKLISTS[wo.type]. Stored as a flat {stepKey: bool} map
    // so the rendering code doesn't depend on order; ordering comes from
    // the SERVICE_CHECKLISTS constant.
    serviceChecklist: {},
    // Customer sign-off — the legally binding moment per spec §4.3.2.
    // imageData is the dataURL of the signature canvas; ip + userAgent
    // are captured server-side at sign time (never trust the client).
    // Once `signed` flips to true the WO `locked` field also flips to
    // true and the tech UI disables further edits. Spec rule 11
    // (§4.3.3): "Signed WO is the contract. Locked once signed."
    signature: {
      signed: false,
      customerName: "",
      imageData: "",
      acknowledgement: false,
      signedAt: null,
      ip: null,
      userAgent: null
    },
    locked: false,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

// Backfill missing keys on records read from disk. Lets the schema
// grow without an explicit migration step.
function hydrate(w) {
  const base = blankWorkOrder();
  return {
    ...base,
    ...w,
    zones: Array.isArray(w?.zones) ? w.zones.map(hydrateZone) : [],
    additionalRepairs: Array.isArray(w?.additionalRepairs) ? w.additionalRepairs : [],
    lineItems: Array.isArray(w?.lineItems) ? w.lineItems : [],
    intakeGuarantee: { ...base.intakeGuarantee, ...(w?.intakeGuarantee || {}) },
    serviceChecklist: { ...(w?.serviceChecklist || {}) },
    signature: { ...base.signature, ...(w?.signature || {}) },
    locked: w?.locked === true
  };
}

// Backfill the per-zone checks{} and issues[] fields onto records that
// pre-date the Tier 2 schema. Defensive merge — never overwrites an
// existing `checks` object or `issues` array.
function hydrateZone(z) {
  const baseChecks = {};
  for (const key of ZONE_CHECK_KEYS) baseChecks[key] = false;
  return {
    number: z?.number || 0,
    location: z?.location || z?.label || "",
    sprinklerTypes: Array.isArray(z?.sprinklerTypes) ? z.sprinklerTypes : [],
    coverage: Array.isArray(z?.coverage) ? z.coverage : [],
    status: z?.status || "",
    notes: z?.notes || "",
    checks: { ...baseChecks, ...(z?.checks || {}) },
    issues: Array.isArray(z?.issues) ? z.issues.map(hydrateIssue) : []
  };
}

// Issue records get an id stamped if missing — the editor needs a stable
// key to track add/remove without reorder bugs. Type is clamped to the
// known set; unknowns become "other" so the UI can still render them.
function hydrateIssue(issue) {
  const safeType = ZONE_ISSUE_TYPES.includes(issue?.type) ? issue.type : "other";
  return {
    id: issue?.id || ("iss_" + Math.random().toString(36).slice(2, 10) + "_" + Date.now()),
    type: safeType,
    qty: Number.isFinite(Number(issue?.qty)) && Number(issue?.qty) > 0 ? Number(issue.qty) : 1,
    notes: issue?.notes || ""
  };
}

// Copy a property's zone list into the WO scaffold so the tech sees
// every zone from the moment they open it. We snapshot the values
// (location/sprinklerTypes/coverage) rather than referencing the
// property — if Patrick later edits the property profile, the WO
// keeps showing what was true at the time of the visit.
function scaffoldZonesFromProperty(property) {
  const zones = Array.isArray(property?.system?.zones) ? property.system.zones : [];
  const blankChecks = {};
  for (const key of ZONE_CHECK_KEYS) blankChecks[key] = false;
  return zones
    .slice()
    .sort((a, b) => (a.number || 0) - (b.number || 0))
    .map((z) => ({
      number: z.number || 0,
      location: z.location || z.label || "",
      sprinklerTypes: Array.isArray(z.sprinklerTypes) ? z.sprinklerTypes.slice() : [],
      coverage: Array.isArray(z.coverage) ? z.coverage.slice() : [],
      status: "",
      notes: "",
      checks: { ...blankChecks },
      issues: []
    }));
}

// ---- CRUD -----------------------------------------------------------

async function list() {
  return readAll();
}

async function get(id) {
  const records = await readAll();
  return records.find((w) => w.id === id) || null;
}

async function listByProperty(propertyId) {
  const records = await readAll();
  return records.filter((w) => w.propertyId === propertyId);
}

async function listByLead(leadId) {
  const records = await readAll();
  return records.filter((w) => w.leadId === leadId);
}

// Create a new WO. `type` selects the template; `lead` and `property`
// are the source records. The lead may be null (ad-hoc / no booking
// trigger), but at least one of (leadId, propertyId) must be set.
//
// `quote` is optional. When passed (the caller has fetched the lead's
// linked Quote), an AI Intake Guarantee from the quote propagates onto
// the WO so the tech sees the locked-labour banner in field mode.
async function create({ type, lead, property, customId, quote = null }) {
  if (!TEMPLATES[type]) throw new Error(`Unknown work-order type: ${type}`);
  if (!lead && !property) throw new Error("Need at least one of lead or property to create a work order.");

  const records = await readAll();
  const wo = blankWorkOrder();
  if (customId) wo.id = customId;
  wo.type = type;

  if (property) {
    wo.propertyId = property.id;
    wo.address = property.address || "";
    wo.customerName  = wo.customerName  || property.customerName  || "";
    wo.customerEmail = wo.customerEmail || property.customerEmail || "";
    wo.customerPhone = wo.customerPhone || property.customerPhone || "";
    if (TEMPLATES[type].scaffoldFromProperty) {
      wo.zones = scaffoldZonesFromProperty(property);
    }
  }

  if (lead) {
    wo.leadId = lead.id;
    wo.customerName  = wo.customerName  || lead.name  || "";
    wo.customerEmail = wo.customerEmail || lead.email || "";
    wo.customerPhone = wo.customerPhone || lead.phone || "";
    if (!wo.address) wo.address = lead.location || lead.address || "";
    if (lead.booking?.start) wo.scheduledFor = lead.booking.start;
    if (lead.booking?.workOrder?.diagnosis) {
      wo.diagnosis = typeof lead.booking.workOrder.diagnosis === "string"
        ? lead.booking.workOrder.diagnosis
        : (lead.booking.workOrder.diagnosis.summary || "");
    }
  }

  // AI Intake Guarantee — snapshotted from the source Quote at WO creation
  // time. Mutating the Quote later doesn't change the locked scope on a
  // dispatched WO; the tech honours what was on the WO when they got it.
  if (quote && quote.intakeGuarantee && quote.intakeGuarantee.applies === true) {
    wo.intakeGuarantee = {
      applies: true,
      scope: String(quote.intakeGuarantee.scope || "").slice(0, 200),
      sourceQuoteId: quote.id || null
    };
  }

  records.unshift(wo);
  await writeAll(records);
  return wo;
}

async function update(id, patch) {
  const records = await readAll();
  const idx = records.findIndex((w) => w.id === id);
  if (idx === -1) return null;
  const current = records[idx];

  // Allow shallow merge on top-level fields, but `zones`, `additionalRepairs`,
  // `lineItems` are replaced wholesale when present (the editor sends the
  // entire array). Block id changes and the structural propertyId/leadId
  // pointers — those are set at create time and shouldn't be edited from
  // the form.
  const next = { ...current };
  const allowedTop = ["type", "status", "scheduledFor", "diagnosis", "techNotes", "customerName", "customerPhone", "customerEmail", "address", "locked"];
  for (const key of allowedTop) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) next[key] = patch[key];
  }
  if (Array.isArray(patch.zones)) next.zones = patch.zones.map(hydrateZone);
  if (Array.isArray(patch.additionalRepairs)) next.additionalRepairs = patch.additionalRepairs;
  if (Array.isArray(patch.lineItems)) next.lineItems = patch.lineItems;
  // Service checklist — replace wholesale when sent (the editor PATCHes
  // the whole map). Signature is shallow-merged so partial updates (e.g.
  // typing the name before drawing the signature) don't clobber other
  // fields. Server-side fields (ip, userAgent, signedAt) are filled by
  // the server route, never by the client patch.
  if (patch.serviceChecklist && typeof patch.serviceChecklist === "object") {
    next.serviceChecklist = { ...patch.serviceChecklist };
  }
  if (patch.signature && typeof patch.signature === "object") {
    next.signature = { ...current.signature, ...patch.signature };
  }
  next.updatedAt = new Date().toISOString();

  records[idx] = next;
  await writeAll(records);
  return next;
}

async function remove(id) {
  const records = await readAll();
  const idx = records.findIndex((w) => w.id === id);
  if (idx === -1) return null;
  const [removed] = records.splice(idx, 1);
  await writeAll(records);
  return removed;
}

module.exports = {
  TEMPLATES,
  ZONE_STATUSES,
  ZONE_CHECK_KEYS,
  ZONE_ISSUE_TYPES,
  SERVICE_CHECKLISTS,
  templateForServiceKey,
  list,
  get,
  listByProperty,
  listByLead,
  create,
  update,
  remove
};
