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
  service_visit:  { label: "Service Visit",  scaffoldFromProperty: false },
  // Brief 2 (May 2026) — build mode for multi-day installs / retrofits
  // under a Project. Each calendar day is one build WO. Daily-log
  // structure on the WO captures sessions, labourer count, tasks
  // completed today, materials consumed, photos (task-anchored),
  // daily notes, next-day plan. Build WO completion does NOT fire the
  // standard cascade — only project completion does. See
  // completion-cascade.js for the short-circuit branch.
  build:          { label: "Build / Install", scaffoldFromProperty: false }
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
// zone_revamp added 2026-08-31 (fall-closing field flow). A zone that
// needs redoing wholesale is a different job from replacing a part in it,
// and next spring it should read as a zone-level job rather than hide
// under "other" where it can't be counted or filtered.
const ZONE_ISSUE_TYPES = ["broken_head", "leak", "valve", "wire", "pipe", "controller", "zone_revamp", "other"];

// Photo categories per spec §4.3.2. Photos can be attached at the WO
// level (pre/in/post-work documentation) or to a specific issue inside
// a zone (the broken head, the leaking valve box, etc.). The category
// drives where the photo renders in the tech UI.
const WO_PHOTO_CATEGORIES = ["pre_work", "in_progress", "post_work", "issue", "general"];

// Completion-photo gate per service mode (Brief E / spec §4.3.2 §4.3.3 r14).
// Walk-out checklist refuses to mark a WO `completed` until at least one
// photo has been captured for these types — winterized fall-closings
// often have no visible "completed" state to photograph (snow on the
// blow-out point, controller already off), so the gate stays optional
// there. Threshold is the minimum photo count.
const PHOTO_REQUIREMENT_BY_TYPE = {
  spring_opening: 1,    // find_and_fix — proof of zone health post-opening
  service_visit:  1,    // find_and_fix / fix_only — proof of repair
  fall_closing:   0,    // find_only — optional
  build:          0     // multi-day; photos accumulate naturally over days, no single-WO requirement
};

// Customer-visible note per service mode (Patrick, 2026-09-05).
//
// The note is the customer-facing NARRATIVE on the service report: what we
// did at this visit. That is a real question on an opening or a service
// call, where the work varies with what was found and the customer is
// reading to learn what happened to their system.
//
// A fall closing does the same thing at every property: blow the zones out,
// shut the water off, drain. The report already carries the four-step
// checklist, who shut the water off, whether a back-flush was needed, and
// per-zone findings — and the zone note field takes anything worth knowing
// next spring. A required free-text box that always says "blew out the
// system" is not a record; it is a field people learn to type through, and
// it costs a tech standing in the cold at the end of every visit.
//
// Unknown types default to REQUIRED — a new service mode should have to opt
// out deliberately rather than lose the narrative by omission.
const CUSTOMER_NOTE_REQUIRED_BY_TYPE = {
  spring_opening: true,   // what was found and fixed on the way back up
  service_visit:  true,   // the repair narrative — the reason for the visit
  fall_closing:   false,  // identical every time; the checklist IS the record
  build:          true    // multi-day install; the customer is owed a summary
};

// Service-specific checklists per spec §4.3.2. Spring openings get a
// 4-step "service-specific steps" block; fall closings get a 6-step
// winterization block. Service visits (one-off repairs) have no
// service-specific steps — the zone walk-through and tech notes carry
// everything they need. Each step has a stable key (so booleans
// persist across schema iterations) plus a customer-facing label.
const SERVICE_CHECKLISTS = {
  // Backflow intentionally NOT in this list. PJL is not a certified
  // Ontario backflow tester — see memory/backflow_not_certified.md. If
  // a customer asks about backflow, refer out.
  spring_opening: [
    { key: "water_on",                  label: "Water turned on at main shut-off" },
    { key: "controller_programmed",     label: "Controller programmed for season" },
    { key: "walkthrough_with_customer", label: "Walk-through with customer (if home)" }
  ],
  // Revised 2026-08-31 to match the close-out Patrick actually performs.
  // `compressor_connected` and `zones_blown_clear` are gone from the
  // definition: the field flow now records the blow-out per zone, so a
  // single "all zones blown clear" tick was a claim about work the zone
  // pages evidence individually. Back-flush and who shut the water off
  // are NOT here — they are three-state answers, not ticks, and live as
  // `backFlush` and `waterShutoffBy` on the work order.
  //
  // Removing keys from this list does NOT erase them from work orders
  // that stored them; serviceChecklist is a free-form map. Anything
  // rendering a checklist must use checklistKeysForWorkOrder() below so
  // historical closings keep the lines they were signed against.
  fall_closing: [
    { key: "controller_off",            label: "Controller set to off / winter mode" },
    { key: "water_off",                 label: "Water shut off at main" },
    { key: "compressor_disconnected",   label: "Compressor disconnected" },
    { key: "system_winterized",         label: "System winterized" }
  ],
  service_visit: [],
  // Build WOs have no fixed checklist — each day is freeform. The daily
  // notes block + task checklist drive the narrative instead.
  build: []
};

// The checklist keys to RENDER for a given work order: the current
// definition for its type, followed by any key the work order actually
// stored that the definition no longer carries.
//
// This exists because the definition changes over time and completed work
// orders do not. A fall closing signed in 2025 recorded
// `zones_blown_clear`; dropping that key from the list above must not
// quietly delete a line from the customer report if it is regenerated for
// a warranty claim two years later. Render the union, and the past keeps
// saying what it said.
function checklistKeysForWorkOrder(wo) {
  const defined = (SERVICE_CHECKLISTS[wo?.type] || []).map((step) => step.key);
  const stored = Object.keys(wo?.serviceChecklist || {});
  const extra = stored.filter((key) => !defined.includes(key));
  return [...defined, ...extra];
}

// Brief 2 — random 8-char base36 IDs for session / scope-change / etc.
// Matches the iss_<random8>_<ts> + att_<random8> + sec_<random8> +
// task_<random8> conventions from Briefs A and 1.
function wo_random8() {
  return Math.random().toString(36).slice(2, 10).padEnd(8, "0");
}
function newSessionId() { return "sess_" + wo_random8(); }

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

// Brief 2 — initialize a fresh build-mode daily log. workDate defaults
// to today's local ISO date (UTC-shifted to Toronto by the caller if
// needed; this lib uses UTC for storage and lets the UI display in
// local).
function blankDailyLog({ workDate = null } = {}) {
  const today = workDate || new Date().toISOString().slice(0, 10);
  return {
    workDate: today,
    sessions: [],
    tasksCompletedToday: [],
    materialsConsumed: [],
    nextDayMaterials: [],
    nextDayTasks: [],
    dailyNotes: ""
  };
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
    // Canonical customer reference (Brief 2). Joins SCOPE_PROTECTED_FIELDS
    // so it locks at signature alongside the customer snapshot fields —
    // a signed WO's customer identity must not silently change.
    customerId: null,
    customerName: "",
    customerEmail: "",
    customerPhone: "",
    address: "",
    scheduledFor: null,              // ISO datetime — copied from lead.booking.start when created
    zones: [],                       // [{ number, location, sprinklerTypes, coverage, status, notes }]
    additionalRepairs: [],           // Phase 2+ free-form line items (valves/mainline/wire/etc.)
    lineItems: [],                   // Phase 4 — invoice line items
    diagnosis: "",                   // copied from booking handoff if present
    techNotes: "",                   // tech's overall visit notes (admin-only)
    // Customer-facing narrative for the visit (Service / Inspection Report
    // brief, 2026-05-19). Voice-input enabled. Surfaced in the report PDF
    // as "Customer-visible notes." REQUIRED non-empty before signature —
    // see computeServerSidePreSignFailures in server.js. Scope-protected
    // at signature; locks alongside lineItems / onSiteQuote.
    customerNotes: "",
    // AI-Correct-Diagnosis Bonus eligibility — copied from the source Quote
    // when this WO is created from a lead with an accepted ai_repair_quote.
    // When `applies` is true, the tech UI shows a banner: "AI-Correct-
    // Diagnosis Bonus PENDING for [scope]. Customer's first hour of repair
    // labour is temporarily disabled until you confirm the on-site diagnosis
    // matches." Confirmed match → credit 1 hr of repair labour free on the
    // diagnosed scope. Diagnosis wrong → bill labour normally at $95/hr.
    // Spec rule 6 (§4.3.3): tech reviews the AI scope, confirms or denies
    // match on-site, then applies the bonus credit accordingly.
    intakeGuarantee: {
      applies: false,
      scope: "",
      sourceQuoteId: null,
      // Tech's on-site decision (Brief F / spec §4.3.3 r6 + pricing.json
      // ai_intake_correct_diagnosis_bonus). Captured via the cheat-sheet
      // card BEFORE customer signature.
      //   null  — undecided (default; signature canvas is gated on this)
      //   true  — diagnosis matched → 1 hour repair labour credited as
      //           a -1 × hourly_labour line on the on-site quote builder
      //   false — diagnosis didn't match → no credit, labour bills normally
      // Locked once the WO is signed (intakeGuarantee is in
      // SCOPE_PROTECTED_FIELDS — Brief A).
      matched: null,
      mismatchReason: ""
    },
    // Service-specific checklist — keyed by step key from
    // SERVICE_CHECKLISTS[wo.type]. Stored as a flat {stepKey: bool} map
    // so the rendering code doesn't depend on order; ordering comes from
    // the SERVICE_CHECKLISTS constant.
    serviceChecklist: {},
    // Photos — meta only. Files live on disk under
    // server/data/wo-photos/<woId>/<n>.<ext>. Each entry: { n,
    // mediaType, bytes, addedAt, category, zoneNumber, issueId, label }.
    // Issue photos reference back via issueId so the editor can group
    // them per issue at render time.
    photos: [],
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
    // End-of-visit signature bypass — admin-authored alternative to the
    // drawn-signature path used when the customer is not physically present
    // at visit end (left for work, vacant winter home, etc.). NOT a fake
    // signature: it's an honest record of verbal acceptance, deliberately
    // distinguished from `signature` in legal posture but operationally
    // equivalent for wo.locked and the completion cascade.
    //
    // `signature` and `signatureBypass` are mutually exclusive — a WO
    // carries one or the other, never both. Server enforces at capture.
    //
    //   reason: "customer_not_home" | "trusted_customer_verbal" | "other"
    //   note: free text; min 10 chars (trimmed)
    //   customerNamePrinted: pulled server-side from the customer/property
    //                        record at capture time — never client-supplied
    //   bypassedBy: "admin" today; carries a tech identity when real tech
    //               accounts exist (future)
    //   ts, ip, userAgent: server-stamped at capture
    signatureBypass: null,
    // On-site Quote (Issues → Draft Quote rollup, spec §4.3.2). Tech
    // builds it from zone.issues during the visit; customer signs to
    // accept selected lines; declined lines flow into the property's
    // deferredIssues. The Quote itself is a separate Q-YYYY-NNNN record
    // in quotes.json — this field is just the WO's pointer + builder
    // working state.
    //   status: none → draft → sent → accepted | partially_accepted | declined
    //   builderLineItems: tech's pre-customer-signature working draft;
    //     replaced wholesale on PATCH; cleared after accept (the final
    //     line items live on the Quote record).
    onSiteQuote: {
      quoteId: null,
      status: "none",
      lastBuiltAt: null,
      builderLineItems: []
    },
    locked: false,
    // On-site execution timestamps (spec §4.3.2). Auto-stamped by the
    // tech UI on status flips: scheduled→on_site stamps arrivedAt;
    // anything→completed stamps departedAt.
    arrivedAt: null,
    departedAt: null,
    // Where the tech was when they tapped Start Service. arrivedAt records
    // WHEN; without this there is no record of WHERE, which is the half
    // that matters if a customer ever disputes that the visit happened.
    // { lat, lng, accuracy, capturedAt } or null when the device refused
    // or the tech declined the permission — never a blocker.
    arrivalLocation: null,
    // Fall closings: who actually shut the water off. One or the other,
    // never both — a customer who already closed it leaves nothing for
    // the tech to close, and nothing to photograph either, which is why
    // the water-off photo is optional.
    //   "" | "customer" | "tech"
    waterShutoffBy: "",
    // Fall closings: back-flush is a question, not a task. Not every
    // property has one, so "no" is a complete answer and satisfies the
    // close-out — unlike a checklist tick, where false reads as "not done
    // yet".
    //   "" | "yes" | "no"
    backFlush: "",
    // Completion timestamp (JOB-002 Part A). Server-stamped by update()
    // the moment status transitions into "completed" — on EVERY path,
    // unlike departedAt which only the tech UI supplies. Never patchable
    // from a client (not in allowedTop); null until completed. Warranty
    // expiry is computed from this + type via lib/warranty.js.
    completedAt: null,
    // Materials packed checklist (spec §4.3.2). Map of sku → bool.
    // Populated as the tech taps each row in the materials list.
    materialsPacked: {},
    // Cascade-merge follow-up — brief-literal §4.6 materials gate.
    // ISO timestamp set when tech taps "Confirm materials list" in
    // tech mode. null = unconfirmed. Cleared when materialsPacked /
    // customParts is mutated (any qty change forces re-confirmation).
    // hydrate() auto-fills this for fall_closing WOs and any WO with
    // empty materialsPacked + customParts so the gate doesn't block
    // when the tech genuinely has nothing to confirm.
    // COMPLEMENTARY to 43c766f's `techMaterialsSection` packing-rows
    // gate — that one fires on follow-up packing, this one fires on
    // explicit confirmation of the current visit's materials.
    materialsConfirmedAt: null,
    // Service-call fee waiver (Patrick 2026-06-06). When set, the $95
    // service_call mobilization fee is bypassed on this WO — the pricing
    // rollup emits a $0 "Service call fee — WAIVED (reason)" line instead
    // of the normal $95 charge, so the customer sees they were credited.
    // Captured at WO creation (admin form) for service_visit WOs; null on
    // every other record (and a no-op on seasonal WOs, which never carry a
    // separate service_call). Shape per lib/service-fee-waiver.js:
    //   { waived: true, reason, notes, waivedBy, waivedAt }
    // Scope-protected — frozen once the WO is signed (the customer agreed
    // to the waived total).
    serviceFeeWaiver: null,
    // Warranty-claim provenance (FLOW-30, 2026-08-29). Set when this WO
    // was raised by approving a warranty claim, so the tech on site can
    // see WHAT prior work they are honouring and WHY the service call is
    // free. null on every WO not born from a claim.
    //
    //   {
    //     claimId,              "2026-08-29-00020260001"
    //     claimedInvoiceId,     the invoice the claim was made against
    //     claimedWorkOrderId,   the WO behind that invoice (the prior work)
    //     summary,              the customer's description of the fault
    //     approvedBy, approvedAt,
    //     converted: null | {   the scapegoat — see convertWarrantyToChargeable()
    //       at, by, reason
    //     }
    //   }
    //
    // Scope-protected: this is the customer's contractual context ("we
    // are here at no charge to fix X"), so it freezes with the rest of
    // the scope once they sign.
    warrantyClaim: null,
    // Payment captured on-site? (spec §4.3.2 Payment & Billing).
    //   false — "No, invoice to follow" (default — Patrick's stated
    //           real-world default. "we are highly unlikely to recieve
    //           payment in person... I want everything to be billed
    //           through online.")
    //   true  — paid in the field (rare; cascade flags invoice with
    //           paidOnSiteAtCompletion but no receipt is auto-emailed)
    //   null  — legacy unset (treated as false on load in tech UI)
    // Patrick still reviews each draft invoice before sending — auto-
    // paid invoices in QB before reconciliation are a Bad Idea.
    paidOnSite: false,
    // Property updates flow-back idempotency marker (Brief D / spec §10 r3).
    // Set to ISO timestamp when the cascade has applied this WO's
    // property edits (zone description changes, controller info, new
    // zones flagged for review, etc.) back to the linked property record.
    // Cascade re-fire checks this and skips re-application — ensures we
    // don't double-apply or stomp on subsequent property edits.
    propertyEditsAppliedAt: null,
    // Service / Inspection Report PDF snapshots (Service Report brief,
    // 2026-05-19). Append-only list — every send-for-approval, every
    // cascade fire, and every manual snapshot writes a new entry. The
    // file lives at server/data/wo-reports/<woId>/<snapshotId>.pdf and
    // becomes the customer's source of truth (the live render is admin-
    // only). Each entry:
    //   { snapshotId, ts, triggerType, mode, quoteId?, filename, path, sha256?, by }
    //     triggerType: "quote_send" | "cascade" | "manual"
    //     mode:        "inspection_report" | "service_report"
    //     quoteId:     populated only on quote_send
    //     sha256:      integrity hash of the PDF bytes
    reportSnapshots: [],
    // Cascade-time report snapshot idempotency stamp. Set on first
    // successful cascade snapshot creation; gates re-fires (look up the
    // existing cascade-triggered entry in reportSnapshots[] instead of
    // generating a duplicate). Same posture as propertyEditsAppliedAt.
    completionReportSnapshotAt: null,
    // Follow-up linkage — when this WO is the parent of a follow-up
    // service visit, followupWoIds[] back-references the children.
    // followupOfWoId points at the parent if this IS a follow-up.
    followupWoIds: [],
    followupOfWoId: null,
    // Return-visit decision (Patrick 2026-05-12 service-call flow). The
    // tech picks Yes/No before signing; the tech UI hides the "Parts
    // to bring back" + "Schedule follow-up" sections unless this is
    // true. null = not yet decided (which is also a pre-sign gate
    // failure — the tech must answer one way or the other). On a
    // signed WO this is part of the locked contract.
    needsReturnVisit: null,
    // Labour hours on-site (Patrick 2026-05-13). Decimal hours (e.g.
    // 1.5 = 1h 30m). Captured for back-office accounting on
    // service_visit / spring_opening / fall_closing WOs — these
    // flat-fee visits already include labour in the quoted price; the
    // tracking is internal-only (cost analysis, tech performance, not
    // billed separately). null = not yet logged. Auto-suggested from
    // (departedAt - arrivedAt) at render time but tech can override.
    // For build-mode WOs the daily-log sessions[] is the source of
    // truth for hours; this field stays null on build WOs.
    labourHours: null,
    // Brief 2 — build-mode parent project pointer. Required for
    // type === "build", null otherwise. The project is the source of
    // truth for the master task list + billing mode + labour rate;
    // this WO is one day's slice of execution.
    parentProjectId: null,
    // Brief 2 — build-mode daily log. Populated only when type === "build".
    // Stays null for spring/fall/service WOs so the schema doesn't grow
    // on non-build records. The shape mirrors the brief's §3.1A spec.
    //
    //   workDate           — ISO date (YYYY-MM-DD) this WO represents.
    //                        Defaults to createdAt's date but admin can
    //                        edit (covers backdated entries).
    //   sessions           — [{ id, inAt, outAt, labourersOnSite,
    //                          labourerNote, startedBy }]
    //                        outAt: null = active; one active session
    //                        at most per WO (server enforces).
    //   tasksCompletedToday — [{ taskId, completedAt, photoIds[] }]
    //                        References project.tasks[].id. Marking a
    //                        task done here ALSO flips project.tasks.
    //   materialsConsumed  — [{ partSku, qty, addedAt, note }]
    //                        SKUs from parts.json. The T&M billing
    //                        rollup sums these across all build WOs.
    //   nextDayMaterials   — [{ partSku, qty, addedAt, note }]
    //                        Pack list for tomorrow. Editable.
    //   nextDayTasks       — [string] plain text task starters for
    //                        tomorrow. Seeds the next day's WO notes.
    //   dailyNotes         — string, voice-input-enabled in tech mode.
    dailyLog: null,
    // Append-only audit trail per spec §10 r4 ("All status changes
    // logged forever") and §4.3.3 r5 (signed-WO contract). Mirrors
    // invoices.history[] / quotes.history[] in shape so the rendering
    // and helper code stays interchangeable across entities. Each entry:
    //   { ts, action, by, note, before?, after? }
    // - ts:     ISO timestamp
    // - action: short slug, e.g. "status_change", "signature_capture",
    //           "photo_upload", "cascade_fire", "line_item_add"
    // - by:     "admin" | "tech" | "system" | "customer"
    // - note:   free-text summary
    // - before/after: optional state snapshots — set on status changes,
    //           empty for events where they don't make sense.
    // Append-only; never edited or removed in normal operation.
    history: [],
    // Bulk-operations soft state. `deletedAt` = draft WO sent to /admin/trash
    // (30-day retention before purge). `archivedAt` = completed WO archived
    // out of the active list (kept indefinitely — never auto-purged). Per
    // brief: only drafts can be soft-deleted; only completed WOs can be
    // archived. Both default null on new records.
    deletedAt: null,
    archivedAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
}

// Backfill missing keys on records read from disk. Lets the schema
// grow without an explicit migration step.
function hydrate(w) {
  const base = blankWorkOrder();
  const hydrated = {
    ...base,
    ...w,
    zones: Array.isArray(w?.zones) ? w.zones.map(hydrateZone) : [],
    additionalRepairs: Array.isArray(w?.additionalRepairs) ? w.additionalRepairs : [],
    lineItems: Array.isArray(w?.lineItems) ? w.lineItems : [],
    photos: Array.isArray(w?.photos) ? w.photos : [],
    intakeGuarantee: { ...base.intakeGuarantee, ...(w?.intakeGuarantee || {}) },
    serviceChecklist: { ...(w?.serviceChecklist || {}) },
    signature: { ...base.signature, ...(w?.signature || {}) },
    // Bypass record. `null` is the canonical unset value; the capture
    // verb writes the full object. We never partial-merge — once set,
    // the record is frozen by SCOPE_PROTECTED_FIELDS.
    signatureBypass: (w?.signatureBypass && typeof w.signatureBypass === "object")
      ? { ...w.signatureBypass }
      : null,
    // Service-call fee waiver — null is the canonical unset value; a valid
    // waiver is a frozen object written at create time. Never partial-merge.
    serviceFeeWaiver: (w?.serviceFeeWaiver && typeof w.serviceFeeWaiver === "object" && w.serviceFeeWaiver.waived === true)
      ? { ...w.serviceFeeWaiver }
      : null,
    // Warranty-claim provenance. hydrate() rebuilds this record key by
    // key and readAll() writes the hydrated result back, so a key missing
    // from here is not merely hidden — it is erased on the next read.
    warrantyClaim: (w?.warrantyClaim && typeof w.warrantyClaim === "object" && w.warrantyClaim.claimId)
      ? {
          claimId: String(w.warrantyClaim.claimId),
          claimedInvoiceId: w.warrantyClaim.claimedInvoiceId ? String(w.warrantyClaim.claimedInvoiceId) : null,
          claimedWorkOrderId: w.warrantyClaim.claimedWorkOrderId ? String(w.warrantyClaim.claimedWorkOrderId) : null,
          summary: String(w.warrantyClaim.summary || "").slice(0, 2000),
          approvedBy: String(w.warrantyClaim.approvedBy || ""),
          approvedAt: w.warrantyClaim.approvedAt || null,
          // Set the moment the waiver is lifted on site. Once present the
          // visit is a chargeable service call that BEGAN as a warranty
          // visit — the pair is the audit trail, so `converted` is added
          // alongside the original approval, never replacing it.
          converted: (w.warrantyClaim.converted && typeof w.warrantyClaim.converted === "object")
            ? {
                at: w.warrantyClaim.converted.at || null,
                by: String(w.warrantyClaim.converted.by || ""),
                reason: String(w.warrantyClaim.converted.reason || "").slice(0, 2000)
              }
            : null
        }
      : null,
    onSiteQuote: {
      ...base.onSiteQuote,
      ...(w?.onSiteQuote || {}),
      builderLineItems: Array.isArray(w?.onSiteQuote?.builderLineItems)
        ? w.onSiteQuote.builderLineItems
        : []
    },
    locked: w?.locked === true,
    history: Array.isArray(w?.history) ? w.history : [],
    deletedAt: typeof w?.deletedAt === "string" ? w.deletedAt : null,
    archivedAt: typeof w?.archivedAt === "string" ? w.archivedAt : null,
    customerNotes: typeof w?.customerNotes === "string" ? w.customerNotes : "",
    reportSnapshots: Array.isArray(w?.reportSnapshots) ? w.reportSnapshots : [],
    completionReportSnapshotAt: typeof w?.completionReportSnapshotAt === "string"
      ? w.completionReportSnapshotAt
      : null,
    completedAt: typeof w?.completedAt === "string" ? w.completedAt : null,
    // Brief 2 — build-mode pointers. parentProjectId stays null for
    // non-build WOs; dailyLog stays null until the WO is build-mode.
    parentProjectId: typeof w?.parentProjectId === "string" ? w.parentProjectId : null,
    dailyLog: (() => {
      if (w?.type !== "build") return null;
      const dl = w?.dailyLog && typeof w.dailyLog === "object" ? w.dailyLog : {};
      const base = blankDailyLog({ workDate: dl.workDate });
      return {
        ...base,
        ...dl,
        sessions: Array.isArray(dl.sessions) ? dl.sessions : [],
        tasksCompletedToday: Array.isArray(dl.tasksCompletedToday) ? dl.tasksCompletedToday : [],
        materialsConsumed: Array.isArray(dl.materialsConsumed) ? dl.materialsConsumed : [],
        nextDayMaterials: Array.isArray(dl.nextDayMaterials) ? dl.nextDayMaterials : [],
        nextDayTasks: Array.isArray(dl.nextDayTasks) ? dl.nextDayTasks : [],
        dailyNotes: typeof dl.dailyNotes === "string" ? dl.dailyNotes : ""
      };
    })()
  };
  // Cascade-merge follow-up — auto-confirm the materials gate for the
  // cases where there's nothing to confirm: fall_closing (find-only,
  // no parts installed) AND any WO with empty materialsPacked + empty
  // customParts. Read-only — doesn't persist; the clear-on-mutate
  // rule in update() handles the case where parts are later added.
  if (!hydrated.materialsConfirmedAt) {
    const noPacked = !hydrated.materialsPacked || Object.keys(hydrated.materialsPacked).length === 0;
    const noCustom = !Array.isArray(hydrated.customParts) || hydrated.customParts.length === 0;
    if (hydrated.type === "fall_closing" || (noPacked && noCustom)) {
      hydrated.materialsConfirmedAt = hydrated.createdAt || new Date().toISOString();
    }
  }
  return hydrated;
}

// Hard-rule guard: spec §10 rule 8 — fall closings never auto-quote
// on-site. Find_only mode. Tech can defer issues for spring follow-up
// but never builds an on-site Quote inside a fall closing visit.
// Both client and server consult this helper.
function canBuildOnSiteQuote(wo) {
  return !!wo && wo.type !== "fall_closing";
}

// Scope-protected fields — once `wo.locked === true` (the customer
// signed off), these are frozen. Spec §10 r11 + §4.3.3 r5: the signed
// WO is the contract. Anything that changes the customer's contractual
// understanding (line items, prices, customer/property identity, the
// signature record itself) gets refused at the dispatcher with a 409.
//
// Non-protected fields (status forward-progression, photos, materials
// packed, paidOnSite, departure timestamp, internal tech notes, audit
// history) keep flowing — the WO remains a live operational document
// after sign-off; only the *scope* is frozen.
//
// Path entries support nested form using dot notation. The dispatcher's
// scope check matches by exact path OR by prefix (so "onSiteQuote" also
// guards "onSiteQuote.builderLineItems[3].qty").
const SCOPE_PROTECTED_FIELDS = [
  "lineItems",
  "additionalRepairs",
  "onSiteQuote",
  "signature",
  "signatureBypass",
  "customerId",
  "customerName",
  "customerEmail",
  "customerPhone",
  "address",
  "propertyId",
  "leadId",
  "intakeGuarantee",
  "aiBonusMatched",
  "type",
  // Fee waiver changes the customer's contractual total — freeze it once
  // the signed WO is the contract.
  "serviceFeeWaiver",
  // Warranty provenance is the customer's contractual context for the
  // visit ("no charge, we are honouring the April repair"). It freezes
  // with the waiver it explains — converting a signed warranty visit to
  // a chargeable one has to go through unlock, like any other post-
  // signature scope change.
  "warrantyClaim",
  // Customer-facing visit narrative — locks alongside scope so the
  // service-report snapshot at completion captures the same notes the
  // customer attested to at signature (Service Report brief, 2026-05-19).
  // techNotes remains UNlocked (admin-only, can be amended).
  "customerNotes"
];

// Is this WO's scope frozen? `wo.locked` is the single authority.
//
// Every lock path sets it: drawn signature (server.js sets payload.locked
// = true at fresh-sign) and admin signature bypass (captureSignatureBypass
// sets next.locked = true). Guards used to read
// `wo.locked || wo.signature?.signed` — belt-and-suspenders that was
// always redundant, because a signed WO is a locked WO.
//
// It stopped being redundant when admin unlock landed (2026-08-06).
// Unlock clears `locked` and PRESERVES the signature / signatureBypass
// record as history (Patrick's ruling: flip the flag, keep the record).
// Under the old OR-form a drawn-signature WO would stay frozen after an
// unlock — the button would appear to work and change nothing. Reading
// `locked` alone is what makes unlock mean something on both lock paths.
//
// Behaviour is identical for every WO that hasn't been explicitly
// unlocked, which is every WO in the store before this shipped.
function isScopeFrozen(wo) {
  return wo?.locked === true;
}

// Returns the protected field path that a payload would touch on a
// locked WO, or null if no protected fields are touched. Caller decides
// whether to 409 (most routes) or silently drop (legacy signature
// re-write). The `signature` exception: a fresh-signature payload on an
// unsigned WO is still allowed — only blocks once `locked` is true.
function findProtectedFieldTouched(payload) {
  if (!payload || typeof payload !== "object") return null;
  for (const key of Object.keys(payload)) {
    if (SCOPE_PROTECTED_FIELDS.includes(key)) return key;
  }
  return null;
}

// Derives whether the on-site quote builder carries line items beyond the
// expected baseline for the WO type. Used by the signature-bypass capture
// path to decide whether to surface the scope-additions warning state —
// bypassing without a drawn signature on a visit with added scope is the
// riskiest version of the flow (the customer hasn't physically signed off
// on additions), so the UI forces an explicit second acknowledgement.
//
// Unified rule across WO types: a builder line is a "scope addition"
// unless it's flagged source.baseline === true (the seasonal-fee seed
// for spring/fall, or the install baseline for builds) OR
// source.aiBonusCredit === true (the AI Correct Diagnosis Bonus credit).
// The brief's per-type rules collapse to this single rule because fall
// closings ARE seeded with a baseline seasonal-fee line at create time
// (and via the self-healing path in GET /api/work-orders/:id), so the
// "any line at all = addition" reading would incorrectly fire on every
// fall closing. Emergency overrides on fall closings always add new
// non-baseline lines, so they still get caught here.
//
// Returns { hasAdditions, additionCount, additionTotal } so the route can
// surface the count + dollar amount in the warning copy without recomputing.
function summarizeScopeAdditions(wo) {
  const lines = Array.isArray(wo?.onSiteQuote?.builderLineItems)
    ? wo.onSiteQuote.builderLineItems
    : [];
  const isBaseline = (l) => l && l.source && (l.source.baseline === true);
  const isAiCredit = (l) => l && l.source && (l.source.aiBonusCredit === true);
  const additions = lines.filter((l) => {
    if (!l) return false;
    return !isBaseline(l) && !isAiCredit(l);
  });
  let additionTotal = 0;
  for (const l of additions) {
    const qty = Number(l.qty) || 0;
    const price = Number(l.overridePrice !== null && l.overridePrice !== undefined
      ? l.overridePrice
      : l.originalPrice) || 0;
    additionTotal += qty * price;
  }
  return {
    hasAdditions: additions.length > 0,
    additionCount: additions.length,
    additionTotal: Math.round(additionTotal * 100) / 100
  };
}

// Record an on-site quote as accepted from a returned SIGNED COPY
// (offline-acceptance brief, Aug 2026). The on-site-quote sibling of the
// proposal PDF-return path: flips onSiteQuote.status → "accepted" and writes
// durable acceptanceEvidence WITHOUT locking or completing the WO — the
// completion sign-off stays a separate event (Faramarz signs "work done"
// later). Direct read/write (not update()) so the scope-protected onSiteQuote
// field can be set. Idempotent — a quote already accepted is returned as-is.
// The signed copy is uploaded separately via the WO photos endpoint; its `n`
// rides in as evidencePhotoN.
async function recordOfflineQuoteAcceptance(woId, { acceptedByName, acceptedAt, note, evidencePhotoN, recordedBy } = {}, { ip, userAgent } = {}) {
  const records = await readAll();
  const idx = records.findIndex((w) => w.id === woId);
  if (idx === -1) {
    const err = new Error("Work order not found.");
    err.code = "wo_not_found";
    throw err;
  }
  const current = records[idx];
  if (current.signature && current.signature.signed === true) {
    const err = new Error("Work order is already signed.");
    err.code = "already_signed";
    throw err;
  }
  if (current.onSiteQuote && current.onSiteQuote.status === "accepted") {
    return current; // idempotent — already accepted
  }
  const builderLines = Array.isArray(current.onSiteQuote?.builderLineItems)
    ? current.onSiteQuote.builderLineItems
    : [];
  if (!builderLines.length) {
    const err = new Error("No on-site quote to accept — build the quote first.");
    err.code = "no_quote";
    throw err;
  }

  // Freeze the accepted scope/price into an immutable snapshot (same shape
  // the bypass path writes). Acceptance does NOT lock the builder — that
  // matches the remote-approval path; on-site changes tomorrow are scope
  // additions billed on the completion sign-off.
  const snapshotLines = builderLines.map((l) => JSON.parse(JSON.stringify(l)));
  let subtotal = 0;
  for (const l of snapshotLines) {
    const qty = Number(l.qty) || 0;
    const price = Number(l.overridePrice != null ? l.overridePrice : l.originalPrice) || 0;
    subtotal += qty * price;
  }
  subtotal = Math.round(subtotal * 100) / 100;
  const hst = Math.round(subtotal * 0.13 * 100) / 100;
  const total = Math.round((subtotal + hst) * 100) / 100;

  const now = new Date().toISOString();
  const acceptedIso = (typeof acceptedAt === "string" && acceptedAt.trim()) ? acceptedAt.trim() : now;
  const nPhoto = Number(evidencePhotoN);
  const next = { ...current };
  next.onSiteQuote = {
    ...current.onSiteQuote,
    status: "accepted",
    acceptanceEvidence: {
      method: "offline_signed_copy",
      acceptedByName: String(acceptedByName || "").slice(0, 120),
      acceptedAt: acceptedIso,
      recordedBy: recordedBy || "admin",
      note: String(note || "").slice(0, 2000),
      evidencePhotoN: Number.isFinite(nPhoto) ? nPhoto : null,
      ip: ip || "",
      userAgent: userAgent || "",
      ts: now
    },
    acceptedScopeSnapshot: { builderLineItems: snapshotLines, subtotal, hst, total }
  };
  next.updatedAt = now;
  if (!Array.isArray(next.history)) next.history = [];
  next.history.push({
    ts: now,
    action: "on_site_quote_accepted_offline",
    by: recordedBy || "admin",
    note: `On-site quote accepted offline (signed copy) — $${total.toFixed(2)}${acceptedByName ? ` by ${acceptedByName}` : ""}${note ? ` — ${note}` : ""}`
  });
  records[idx] = next;
  await writeAll(records);
  return next;
}

// Reference the signed-copy attachment on the WO's on-site-quote acceptance
// evidence (offline-acceptance brief, follow-up). The file itself lives as a
// quote attachment (quote-attachments/<quoteId>/<attId>); this just records
// the pointer so the WO page can render an "Open signed copy" link. Merges
// into existing acceptanceEvidence when acceptance was already recorded, and
// stands alone when it wasn't (attach-first flows). Replacing an earlier
// signed copy is allowed — the newest pointer wins, history records both.
async function attachSignedCopyRef(woId, { quoteId, attachmentId, filename, recordedBy } = {}) {
  const records = await readAll();
  const idx = records.findIndex((w) => w.id === woId);
  if (idx === -1) {
    const err = new Error("Work order not found.");
    err.code = "wo_not_found";
    throw err;
  }
  const current = records[idx];
  const now = new Date().toISOString();
  const next = { ...current };
  const existingEvidence = (current.onSiteQuote && typeof current.onSiteQuote.acceptanceEvidence === "object")
    ? current.onSiteQuote.acceptanceEvidence
    : null;
  next.onSiteQuote = {
    ...current.onSiteQuote,
    acceptanceEvidence: {
      ...(existingEvidence || { method: "offline_signed_copy", recordedBy: recordedBy || "admin" }),
      signedCopy: {
        quoteId: quoteId || null,
        attachmentId: attachmentId || null,
        filename: String(filename || "").slice(0, 200),
        attachedAt: now,
        attachedBy: recordedBy || "admin"
      }
    }
  };
  next.updatedAt = now;
  if (!Array.isArray(next.history)) next.history = [];
  next.history.push({
    ts: now,
    action: "signed_copy_attached",
    by: recordedBy || "admin",
    note: `Signed acceptance copy attached${filename ? ` — ${filename}` : ""}`
  });
  records[idx] = next;
  await writeAll(records);
  return next;
}

// Capture a signature bypass — absolute admin override (Patrick 2026-05-23).
// Sets wo.locked = true and writes signatureBypass with server-stamped
// audit metadata. Only refuses for idempotency (already_signed,
// already_bypassed) or non-existence (wo_not_found). State-of-WO and
// scope-additions gating were removed: admin override is final, and a
// chain of "fix one gate, hit the next" pop-ups in the field is exactly
// what this path is meant to escape.
//
// Legacy export — kept so consumers requiring the slug list don't break.
// The current path accepts any non-empty reason string (and defaults to
// "admin_override" when missing/empty).
const BYPASS_REASONS = new Set(["customer_not_home", "trusted_customer_verbal", "other", "admin_override"]);

async function captureSignatureBypass(woId, { reason, note, bypassedBy }, { ip, userAgent } = {}) {
  const records = await readAll();
  const idx = records.findIndex((w) => w.id === woId);
  if (idx === -1) {
    const err = new Error("Work order not found.");
    err.code = "wo_not_found";
    throw err;
  }
  const current = records[idx];

  if (current.signature && current.signature.signed === true) {
    const err = new Error("Work order is already signed — bypass not available.");
    err.code = "already_signed";
    throw err;
  }
  if (current.signatureBypass) {
    const err = new Error("Signature bypass already recorded for this work order.");
    err.code = "already_bypassed";
    throw err;
  }

  const safeReason = (typeof reason === "string" && reason.trim()) ? reason.trim() : "admin_override";
  const trimmedNote = String(note || "").trim();
  const scopeSummary = summarizeScopeAdditions(current);

  // Deep-copy the builder state at bypass time into an immutable
  // acceptedScopeSnapshot. signatureBypass is in SCOPE_PROTECTED_FIELDS,
  // and onSiteQuote is too, so post-bypass mutations are blocked by
  // wo.locked anyway. The snapshot is belt-and-suspenders: even if
  // immutability is violated, this record IS the scope-as-accepted.
  const builderLines = Array.isArray(current.onSiteQuote?.builderLineItems)
    ? current.onSiteQuote.builderLineItems
    : [];
  const snapshotLines = builderLines.map((l) => JSON.parse(JSON.stringify(l)));
  let subtotal = 0;
  for (const l of snapshotLines) {
    const qty = Number(l.qty) || 0;
    const price = Number(l.overridePrice !== null && l.overridePrice !== undefined
      ? l.overridePrice
      : l.originalPrice) || 0;
    subtotal += qty * price;
  }
  subtotal = Math.round(subtotal * 100) / 100;
  const hst = Math.round(subtotal * 0.13 * 100) / 100;
  const total = Math.round((subtotal + hst) * 100) / 100;

  // Customer printed name pulled from the WO snapshot. The snapshot was
  // copied from the customer/property/lead record at WO create time
  // (see create()); using it here keeps the bypass record honest about
  // who the customer was when the visit happened, regardless of any
  // downstream customer-record renames.
  const customerNamePrinted = (current.customerName || "").trim();

  const now = new Date().toISOString();
  const next = { ...current };
  next.signatureBypass = {
    reason: safeReason,
    note: trimmedNote.slice(0, 2000),
    customerNamePrinted,
    bypassedBy: bypassedBy || "admin",
    ts: now,
    ip: ip || "",
    userAgent: userAgent || "",
    acceptedScopeSnapshot: {
      builderLineItems: snapshotLines,
      subtotal,
      hst,
      total
    },
    coversQuoteAcceptance: scopeSummary.hasAdditions
  };
  next.locked = true;
  next.updatedAt = now;

  if (!Array.isArray(next.history)) next.history = [];
  next.history.push({
    ts: now,
    action: "signature_bypassed",
    by: bypassedBy || "admin",
    note: `Reason: ${safeReason}${scopeSummary.hasAdditions ? ` — incl. on-site quote acceptance ($${total.toFixed(2)})` : ""}${trimmedNote ? ` — ${trimmedNote}` : ""}`,
    before: { signatureBypass: null, locked: !!current.locked },
    after: {
      signatureBypass: {
        reason: safeReason,
        note: trimmedNote,
        customerNamePrinted,
        bypassedBy: bypassedBy || "admin",
        ts: now,
        coversQuoteAcceptance: scopeSummary.hasAdditions,
        total
      },
      locked: true
    }
  });

  records[idx] = next;
  await writeAll(records);
  return next;
}

// ---- Admin unlock / re-lock (2026-08-06) ------------------------------
//
// Why this exists. WO-BF86TWRW completed without its $95 service call
// charged, and it had been bypass-locked, so the scope was frozen with
// the fee missing. Before this there was no way back: no unlock route, no
// admin control, and the only workaround (PATCH locked:false) worked on
// bypassed WOs but silently did nothing on signed ones. Patrick's call —
// admin needs a real way in, even on a locked WO.
//
// What it does and doesn't do:
//   - Flips `locked` and nothing else. The signature / signatureBypass
//     record is PRESERVED verbatim (Patrick's ruling 2026-08-06) — the
//     visit really was accepted, and erasing that record would lose the
//     fact. `locked` carries the frozen-ness; the signature carries the
//     history. isScopeFrozen() reads the former.
//   - Never touches the invoice. A completed WO's invoice is a separate
//     record with its own line items, copied at cascade time. Editing WO
//     scope after unlock does NOT re-bill the customer — that's a
//     deliberate boundary (HANDOFF_STRIPE_PAYMENTS §6: nothing here goes
//     near payments). Re-cutting a bill stays a separate, explicit act.
//   - Requires a reason. This is an override of a customer-accepted
//     contract; an unexplained one is worse than none. The reason lands
//     in WO history where the audit trail already lives.
//
// Admin-only is enforced at the route (requireAdmin + a needsAuth
// "admin" entry), not here — this layer is reachable by CLI scripts too.
const UNLOCK_MIN_REASON_LEN = 10;

async function unlockWorkOrder(woId, { reason, unlockedBy } = {}, { ip, userAgent } = {}) {
  const records = await readAll();
  const idx = records.findIndex((w) => w.id === woId);
  if (idx === -1) {
    const err = new Error("Work order not found.");
    err.code = "wo_not_found";
    throw err;
  }
  const current = records[idx];

  if (current.locked !== true) {
    const err = new Error(`Work order ${woId} is not locked.`);
    err.code = "wo_not_locked";
    throw err;
  }

  const trimmedReason = String(reason || "").trim();
  if (trimmedReason.length < UNLOCK_MIN_REASON_LEN) {
    const err = new Error(`Give a reason for unlocking (at least ${UNLOCK_MIN_REASON_LEN} characters) — it goes in the work order's history.`);
    err.code = "reason_required";
    throw err;
  }

  const now = new Date().toISOString();
  const next = { ...current };
  next.locked = false;
  next.updatedAt = now;

  // How it was locked, recorded so the history entry is readable years
  // later without cross-referencing the signature blob.
  const lockSource = current.signature?.signed === true
    ? "customer signature"
    : current.signatureBypass
      ? `signature bypass (${current.signatureBypass.reason || "—"})`
      : "locked with no signature record";

  if (!Array.isArray(next.history)) next.history = [];
  next.history.push({
    ts: now,
    action: "wo_unlocked",
    by: unlockedBy || "admin",
    note: `Unlocked for editing — ${trimmedReason} (was locked by ${lockSource})`,
    before: { locked: true },
    after: {
      locked: false,
      reason: trimmedReason.slice(0, 2000),
      lockSource,
      // The signature record is untouched — say so explicitly so a
      // reader doesn't have to infer it from an absence.
      signatureRetained: current.signature?.signed === true || !!current.signatureBypass,
      ip: ip || "",
      userAgent: userAgent || ""
    }
  });

  records[idx] = next;
  await writeAll(records);
  return next;
}

// Restore the lock after editing. Deliberately NOT a fresh acceptance —
// it re-freezes scope against the signature/bypass record already on
// file. A WO with no acceptance record on it was never locked by a
// customer-facing event, so there's nothing to restore and this refuses;
// use the signature or bypass path instead.
async function relockWorkOrder(woId, { relockedBy } = {}, { ip, userAgent } = {}) {
  const records = await readAll();
  const idx = records.findIndex((w) => w.id === woId);
  if (idx === -1) {
    const err = new Error("Work order not found.");
    err.code = "wo_not_found";
    throw err;
  }
  const current = records[idx];

  if (current.locked === true) {
    const err = new Error(`Work order ${woId} is already locked.`);
    err.code = "wo_already_locked";
    throw err;
  }

  const hasAcceptance = current.signature?.signed === true || !!current.signatureBypass;
  if (!hasAcceptance) {
    const err = new Error("This work order has no signature or bypass on file — capture one instead of re-locking.");
    err.code = "no_acceptance_record";
    throw err;
  }

  const now = new Date().toISOString();
  const next = { ...current };
  next.locked = true;
  next.updatedAt = now;

  if (!Array.isArray(next.history)) next.history = [];
  next.history.push({
    ts: now,
    action: "wo_relocked",
    by: relockedBy || "admin",
    note: "Re-locked after admin edit — scope frozen again against the acceptance already on file",
    before: { locked: false },
    after: { locked: true, ip: ip || "", userAgent: userAgent || "" }
  });

  records[idx] = next;
  await writeAll(records);
  return next;
}

// Append a report snapshot entry to a WO. Atomic read-modify-write —
// the snapshotter (server/lib/wo-report-snapshot.js) calls this after
// the PDF lands on disk. Also writes a paired `report_snapshot_created`
// history entry so the audit trail records the event in one step.
// Returns the updated WO or null if not found.
// Patch fields onto an existing snapshot record in place (no history
// entry — used by the lazy customer-render migration to backfill
// pathCustomer/schemaVersion). Immutable snapshot semantics still hold
// for the frozen PDF bytes; this only records where the render lives.
async function patchReportSnapshot(id, snapshotId, patch = {}) {
  if (!snapshotId) throw new Error("patchReportSnapshot requires a snapshotId.");
  const records = await readAll();
  const idx = records.findIndex((w) => w.id === id);
  if (idx === -1) return null;
  const next = { ...records[idx] };
  if (!Array.isArray(next.reportSnapshots)) return null;
  const sIdx = next.reportSnapshots.findIndex((s) => s.snapshotId === snapshotId);
  if (sIdx === -1) return null;
  next.reportSnapshots = next.reportSnapshots.map((s, i) =>
    i === sIdx ? { ...s, ...patch } : s);
  next.updatedAt = new Date().toISOString();
  records[idx] = next;
  await writeAll(records);
  return next.reportSnapshots[sIdx];
}

async function appendReportSnapshot(id, snapshot) {
  if (!snapshot || typeof snapshot !== "object" || !snapshot.snapshotId) {
    throw new Error("appendReportSnapshot requires a snapshot record with snapshotId.");
  }
  const records = await readAll();
  const idx = records.findIndex((w) => w.id === id);
  if (idx === -1) return null;
  const now = new Date().toISOString();
  const next = { ...records[idx] };
  if (!Array.isArray(next.reportSnapshots)) next.reportSnapshots = [];
  next.reportSnapshots = [...next.reportSnapshots, snapshot];
  if (!Array.isArray(next.history)) next.history = [];
  const triggerBit = snapshot.triggerType
    ? snapshot.triggerType.replace(/_/g, " ")
    : "snapshot";
  const noteParts = [
    `${snapshot.mode === "service_report" ? "Service Report" : "Inspection Report"} (${triggerBit})`
  ];
  if (snapshot.quoteId) noteParts.push(`for ${snapshot.quoteId}`);
  if (snapshot.filename) noteParts.push(`→ ${snapshot.filename}`);
  next.history.push({
    ts: now,
    action: "report_snapshot_created",
    by: snapshot.by || "system",
    note: noteParts.join(" ")
  });
  next.updatedAt = now;
  records[idx] = next;
  await writeAll(records);
  return next;
}

// Append a history entry to a WO without going through `update()` (which
// only logs status transitions). Mirrors invoices.appendHistory(). Used
// by every WO-mutating dispatcher endpoint to log a one-line audit
// breadcrumb. Returns the updated WO record, or null if not found.
async function appendHistory(id, entry) {
  const records = await readAll();
  const idx = records.findIndex((w) => w.id === id);
  if (idx === -1) return null;
  const now = new Date().toISOString();
  const next = { ...records[idx] };
  if (!Array.isArray(next.history)) next.history = [];
  const stored = {
    ts: entry?.ts || now,
    action: entry?.action || "note",
    by: entry?.by || "admin",
    note: entry?.note || ""
  };
  // Optional before/after snapshots — only stored when the caller
  // provides them (status transitions, signature capture, etc).
  if (entry?.before !== undefined) stored.before = entry.before;
  if (entry?.after !== undefined) stored.after = entry.after;
  next.history.push(stored);
  next.updatedAt = now;
  records[idx] = next;
  await writeAll(records);
  return next;
}

// Backfill the per-zone checks{} and issues[] fields onto records that
// pre-date the Tier 2 schema. Defensive merge — never overwrites an
// existing `checks` object or `issues` array.
// Allowed values for the `kind` discriminator. Drives the badge label in
// the UI ("Zone N" vs "VB" / "CTL" / "ISS") and lets the picker remember
// what kind of source the row was populated from across reloads.
const ZONE_KINDS = ["zone", "valveBox", "controller", "issue", "custom"];

function hydrateZone(z) {
  const baseChecks = {};
  for (const key of ZONE_CHECK_KEYS) baseChecks[key] = false;
  const rawKind = typeof z?.kind === "string" ? z.kind : "zone";
  return {
    number: z?.number || 0,
    // Discriminator for the picker — keeps the UI honest about whether
    // the row is sourced from a property zone, a valve box, the controller,
    // an open issue, or a free-text custom label. Defaults to "zone" so
    // legacy records (no kind field) render unchanged.
    kind: ZONE_KINDS.includes(rawKind) ? rawKind : "zone",
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
    // subtype: cascading specific item (e.g. "pgp_4", "hpc_8"). Free-form
    // string — the rendering layer maps it to a human label, the rollup
    // layer uses it for controller pricing tier selection. Empty string
    // for legacy issues / types without subtype options.
    subtype: typeof issue?.subtype === "string" ? issue.subtype : "",
    qty: Number.isFinite(Number(issue?.qty)) && Number(issue?.qty) > 0 ? Number(issue.qty) : 1,
    notes: issue?.notes || ""
  };
}

// Copy a property's zone list into the WO scaffold so the tech sees
// every zone from the moment they open it. We snapshot the values
// (location/sprinklerTypes/coverage) rather than referencing the
// property — if Patrick later edits the property profile, the WO
// keeps showing what was true at the time of the visit.
// The zone list a property's DECLARED count implies, when nobody has
// documented its zones yet.
//
// The count and the list were two different questions and only pricing
// knew about both. Pricing reads documented zones first and falls back to
// `system.zoneCount` — the "customer told us eight" number — so a
// first-time property was PRICED for eight zones while its work order
// scaffolded from an empty list and fell through to the single "Zone 1"
// placeholder below. The tech arrived at an eight-zone lawn holding a
// one-zone work order.
//
// Zones land `pendingReview: true` — the same flag applySystemUpdates()
// puts on zones discovered in the field — because a number typed into a
// booking form is a claim, not a survey. The flag is what lets a customer
// still correct their own count from the appointment page, and what tells
// Patrick these have never been walked. Naming a zone clears it.
//
// Returns [] when the property already has documented zones (they win) or
// has declared nothing. Exported so the route that CREATES a work order
// can write the same list to the property record itself — this module
// deliberately depends on nothing but node built-ins, so it cannot write
// to properties, and the tests that sandbox it rely on that.
function declaredZoneList(property) {
  const documented = Array.isArray(property?.system?.zones) ? property.system.zones : [];
  if (documented.length) return [];
  const declared = Math.floor(Number(property?.system?.zoneCount) || 0);
  if (!(declared > 0)) return [];
  const zones = [];
  for (let n = 1; n <= declared; n++) {
    zones.push({ number: n, location: "", label: "", notes: "", pendingReview: true });
  }
  return zones;
}

function scaffoldZonesFromProperty(property) {
  const documented = Array.isArray(property?.system?.zones) ? property.system.zones : [];
  const zones = documented.length ? documented : declaredZoneList(property);
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

// list() hides soft-deleted (draft trash) and archived (completed) WOs by
// default. Pass { includeDeleted } / { includeArchived } to surface them
// — the /admin/trash view does that. Existing callers pass no args and
// keep seeing only active WOs.
async function list({ includeDeleted = false, includeArchived = false } = {}) {
  const records = await readAll();
  return records.filter((w) => {
    if (!includeDeleted && w.deletedAt) return false;
    if (!includeArchived && w.archivedAt) return false;
    return true;
  });
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
// linked Quote), the AI-Correct-Diagnosis Bonus eligibility flag from the
// quote propagates onto the WO so the tech sees the bonus-pending banner
// in field mode (1 hr of repair labour pending — temporarily disabled
// until the tech confirms the on-site diagnosis matches the AI scope).
async function create({ type, lead, property, customId, quote = null, project = null, workDate = null, carryFromWoId = null, serviceFeeWaiver = null, warrantyClaim = null }) {
  if (!TEMPLATES[type]) throw new Error(`Unknown work-order type: ${type}`);
  // Build-mode WOs are project-scoped and don't require a lead — the
  // proposal acceptance is the original handshake. Property is still
  // useful for address + zone hints but not required either.
  if (type !== "build" && !lead && !property) {
    throw new Error("Need at least one of lead or property to create a work order.");
  }
  if (type === "build" && !project) {
    throw new Error("Build-mode work orders require a parent project.");
  }

  const records = await readAll();
  const wo = blankWorkOrder();
  if (customId) wo.id = customId;
  wo.type = type;

  // Brief 2 — build-mode wiring. parentProjectId + dailyLog seeded.
  // Customer snapshot pulled from the project (which has it from the
  // accepted proposal) when no lead/property short-circuits it later.
  if (type === "build" && project) {
    wo.parentProjectId = project.id;
    wo.customerId    = wo.customerId    || project.customerId    || null;
    wo.customerName  = wo.customerName  || project.customerName  || "";
    wo.customerEmail = wo.customerEmail || project.customerEmail || "";
    wo.customerPhone = wo.customerPhone || project.customerPhone || "";
    wo.address       = wo.address       || project.address       || "";
    wo.propertyId    = wo.propertyId    || project.propertyId    || null;
    wo.dailyLog      = blankDailyLog({ workDate });

    // Carry-forward from the previous build day's WO (if specified).
    // Materials get copied to nextDayMaterials → materialsConsumed
    // (still editable — not auto-consumed; admin promotes each item
    // as actually installed). Tasks get appended to dailyNotes as a
    // starter list. Both carry-overs are non-destructive — admin can
    // edit or delete before saving.
    if (carryFromWoId) {
      try {
        const prev = records.find((w) => w.id === carryFromWoId);
        if (prev && prev.dailyLog) {
          // Copy tomorrow's planned materials to today's "planned" slot
          // (a separate field would be cleaner but for v1 we mirror them
          // into nextDayMaterials so the UI can render them as "carried
          // over from <prev workDate>" and the admin promotes them).
          if (Array.isArray(prev.dailyLog.nextDayMaterials) && prev.dailyLog.nextDayMaterials.length) {
            wo.dailyLog.materialsConsumed = []; // start empty; admin promotes
            wo.dailyLog._carriedMaterials = prev.dailyLog.nextDayMaterials.map((m) => ({ ...m }));
          }
          if (Array.isArray(prev.dailyLog.nextDayTasks) && prev.dailyLog.nextDayTasks.length) {
            wo.dailyLog.dailyNotes = `Carried over from ${prev.dailyLog.workDate}:\n` +
              prev.dailyLog.nextDayTasks.map((t) => `• ${t}`).join("\n") + "\n\n";
          }
        }
      } catch (err) {
        console.warn("[wo create] carry-forward failed:", err?.message);
      }
    }
  }

  if (property) {
    wo.propertyId = property.id;
    wo.address = property.address || "";
    wo.customerId    = wo.customerId    || property.customerId    || null;
    wo.customerName  = wo.customerName  || property.customerName  || "";
    wo.customerEmail = wo.customerEmail || property.customerEmail || "";
    wo.customerPhone = wo.customerPhone || property.customerPhone || "";
    if (TEMPLATES[type].scaffoldFromProperty) {
      wo.zones = scaffoldZonesFromProperty(property);
    }
  }

  // Always scaffold AT LEAST one zone — without it, the tech can't log
  // any issues (issues are nested under zones). Three cases this catches:
  //   1. service_visit — never scaffolds from property; gets a "General"
  //      zone so the repair-only tech has a place to log work.
  //   2. spring_opening / fall_closing on a NEW customer where the
  //      property zone list is still empty — same problem; tech needs
  //      a place to record what they saw on first arrival.
  //   3. ad-hoc WOs spun up from /admin/handoff with no property link.
  // Tech can rename / add more zones once on-site. The placeholder uses
  // number 1 so the WO numbering stays sane.
  if (!wo.zones.length) {
    const blankChecks = {};
    for (const k of ZONE_CHECK_KEYS) blankChecks[k] = false;
    wo.zones = [{
      number: 1,
      location: type === "service_visit" ? "General service area" : "Zone 1",
      sprinklerTypes: [],
      coverage: [],
      status: "",
      notes: "",
      checks: { ...blankChecks },
      issues: []
    }];
  }

  if (lead) {
    wo.leadId = lead.id;
    wo.customerId    = wo.customerId    || lead.customerId || null;
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

  // AI-Correct-Diagnosis Bonus eligibility — snapshotted from the source
  // Quote at WO creation time. Mutating the Quote later doesn't change the
  // diagnosed scope on a dispatched WO; the tech checks against what was
  // on the WO when they got it. Bonus credits 1 hr of repair labour free
  // ONLY if tech confirms on-site diagnosis matches.
  if (quote && quote.intakeGuarantee && quote.intakeGuarantee.applies === true) {
    wo.intakeGuarantee = {
      applies: true,
      scope: String(quote.intakeGuarantee.scope || "").slice(0, 200),
      sourceQuoteId: quote.id || null
    };
  }

  // Service-call fee waiver — caller (server.js POST handler) passes a
  // pre-validated, normalized waiver object (lib/service-fee-waiver.js) or
  // null. Only meaningful where a service_call is actually charged
  // (service_visit); harmless no-op on seasonal WOs.
  // Warranty provenance, when this WO was raised by approving a claim.
  // Stamped before the waiver below so the two always land together — a
  // warranty WO with no waiver (or a waiver with no provenance) would be
  // a WO nobody on site can explain.
  if (warrantyClaim && typeof warrantyClaim === "object" && warrantyClaim.claimId) {
    wo.warrantyClaim = { ...warrantyClaim, converted: null };
  }
  if (serviceFeeWaiver && typeof serviceFeeWaiver === "object" && serviceFeeWaiver.waived === true) {
    wo.serviceFeeWaiver = { ...serviceFeeWaiver };
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
  const allowedTop = ["type", "status", "scheduledFor", "diagnosis", "techNotes", "customerNotes", "customerName", "customerPhone", "customerEmail", "address", "locked", "arrivedAt", "departedAt", "arrivalLocation", "waterShutoffBy", "backFlush", "followupOfWoId", "paidOnSite", "propertyEditsAppliedAt", "completionReportSnapshotAt", "needsReturnVisit", "labourHours", "parentProjectId", "dailyLog"];
  for (const key of allowedTop) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) next[key] = patch[key];
  }
  // The two fall-closing answers are closed sets, enforced here rather
  // than trusted from the client — the field app is not the only thing
  // that can PATCH a work order, and a typo that reaches disk becomes a
  // wrong line on a customer's report.
  if (Object.prototype.hasOwnProperty.call(patch, "waterShutoffBy")) {
    const v = patch.waterShutoffBy;
    if (!["", "customer", "tech"].includes(v)) {
      throw new Error(`waterShutoffBy must be "customer" or "tech" (got "${v}").`);
    }
    next.waterShutoffBy = v;
  }
  if (Object.prototype.hasOwnProperty.call(patch, "backFlush")) {
    const v = patch.backFlush;
    if (!["", "yes", "no"].includes(v)) {
      throw new Error(`backFlush must be "yes" or "no" (got "${v}").`);
    }
    next.backFlush = v;
  }
  // Coordinates are stored, never trusted: a bad reading should be an
  // absent stamp, not a work order that claims the tech was at latitude
  // 900. Refusing the whole PATCH would be worse — it would block a tech
  // from starting a job because their phone's GPS was confused.
  if (Object.prototype.hasOwnProperty.call(patch, "arrivalLocation")) {
    const loc = patch.arrivalLocation;
    const lat = Number(loc?.lat);
    const lng = Number(loc?.lng);
    const usable = loc && Number.isFinite(lat) && Number.isFinite(lng)
      && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
    next.arrivalLocation = usable
      ? {
          lat,
          lng,
          accuracy: Number.isFinite(Number(loc.accuracy)) ? Number(loc.accuracy) : null,
          capturedAt: typeof loc.capturedAt === "string" ? loc.capturedAt : new Date().toISOString()
        }
      : null;
  }
  // Status forward-only enforcement (spec §4.3.3 rule #3 + #7). The
  // client UI also blocks the click but the server is authoritative.
  // STATUS_ORDER is the canonical sequence; cancelled / no_show terminal.
  if (Object.prototype.hasOwnProperty.call(patch, "status") && patch.status !== current.status) {
    const STATUS_ORDER = ["scheduled", "dispatched", "en_route", "on_site", "in_progress", "awaiting_approval", "completed"];
    const STATUS_TERMINAL = new Set(["completed", "cancelled", "no_show"]);
    if (STATUS_TERMINAL.has(current.status) && current.status !== patch.status) {
      throw new Error(`Cannot change status from terminal state "${current.status}".`);
    }
    const fromIdx = STATUS_ORDER.indexOf(current.status);
    const toIdx = STATUS_ORDER.indexOf(patch.status);
    // Only enforce ordering between known forward statuses; allow
    // transitions to terminal cancelled/no_show from anywhere.
    if (fromIdx !== -1 && toIdx !== -1 && toIdx < fromIdx) {
      throw new Error(`Status only moves forward. Cannot roll back from "${current.status}" to "${patch.status}".`);
    }
  }
  // materialsPacked is wholesale-replaced (since May 2026 stepper rework
  // the client sends the full intended { sku: qty } state, including
  // implicitly-zero SKUs by omission). Shallow-merging would prevent
  // the tech from removing a SKU by stepping it back to 0.
  if (Object.prototype.hasOwnProperty.call(patch, "materialsPacked") && patch.materialsPacked && typeof patch.materialsPacked === "object") {
    const cleaned = {};
    for (const [sku, val] of Object.entries(patch.materialsPacked)) {
      if (!sku || typeof sku !== "string") continue;
      // Coerce legacy bool true → 1; drop false/null/0.
      if (val === true) { cleaned[sku] = 1; continue; }
      const n = Math.max(0, Math.floor(Number(val) || 0));
      if (n > 0) cleaned[sku] = n;
    }
    next.materialsPacked = cleaned;
  }
  // customParts (free-form parts not in parts.json) — wholesale replace.
  // Each entry: { name, size, qty }. Client sends the full array.
  if (Array.isArray(patch.customParts)) {
    next.customParts = patch.customParts
      .filter((p) => p && typeof p === "object")
      .map((p) => ({
        id: typeof p.id === "string" ? p.id : `cp_${Math.random().toString(36).slice(2, 10)}`,
        name: typeof p.name === "string" ? p.name.slice(0, 120) : "",
        size: typeof p.size === "string" ? p.size.slice(0, 16) : "",
        qty: Math.max(0, Math.floor(Number(p.qty) || 0))
      }));
  }
  // Cascade-merge follow-up — materialsConfirmedAt accepts an explicit
  // timestamp (when the tech taps "Confirm materials list"), null/false
  // to re-arm the gate, OR auto-clears when materialsPacked / customParts
  // is mutated in this same PATCH without an accompanying confirmation.
  if (Object.prototype.hasOwnProperty.call(patch, "materialsConfirmedAt")) {
    next.materialsConfirmedAt = patch.materialsConfirmedAt || null;
  } else if (
    Object.prototype.hasOwnProperty.call(patch, "materialsPacked")
    || Array.isArray(patch.customParts)
  ) {
    next.materialsConfirmedAt = null;
  }
  // Follow-up back-references — replace wholesale when sent. Both
  // followupWoIds (parent → children) and followupOfWoId (child → parent,
  // already in allowedTop above) propagate through this layer.
  if (Array.isArray(patch.followupWoIds)) {
    next.followupWoIds = patch.followupWoIds.slice();
  }
  // Report snapshots — append-only, but wholesale replace through the
  // PATCH path so the snapshotter (wo-report-snapshot.js) can record a
  // new entry. The lib enforces append-only-shape; the route exposes no
  // direct PATCH of this field, only the snapshot endpoint.
  if (Array.isArray(patch.reportSnapshots)) next.reportSnapshots = patch.reportSnapshots;
  if (Array.isArray(patch.zones)) next.zones = patch.zones.map(hydrateZone);
  if (Array.isArray(patch.additionalRepairs)) next.additionalRepairs = patch.additionalRepairs;
  if (Array.isArray(patch.lineItems)) next.lineItems = patch.lineItems;
  // Photos — wholesale replace when sent. Both the upload endpoint
  // (/api/work-orders/:id/photos POST) and the delete endpoint
  // (/api/work-orders/:id/photos/:n DELETE) compute the full intended
  // photos array and PATCH it back through this function. Without this
  // branch, `photos` is silently dropped (it's not in allowedTop), the
  // files land on disk + the history audit entry is written, but the
  // WO record's photos[] array never updates — so the GET response
  // returns the old array, state.photos has no new entries, and the
  // photo strip stays empty no matter how many uploads you do. That
  // mismatch (audit says "+1 photo" but no thumbnail appears) is
  // exactly what Patrick was seeing for hours on 2026-05-12 across
  // tech-mode photo-upload versions v17-v23. Fix lives here, not in
  // the upload UI.
  if (Array.isArray(patch.photos)) next.photos = patch.photos;
  // On-site quote field — shallow-merged so partial updates don't clobber
  // siblings. The endpoints handle field-by-field validation; this layer
  // just persists what's allowed through.
  if (patch.onSiteQuote && typeof patch.onSiteQuote === "object") {
    next.onSiteQuote = { ...current.onSiteQuote, ...patch.onSiteQuote };
    if (Array.isArray(patch.onSiteQuote.builderLineItems)) {
      next.onSiteQuote.builderLineItems = patch.onSiteQuote.builderLineItems;
    }
  }
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
  // Service-call fee waiver — set (validated object) or clear (explicit
  // null to un-waive). The route validates shape via
  // lib/service-fee-waiver.js and guards wo.locked before calling here;
  // serviceFeeWaiver is also in SCOPE_PROTECTED_FIELDS so any route using
  // findProtectedFieldTouched refuses changes on a signed WO.
  if (Object.prototype.hasOwnProperty.call(patch, "serviceFeeWaiver")) {
    next.serviceFeeWaiver = (patch.serviceFeeWaiver && typeof patch.serviceFeeWaiver === "object" && patch.serviceFeeWaiver.waived === true)
      ? { ...patch.serviceFeeWaiver }
      : null;
  }
  // Warranty-claim provenance. Written once at create (from the claim
  // approval) and then only by the conversion path, which stamps
  // `converted`. Guarded the same way as the waiver it explains: the
  // route checks wo.locked before calling, and warrantyClaim is in
  // SCOPE_PROTECTED_FIELDS so a signed WO refuses the change.
  if (Object.prototype.hasOwnProperty.call(patch, "warrantyClaim")) {
    next.warrantyClaim = (patch.warrantyClaim && typeof patch.warrantyClaim === "object" && patch.warrantyClaim.claimId)
      ? { ...patch.warrantyClaim }
      : null;
  }
  next.updatedAt = new Date().toISOString();

  // Status transition gets a free history entry — caller (dispatcher)
  // handles other mutation types via appendHistory() directly. Mirrors
  // invoices.js inline-history-on-status-change behaviour.
  if (Object.prototype.hasOwnProperty.call(patch, "status") && patch.status !== current.status) {
    if (!Array.isArray(next.history)) next.history = [];
    next.history.push({
      ts: next.updatedAt,
      action: "status_change",
      by: patch.__by || "admin",
      note: patch.__statusNote || "",
      before: current.status,
      after: patch.status
    });
    // completedAt (JOB-002 Part A) — stamped here, at the same moment as
    // the status_change history entry, so every completion path gets it
    // (tech UI, admin status change, bulk actions). Same ts as the
    // history entry. Preserve-if-set: an already-stamped completedAt is
    // never overwritten, matching the backfill's earliest-entry rule.
    // ("completed" is terminal — the guard above throws on any attempt
    // to leave it — so a re-completion can only follow a manual data
    // edit, and the original date still wins.)
    if (patch.status === "completed" && !current.completedAt) {
      next.completedAt = next.updatedAt;
    }
  }
  // Signature capture (lock flip) — a separate, distinct event from
  // status_change so the audit trail is unambiguous about WHEN the WO
  // became contractually locked.
  if (patch.signature && patch.signature.signed === true && !current.signature?.signed) {
    if (!Array.isArray(next.history)) next.history = [];
    next.history.push({
      ts: next.updatedAt,
      action: "signature_capture",
      by: patch.__by || "tech",
      note: patch.signature.customerName ? `Signed by ${patch.signature.customerName}` : ""
    });
  }

  records[idx] = next;
  await writeAll(records);
  return next;
}

// JOB-007 (CRM-11 cleanup) — complete a stranded WO with its ACTUAL
// completion date instead of now. Server-side callers only (the CLI
// backfill script); deliberately NOT reachable through the HTTP PATCH
// route, so completedAt stays structurally un-patchable from clients
// (JOB-002 Part A's guarantee).
//
// What it does, and why each piece:
//   - scheduledFor / departedAt back-filled with the actual date when
//     null, so the customer-visible report's "Conducted on" line and the
//     history sort read the true visit date.
//   - completedAt = the actual date (preserve-if-set, matching update()).
//   - history entry records BOTH dates — the audit trail never pretends
//     the entry was made back then.
// The completion cascade is NOT run here — the caller runs it (with
// customer notifications and the review-request suppressed) so dry-run
// tooling can inspect the WO between the two steps.
async function completeBackdated(id, { completedAt, by = "admin" } = {}) {
  const ts = Date.parse(completedAt || "");
  if (!Number.isFinite(ts)) throw new Error("completeBackdated needs a valid completedAt date.");
  if (ts > Date.now()) throw new Error("Back-dated completion must not be in the future.");
  const records = await readAll();
  const idx = records.findIndex((w) => w.id === id);
  if (idx === -1) return null;
  const current = hydrate(records[idx]);
  const TERMINAL = new Set(["completed", "cancelled", "no_show"]);
  if (TERMINAL.has(current.status)) {
    throw new Error(`Work order is already terminal ("${current.status}").`);
  }
  // A completion before the WO existed is a data error, not a backfill.
  // One day of slack covers timezone edges on same-day create+visit.
  if (current.createdAt && ts < Date.parse(current.createdAt) - 86400000) {
    throw new Error(`Completion date ${completedAt} is before the work order was created (${current.createdAt.slice(0, 10)}).`);
  }
  const iso = new Date(ts).toISOString();
  const nowIso = new Date().toISOString();
  const next = { ...current };
  if (!next.scheduledFor) next.scheduledFor = iso;
  if (!next.departedAt) next.departedAt = iso;
  next.status = "completed";
  next.completedAt = current.completedAt || iso;
  next.updatedAt = nowIso;
  if (!Array.isArray(next.history)) next.history = [];
  next.history.push({
    ts: nowIso,
    action: "status_change",
    by,
    note: `Back-dated completion: actual completion ${iso.slice(0, 10)}, recorded ${nowIso.slice(0, 10)}.`,
    before: current.status,
    after: "completed"
  });
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

// ---- Soft-delete / soft-archive (bulk operations) -------------------
//
// Per-resource business rule (brief §3.1): only DRAFT work orders can be
// soft-deleted (signed/completed WOs are contractual). Only COMPLETED WOs
// can be archived (the active list shouldn't hide work in progress).
// The helpers below DO NOT enforce the status gate — that runs at the
// bulk-actions dispatcher so the per-record failure is reported per-id.

async function softDelete(id) {
  const records = await readAll();
  const idx = records.findIndex((w) => w.id === id);
  if (idx === -1) throw new Error("Work order not found");
  if (records[idx].deletedAt) throw new Error("Already in Trash");
  records[idx] = { ...records[idx], deletedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await writeAll(records);
  return records[idx];
}

async function restore(id) {
  const records = await readAll();
  const idx = records.findIndex((w) => w.id === id);
  if (idx === -1) throw new Error("Work order not found");
  if (!records[idx].deletedAt && !records[idx].archivedAt) throw new Error("Not in Trash or archive");
  records[idx] = { ...records[idx], deletedAt: null, archivedAt: null, updatedAt: new Date().toISOString() };
  await writeAll(records);
  return records[idx];
}

async function softArchive(id) {
  const records = await readAll();
  const idx = records.findIndex((w) => w.id === id);
  if (idx === -1) throw new Error("Work order not found");
  if (records[idx].archivedAt) throw new Error("Already archived");
  records[idx] = { ...records[idx], archivedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  await writeAll(records);
  return records[idx];
}

async function listDeleted() {
  const records = await readAll();
  return records.filter((w) => w.deletedAt);
}

async function listArchived() {
  const records = await readAll();
  return records.filter((w) => w.archivedAt && !w.deletedAt);
}

async function purgeDeleted({ olderThanMs = 30 * 24 * 60 * 60 * 1000 } = {}) {
  const records = await readAll();
  const cutoff = Date.now() - olderThanMs;
  const kept = records.filter((w) => {
    if (!w.deletedAt) return true;
    const t = Date.parse(w.deletedAt);
    return !Number.isFinite(t) || t > cutoff;
  });
  const purged = records.length - kept.length;
  if (purged > 0) await writeAll(kept);
  return purged;
}

// ---- Build-mode operations (Brief 2) -------------------------------
//
// Daily-log operations for build WOs. Each helper appends a history
// entry so the audit trail captures every state change. All helpers
// refuse to mutate non-build WOs (return an error code) to keep the
// existing service_visit / spring / fall flows untouched.

function _requireBuild(wo) {
  if (!wo) {
    const err = new Error("Work order not found.");
    err.code = "wo_not_found";
    throw err;
  }
  if (wo.type !== "build") {
    const err = new Error(`Work order ${wo.id} is not build-mode (type=${wo.type}).`);
    err.code = "wrong_mode";
    throw err;
  }
  if (wo.locked === true) {
    const err = new Error(`Work order ${wo.id} is locked. Daily-log edits refused.`);
    err.code = "wo_locked";
    throw err;
  }
  return wo;
}

// Start a session. inAt = now. labourersOnSite defaults to 1
// (Patrick alone unless overridden). Refuses if an active session
// already exists.
async function startSession(woId, { labourersOnSite = 1, labourerNote = "", by = "admin" } = {}) {
  const records = await readAll();
  const idx = records.findIndex((w) => w.id === woId);
  if (idx === -1) throw Object.assign(new Error("Work order not found."), { code: "wo_not_found" });
  const wo = records[idx];
  _requireBuild(wo);

  const dl = wo.dailyLog;
  const active = (dl.sessions || []).find((s) => !s.outAt);
  if (active) {
    const err = new Error("Session already active on this work order.");
    err.code = "session_already_active";
    err.sessionId = active.id;
    throw err;
  }
  const ts = new Date().toISOString();
  const sess = {
    id: newSessionId(),
    inAt: ts,
    outAt: null,
    labourersOnSite: Math.max(1, Math.floor(Number(labourersOnSite) || 1)),
    labourerNote: String(labourerNote || "").slice(0, 400),
    startedBy: String(by || "admin").slice(0, 80)
  };
  dl.sessions = [...(dl.sessions || []), sess];
  if (!wo.arrivedAt) wo.arrivedAt = ts; // first session also stamps WO arrivedAt
  wo.history.push({
    ts,
    action: "session_start",
    by,
    note: `${sess.id} labourers=${sess.labourersOnSite}${labourerNote ? " — " + labourerNote : ""}`
  });
  wo.updatedAt = ts;
  records[idx] = wo;
  await writeAll(records);
  return { workOrder: wo, session: sess };
}

async function endSession(woId, sessionId, { by = "admin" } = {}) {
  const records = await readAll();
  const idx = records.findIndex((w) => w.id === woId);
  if (idx === -1) throw Object.assign(new Error("Work order not found."), { code: "wo_not_found" });
  const wo = records[idx];
  _requireBuild(wo);

  const dl = wo.dailyLog;
  const sIdx = (dl.sessions || []).findIndex((s) => s.id === sessionId);
  if (sIdx === -1) {
    throw Object.assign(new Error("Session not found."), { code: "session_not_found" });
  }
  const sess = dl.sessions[sIdx];
  if (sess.outAt) {
    return { workOrder: wo, session: sess }; // idempotent
  }
  const ts = new Date().toISOString();
  sess.outAt = ts;
  wo.history.push({
    ts,
    action: "session_end",
    by,
    note: `${sess.id} duration=${((new Date(ts) - new Date(sess.inAt)) / 3600000).toFixed(2)}h`
  });
  wo.updatedAt = ts;
  records[idx] = wo;
  await writeAll(records);
  return { workOrder: wo, session: sess };
}

async function setLabourersForSession(woId, sessionId, count, note = "", { by = "admin" } = {}) {
  const records = await readAll();
  const idx = records.findIndex((w) => w.id === woId);
  if (idx === -1) throw Object.assign(new Error("Work order not found."), { code: "wo_not_found" });
  const wo = records[idx];
  _requireBuild(wo);
  const sess = (wo.dailyLog.sessions || []).find((s) => s.id === sessionId);
  if (!sess) throw Object.assign(new Error("Session not found."), { code: "session_not_found" });
  const safeCount = Math.max(1, Math.floor(Number(count) || 1));
  const ts = new Date().toISOString();
  sess.labourersOnSite = safeCount;
  if (typeof note === "string") sess.labourerNote = note.slice(0, 400);
  wo.history.push({
    ts, action: "session_labourers_set", by,
    note: `${sessionId} count=${safeCount}${note ? " — " + note : ""}`
  });
  wo.updatedAt = ts;
  records[idx] = wo;
  await writeAll(records);
  return wo;
}

// Mark a task done in today's daily log. ALSO flips the project's
// master task list. Idempotent — re-marking is a no-op. Returns the
// updated WO and the projectId for the caller to dispatch.
async function markTaskDoneToday(woId, taskId, { photoIds = [], by = "admin" } = {}) {
  const records = await readAll();
  const idx = records.findIndex((w) => w.id === woId);
  if (idx === -1) throw Object.assign(new Error("Work order not found."), { code: "wo_not_found" });
  const wo = records[idx];
  _requireBuild(wo);
  const dl = wo.dailyLog;
  const existing = (dl.tasksCompletedToday || []).find((t) => t.taskId === taskId);
  if (existing) {
    return { workOrder: wo, alreadyDone: true };
  }
  const ts = new Date().toISOString();
  dl.tasksCompletedToday = [
    ...(dl.tasksCompletedToday || []),
    {
      taskId: String(taskId),
      completedAt: ts,
      photoIds: Array.isArray(photoIds) ? photoIds.filter((x) => typeof x === "string") : []
    }
  ];
  wo.history.push({ ts, action: "task_done", by, note: taskId });
  wo.updatedAt = ts;
  records[idx] = wo;
  await writeAll(records);
  return { workOrder: wo, projectId: wo.parentProjectId };
}

async function unmarkTaskDoneToday(woId, taskId, { by = "admin" } = {}) {
  const records = await readAll();
  const idx = records.findIndex((w) => w.id === woId);
  if (idx === -1) throw Object.assign(new Error("Work order not found."), { code: "wo_not_found" });
  const wo = records[idx];
  _requireBuild(wo);
  const dl = wo.dailyLog;
  const list = dl.tasksCompletedToday || [];
  const removed = list.find((t) => t.taskId === taskId);
  dl.tasksCompletedToday = list.filter((t) => t.taskId !== taskId);
  if (!removed) {
    return { workOrder: wo, notDoneHere: true };
  }
  // How much of the project task's cumulative this WO-day contributed, so the
  // caller can roll the project cumulative back by exactly that. null = a
  // legacy binary entry (no recorded delta) → caller does a full unmark.
  const removedDelta = Object.prototype.hasOwnProperty.call(removed, "percentDelta")
    ? Math.round(Number(removed.percentDelta) || 0)
    : null;
  const ts = new Date().toISOString();
  wo.history.push({ ts, action: "task_unmark", by, note: taskId });
  wo.updatedAt = ts;
  records[idx] = wo;
  await writeAll(records);
  return { workOrder: wo, projectId: wo.parentProjectId, removedDelta };
}

// Upsert today's *progress* entry for a task on this build-day WO. Unlike
// markTaskDoneToday (binary), this records a delta of work done today plus the
// resulting cumulative (percentAfter — the caller computes it from the project
// task, which is the authoritative cumulative). A second bump the same day
// accumulates onto the existing entry's percentDelta, refreshes percentAfter,
// and merges photoIds. This is purely the per-day log line.
async function addTaskProgressToday(woId, taskId, { percentDelta = 0, percentAfter = null, photoIds = [], by = "admin" } = {}) {
  const records = await readAll();
  const idx = records.findIndex((w) => w.id === woId);
  if (idx === -1) throw Object.assign(new Error("Work order not found."), { code: "wo_not_found" });
  const wo = records[idx];
  _requireBuild(wo);
  const dl = wo.dailyLog;
  const ts = new Date().toISOString();
  const delta = Math.round(Number(percentDelta) || 0);
  const after = percentAfter != null && Number.isFinite(Number(percentAfter)) ? Math.round(Number(percentAfter)) : null;
  const cleanPhotoIds = Array.isArray(photoIds) ? photoIds.filter((x) => typeof x === "string") : [];
  const list = Array.isArray(dl.tasksCompletedToday) ? dl.tasksCompletedToday : [];
  const existing = list.find((t) => t.taskId === String(taskId));
  if (existing) {
    existing.percentDelta = Math.round((Number(existing.percentDelta) || 0) + delta);
    if (after != null) existing.percentAfter = after;
    existing.completedAt = ts;
    existing.photoIds = [...(existing.photoIds || []), ...cleanPhotoIds];
  } else {
    list.push({ taskId: String(taskId), completedAt: ts, photoIds: cleanPhotoIds, percentDelta: delta, percentAfter: after });
  }
  dl.tasksCompletedToday = list;
  wo.history.push({ ts, action: "task_progress", by, note: `${taskId} ${delta >= 0 ? "+" : ""}${delta}% → ${after == null ? "?" : after}%` });
  wo.updatedAt = ts;
  records[idx] = wo;
  await writeAll(records);
  return { workOrder: wo, projectId: wo.parentProjectId };
}

async function recordMaterialConsumed(woId, items, { by = "admin" } = {}) {
  // items can be a single { partSku, qty, note } or an array — supports
  // batch from the catalog picker.
  const records = await readAll();
  const idx = records.findIndex((w) => w.id === woId);
  if (idx === -1) throw Object.assign(new Error("Work order not found."), { code: "wo_not_found" });
  const wo = records[idx];
  _requireBuild(wo);
  const dl = wo.dailyLog;
  const ts = new Date().toISOString();
  const incoming = Array.isArray(items) ? items : [items];
  const cleaned = [];
  for (const raw of incoming) {
    const partSku = String(raw?.partSku || "").trim();
    const qty = Number(raw?.qty);
    if (!partSku || !Number.isFinite(qty) || qty <= 0) continue;
    cleaned.push({
      partSku,
      qty,
      addedAt: ts,
      note: typeof raw?.note === "string" ? raw.note.slice(0, 400) : ""
    });
  }
  if (!cleaned.length) {
    throw Object.assign(new Error("No valid material entries."), { code: "no_valid_materials" });
  }
  dl.materialsConsumed = [...(dl.materialsConsumed || []), ...cleaned];
  wo.history.push({
    ts, action: "materials_consumed", by,
    note: `${cleaned.length} entries: ${cleaned.map((c) => c.partSku + "x" + c.qty).slice(0, 8).join(", ")}`
  });
  wo.updatedAt = ts;
  records[idx] = wo;
  await writeAll(records);
  return wo;
}

async function removeMaterialConsumed(woId, entryIndex, { by = "admin" } = {}) {
  const records = await readAll();
  const idx = records.findIndex((w) => w.id === woId);
  if (idx === -1) throw Object.assign(new Error("Work order not found."), { code: "wo_not_found" });
  const wo = records[idx];
  _requireBuild(wo);
  const dl = wo.dailyLog;
  const i = Number(entryIndex);
  if (!Number.isInteger(i) || i < 0 || i >= (dl.materialsConsumed || []).length) {
    throw Object.assign(new Error("Material entry index out of range."), { code: "bad_index" });
  }
  const removed = dl.materialsConsumed.splice(i, 1)[0];
  const ts = new Date().toISOString();
  wo.history.push({ ts, action: "materials_removed", by, note: `${removed.partSku} x${removed.qty}` });
  wo.updatedAt = ts;
  records[idx] = wo;
  await writeAll(records);
  return wo;
}

async function setNextDayPlan(woId, { nextDayMaterials, nextDayTasks }, { by = "admin" } = {}) {
  const records = await readAll();
  const idx = records.findIndex((w) => w.id === woId);
  if (idx === -1) throw Object.assign(new Error("Work order not found."), { code: "wo_not_found" });
  const wo = records[idx];
  _requireBuild(wo);
  const dl = wo.dailyLog;
  const ts = new Date().toISOString();
  if (Array.isArray(nextDayMaterials)) {
    dl.nextDayMaterials = nextDayMaterials.map((m) => ({
      partSku: String(m?.partSku || ""),
      qty: Number(m?.qty) || 1,
      addedAt: ts,
      note: typeof m?.note === "string" ? m.note.slice(0, 400) : ""
    })).filter((m) => m.partSku);
  }
  if (Array.isArray(nextDayTasks)) {
    dl.nextDayTasks = nextDayTasks
      .map((t) => String(t || "").trim().slice(0, 400))
      .filter(Boolean);
  }
  wo.history.push({
    ts, action: "next_day_plan", by,
    note: `materials=${dl.nextDayMaterials.length} tasks=${dl.nextDayTasks.length}`
  });
  wo.updatedAt = ts;
  records[idx] = wo;
  await writeAll(records);
  return wo;
}

async function setDailyNotes(woId, notes, { by = "admin" } = {}) {
  const records = await readAll();
  const idx = records.findIndex((w) => w.id === woId);
  if (idx === -1) throw Object.assign(new Error("Work order not found."), { code: "wo_not_found" });
  const wo = records[idx];
  _requireBuild(wo);
  wo.dailyLog.dailyNotes = String(notes || "").slice(0, 20000);
  const ts = new Date().toISOString();
  wo.history.push({ ts, action: "daily_notes", by, note: `${wo.dailyLog.dailyNotes.length} chars` });
  wo.updatedAt = ts;
  records[idx] = wo;
  await writeAll(records);
  return wo;
}

// Find all build WOs for a given project. Used by the project metrics
// rollup + T&M billing computation.
async function listBuildWosForProject(projectId) {
  if (!projectId) return [];
  const records = await readAll();
  return records.filter((w) => w.type === "build" && w.parentProjectId === projectId);
}

module.exports = {
  TEMPLATES,
  ZONE_STATUSES,
  ZONE_CHECK_KEYS,
  ZONE_ISSUE_TYPES,
  SERVICE_CHECKLISTS,
  checklistKeysForWorkOrder,
  WO_PHOTO_CATEGORIES,
  PHOTO_REQUIREMENT_BY_TYPE,
  CUSTOMER_NOTE_REQUIRED_BY_TYPE,
  SCOPE_PROTECTED_FIELDS,
  BYPASS_REASONS,
  UNLOCK_MIN_REASON_LEN,
  templateForServiceKey,
  declaredZoneList,
  scaffoldZonesFromProperty,
  canBuildOnSiteQuote,
  isScopeFrozen,
  findProtectedFieldTouched,
  summarizeScopeAdditions,
  captureSignatureBypass,
  unlockWorkOrder,
  relockWorkOrder,
  recordOfflineQuoteAcceptance,
  attachSignedCopyRef,
  appendReportSnapshot,
  patchReportSnapshot,
  appendHistory,
  list,
  get,
  listByProperty,
  listByLead,
  create,
  update,
  completeBackdated,
  remove,
  softDelete,
  restore,
  softArchive,
  listDeleted,
  listArchived,
  purgeDeleted,
  // Brief 2 — build-mode operations
  blankDailyLog,
  startSession,
  endSession,
  setLabourersForSession,
  markTaskDoneToday,
  unmarkTaskDoneToday,
  addTaskProgressToday,
  recordMaterialConsumed,
  removeMaterialConsumed,
  setNextDayPlan,
  setDailyNotes,
  listBuildWosForProject
};
