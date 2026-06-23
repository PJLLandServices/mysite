// Projects — the multi-visit container for named jobs (Smith install,
// Carter renovation, etc.). One project lives at one property and groups
// any number of work orders + material lists under a single name +
// status. Distinct from a Booking (one scheduled appointment) and from
// a Property (the customer's site, persistent forever) — a Project is
// scoped to a specific piece of work.
//
// ID format: PROJ-YYYY-NNNN. Per-year counter, mirrors Q-YYYY-NNNN /
// I-YYYY-NNNN / BK-YYYY-NNNN / ML-YYYY-NNNN.
//
// Status enum:
//   planning   — being scoped; no on-site work yet
//   active     — at least one WO scheduled or in flight
//   complete   — all WOs done; nothing outstanding
//   archived   — out of the default index; kept for retrieval
//
// Storage: server/data/projects.json. Same flat-file pattern; rotate to
// SQLite if project count crosses ~10,000 (PJL-scale: never).
//
// Linkage:
//   workOrderIds[]   — WOs that roll up under this project
//   sourceQuoteId    — the Quote this project was converted from (if any)
//   propertyId       — the property this project lives at
//
// Material lists attach to a project via the materialLists record's
// parentType="project" + parentId=projectId fields (no back-reference
// stored here — single source of truth lives on the materialLists side).

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");

const FILE = path.join(__dirname, "..", "data", "projects.json");

const STATUSES = ["planning", "active", "complete", "archived"];

// Mirrors quotes.js — kept in lockstep. If a new branch is added there,
// update this list too.
const BRANCHES = [
  "gc_subcontract",
  "direct_residential",
  "lighting_design",
  "renovation_coordination",
  "change_order"
];
const BILLING_MODES = ["fixed_price", "time_and_material"];

function random8() {
  return Math.random().toString(36).slice(2, 10).padEnd(8, "0");
}

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

function blankProject() {
  const created = nowIso();
  return {
    id: "",
    name: "",
    status: "planning",

    // Customer + address — denormalized for fast index display. Linked
    // property (when set) is the source of truth; customerId references
    // customers.json (Brief 2); the snapshot fields are the as-quoted
    // record preserved for legal continuity.
    customerId: null,
    customerName: "",
    customerEmail: "",
    customerPhone: "",
    propertyId: null,
    address: "",

    description: "",   // one-paragraph scope ("retrofit front yard, 14 zones")
    notes: "",         // free-form internal notes

    // Linked work orders. Push via attachWorkOrder; remove via
    // detachWorkOrder. Order is insertion order — UI sorts as needed.
    workOrderIds: [],

    // If the project was spun out of a Quote (via convert-to-project),
    // sourceQuoteId points back to it so we can render "from Q-2026-0042"
    // on the project header.
    sourceQuoteId: null,

    // -------- project_proposal enrichment (Brief 1, May 2026) --------
    // Populated when the source quote is a project_proposal. Stay at
    // their defaults (null/empty) when converted from older
    // ai_repair_quote / on_site_quote.

    // Branch — mirrored from the quote at conversion time.
    branch: null,
    // billingMode — "fixed_price" or "time_and_material".
    billingMode: null,
    // buildTracking — set true to turn a MANUALLY-created project into a
    // build/execution project (Customer-link follow-up brief, Jun 2026).
    // Proposal-converted projects already light up the daily-log / task /
    // status-update surfaces via branch + proposalSnapshot; a hand-made
    // project has neither, so this flag is the explicit "I'm tracking
    // build progress on this job" switch. Billing-neutral — it does NOT
    // set billingMode, so the T&M billing surfaces stay dormant.
    buildTracking: false,
    // labourRateLocked — snapshot of customRates.labour at conversion.
    // For T&M projects this is the rate that bills forever; for
    // fixed-price it's informational only. Immutable after conversion.
    labourRateLocked: null,
    // tasks[] — seeded from the quote's line items (one task per line)
    // and edited by Patrick in the pre-Day-1 review before scheduling
    // (Brief 2 takes over from there). { id, description, sourceLineItemId,
    // status, completedAt?, completedByWoId?, order }
    tasks: [],
    // attachments[] — references to the quote's attachments by id, so
    // the project page can render the same map / diagram thumbnails
    // without re-uploading. { id, sourceQuoteAttachmentId, kind,
    // caption, order }
    attachments: [],
    // proposalSnapshot — frozen copy of the accepted proposal at the
    // moment of conversion. Mirrors sections + line items + totals +
    // branch + acceptanceMethod + customer/property snapshot. Used to
    // render the "accepted proposal" view on the project detail page
    // without re-reading the (possibly archived) quote.
    proposalSnapshot: null,

    // Brief 2 — scope-change records. Each entry captures an
    // out-of-scope addition raised during execution. Flow:
    // pending_admin_review → pending_customer_approval → approved /
    // rejected / withdrawn → (if approved + fixed-price) executed_under_revision
    // with linkedRevisionQuoteId pointing at the Q-vN created via
    // generateQuoteRevisionFromScopeChange().
    scopeChangeRequests: [],

    // Brief 2 — status update audit log. Every "Send status update"
    // press creates an entry: snapshot of HTML sent, recipient,
    // timestamp. Never mutated after creation.
    statusUpdates: [],

    // Brief 2 — the WO whose completion closes the project. Set
    // explicitly via /api/projects/:id/mark-final-wo or auto-detected
    // as the most recent build WO at project completion time.
    finalWoId: null,

    // Brief 2 — idempotency stamps for the project completion cascade.
    // projectCompletionAt: ISO when completeProject() ran successfully.
    // invoiceGeneratedAt: ISO when the final invoice was created.
    // propertyEditsAppliedAt: ISO when project-level edits flowed to property.
    // Re-running completeProject is idempotent — checks these stamps
    // to short-circuit duplicate side effects.
    projectCompletionAt: null,
    invoiceGeneratedAt: null,
    propertyEditsAppliedAt: null,
    // The invoice ID created at project completion (so the project UI
    // can deep-link to it). Same value also lives on the invoice
    // record's sourceProjectId field.
    finalInvoiceId: null,

    // Lifecycle timestamps — auto-stamped on status transitions so the
    // UI can show "Active since Mar 14" without a history scan.
    startedAt: null,    // set when status first flips to "active"
    completedAt: null,  // set when status first flips to "complete"

    createdAt: created,
    updatedAt: created,
    createdBy: "admin",

    history: [
      { ts: created, action: "created", by: "admin", note: "" }
    ]
  };
}

function hydrate(rec) {
  const base = blankProject();
  return {
    ...base,
    ...rec,
    status: STATUSES.includes(rec?.status) ? rec.status : "planning",
    workOrderIds: Array.isArray(rec?.workOrderIds) ? rec.workOrderIds.slice() : [],
    history: Array.isArray(rec?.history) ? rec.history.slice(-200) : [],
    tasks: Array.isArray(rec?.tasks) ? rec.tasks : [],
    attachments: Array.isArray(rec?.attachments) ? rec.attachments : [],
    proposalSnapshot: rec?.proposalSnapshot || null,
    branch: rec?.branch || null,
    billingMode: rec?.billingMode || null,
    buildTracking: rec?.buildTracking === true,
    labourRateLocked: rec?.labourRateLocked == null ? null : Number(rec.labourRateLocked),
    scopeChangeRequests: Array.isArray(rec?.scopeChangeRequests) ? rec.scopeChangeRequests : [],
    statusUpdates: Array.isArray(rec?.statusUpdates) ? rec.statusUpdates : [],
    finalWoId: typeof rec?.finalWoId === "string" ? rec.finalWoId : null,
    projectCompletionAt: typeof rec?.projectCompletionAt === "string" ? rec.projectCompletionAt : null,
    invoiceGeneratedAt: typeof rec?.invoiceGeneratedAt === "string" ? rec.invoiceGeneratedAt : null,
    propertyEditsAppliedAt: typeof rec?.propertyEditsAppliedAt === "string" ? rec.propertyEditsAppliedAt : null,
    finalInvoiceId: typeof rec?.finalInvoiceId === "string" ? rec.finalInvoiceId : null
  };
}

async function nextProjectId(year) {
  const records = await readAll();
  const prefix = `PROJ-${year}-`;
  let max = 0;
  for (const r of records) {
    if (typeof r.id === "string" && r.id.startsWith(prefix)) {
      const n = parseInt(r.id.slice(prefix.length), 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return `${prefix}${String(max + 1).padStart(4, "0")}`;
}

function appendHistory(record, entry) {
  record.history = Array.isArray(record.history) ? record.history : [];
  record.history.push({ ts: nowIso(), by: "admin", note: "", ...entry });
  if (record.history.length > 200) record.history = record.history.slice(-200);
}

// ---- CRUD -----------------------------------------------------------

async function list({ status = null, includeArchived = false, propertyId = null } = {}) {
  const records = await readAll();
  return records.filter((r) => {
    if (!includeArchived && r.status === "archived" && status !== "archived") return false;
    if (status && r.status !== status) return false;
    if (propertyId && r.propertyId !== propertyId) return false;
    return true;
  });
}

async function get(id) {
  const records = await readAll();
  return records.find((r) => r.id === id) || null;
}

async function create({
  name = "",
  customerId = null,
  customerName = "",
  customerEmail = "",
  customerPhone = "",
  propertyId = null,
  address = "",
  description = "",
  notes = "",
  sourceQuoteId = null,
  workOrderIds = [],
  createdBy = "admin"
} = {}) {
  // Brief 4 — auto-resolve customerId from email/phone when the caller
  // didn't pass it. Keeps new records correctly linked from creation.
  if (!customerId && (customerEmail || customerPhone)) {
    try {
      const customersLib = require("./customers");
      const match = customerEmail
        ? await customersLib.findByEmail(customerEmail)
        : await customersLib.findByPhone(customerPhone);
      if (match) customerId = match.id;
    } catch (err) { /* tolerate */ }
  }

  const records = await readAll();
  const year = new Date().getUTCFullYear();
  const id = await nextProjectId(year);
  const rec = blankProject();
  rec.id = id;
  rec.name = String(name || "").trim().slice(0, 200);
  rec.customerId = customerId || null;
  rec.customerName = String(customerName || "").trim().slice(0, 200);
  rec.customerEmail = String(customerEmail || "").trim().toLowerCase().slice(0, 254);
  rec.customerPhone = String(customerPhone || "").trim().slice(0, 40);
  rec.propertyId = propertyId ? String(propertyId) : null;
  rec.address = String(address || "").trim().slice(0, 400);
  rec.description = String(description || "").slice(0, 2000);
  rec.notes = String(notes || "").slice(0, 4000);
  rec.sourceQuoteId = sourceQuoteId ? String(sourceQuoteId) : null;
  rec.workOrderIds = Array.isArray(workOrderIds) ? workOrderIds.filter(Boolean).map(String) : [];
  rec.createdBy = String(createdBy || "admin").slice(0, 80);
  rec.history = [{ ts: nowIso(), action: "created", by: rec.createdBy, note: rec.name || "" }];
  if (rec.sourceQuoteId) {
    appendHistory(rec, { action: "from_quote", note: rec.sourceQuoteId });
  }
  records.unshift(rec);
  await writeAll(records);
  return rec;
}

// Resolve a customer by id into the snapshot payload a project stores
// when it's linked to a CRM customer (Brief: pick-an-existing-customer).
// Server-side source of truth — the route never trusts client-sent
// contact values; it sends only the customerId and we resolve the rest
// here. Throws customer_not_found when the id doesn't resolve so the
// caller can surface a clear error. Property/address are deliberately
// NOT part of the snapshot (a customer can own many job-site properties;
// Patrick sets the project's property by hand).
async function buildCustomerSnapshot(customerId) {
  const customersLib = require("./customers");
  const cust = await customersLib.get(customerId, { withProperties: false });
  if (!cust) {
    throw Object.assign(new Error(`Customer ${customerId} not found.`), { code: "customer_not_found" });
  }
  const negotiatedLabour = Number(cust?.negotiatedRates?.labour);
  return {
    customerId: cust.id,
    customerName: cust.name || "",
    customerEmail: cust.email || "",
    customerPhone: cust.phone || "",
    // null when the customer has no standing negotiated labour rate, so
    // the caller can leave the project's existing rate untouched.
    negotiatedLabourRate: Number.isFinite(negotiatedLabour) && negotiatedLabour > 0 ? negotiatedLabour : null
  };
}

// Update top-level fields. Status transitions auto-stamp startedAt /
// completedAt the first time a project enters those states. Archived is
// sticky unless the caller explicitly moves it back to a non-archived
// status (which re-derives via the ordinary status path).
async function update(id, patch = {}) {
  const records = await readAll();
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const current = records[idx];
  const next = { ...current };

  // Customer link (pick-an-existing-customer). When customerId is present
  // we resolve the snapshot server-side and overwrite the contact fields
  // — any free-text customerName/Email/Phone in the SAME patch is ignored
  // in favour of the resolved values (catalog-is-source-of-truth). A
  // customerId of null/"" unlinks the project WITHOUT blanking the
  // last-known snapshot text, so legacy/unlinked rendering still works.
  let customerLinkApplied = false;
  if (Object.prototype.hasOwnProperty.call(patch, "customerId")) {
    const rawId = patch.customerId == null ? "" : String(patch.customerId).trim();
    if (rawId) {
      const snap = await buildCustomerSnapshot(rawId); // throws customer_not_found
      next.customerId = snap.customerId;
      next.customerName = snap.customerName;
      next.customerEmail = snap.customerEmail;
      next.customerPhone = snap.customerPhone;
      // Snapshot the negotiated labour rate into the project's EXISTING
      // rate field (no parallel field). Guard: never clobber a rate that
      // was locked from an accepted T&M proposal — that one bills forever
      // and is immutable after conversion.
      const lockedTAndM = current.billingMode === "time_and_material"
        && Number.isFinite(Number(current.labourRateLocked))
        && Number(current.labourRateLocked) > 0;
      if (snap.negotiatedLabourRate != null && !lockedTAndM) {
        next.labourRateLocked = snap.negotiatedLabourRate;
      }
      customerLinkApplied = true;
    } else {
      next.customerId = null;
    }
  }

  // Build-tracking switch — turns a manual project into an execution
  // project so the daily-log / task / status-update surfaces appear.
  // One-way in practice (the UI only offers "start"), but the field
  // accepts false too in case a future flow needs to turn it back off.
  if (Object.prototype.hasOwnProperty.call(patch, "buildTracking")) {
    const wantOn = patch.buildTracking === true;
    if (current.buildTracking !== wantOn) {
      next.buildTracking = wantOn;
      appendHistory(next, { action: wantOn ? "build_tracking_started" : "build_tracking_stopped" });
    }
  }

  const allowedTop = ["name", "customerName", "customerEmail", "customerPhone", "address", "description", "notes", "propertyId", "sourceQuoteId"];
  for (const key of allowedTop) {
    // When a customer was just linked, its resolved contact fields win —
    // ignore any stale free-text contact values in the same patch.
    if (customerLinkApplied && (key === "customerName" || key === "customerEmail" || key === "customerPhone")) continue;
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      if (key === "customerEmail") {
        next.customerEmail = String(patch.customerEmail || "").trim().toLowerCase().slice(0, 254);
      } else if (key === "name" || key === "customerName") {
        next[key] = String(patch[key] || "").trim().slice(0, 200);
      } else if (key === "address") {
        next.address = String(patch.address || "").trim().slice(0, 400);
      } else if (key === "customerPhone") {
        next.customerPhone = String(patch.customerPhone || "").trim().slice(0, 40);
      } else if (key === "description") {
        next.description = String(patch.description || "").slice(0, 2000);
      } else if (key === "notes") {
        next.notes = String(patch.notes || "").slice(0, 4000);
      } else if (key === "propertyId" || key === "sourceQuoteId") {
        next[key] = patch[key] ? String(patch[key]) : null;
      }
    }
  }

  if (Object.prototype.hasOwnProperty.call(patch, "status")) {
    const requested = patch.status;
    if (!STATUSES.includes(requested)) {
      throw new Error(`Unknown project status: ${requested}`);
    }
    if (current.status !== requested) {
      next.status = requested;
      // Stamp lifecycle timestamps the first time we enter each state.
      if (requested === "active" && !current.startedAt) next.startedAt = nowIso();
      if (requested === "complete" && !current.completedAt) next.completedAt = nowIso();
      appendHistory(next, { action: `status:${requested}` });
    }
  }

  next.updatedAt = nowIso();

  if (current.name !== next.name) appendHistory(next, { action: "renamed", note: next.name });
  if (current.propertyId !== next.propertyId) {
    appendHistory(next, { action: "property_changed", note: next.propertyId || "(detached)" });
  }
  if (current.customerId !== next.customerId) {
    appendHistory(next, {
      action: next.customerId ? "customer_linked" : "customer_unlinked",
      note: next.customerId ? `${next.customerId} — ${next.customerName || ""}`.trim() : "(unlinked)"
    });
  }

  records[idx] = next;
  await writeAll(records);
  return next;
}

// Create a new Project from an accepted project_proposal quote.
//
// Enriches the standard create() with:
//   - branch, billingMode mirrored from the quote
//   - labourRateLocked snapshotted from quote.customRates.labour (T&M
//     uses this rate; fixed-price keeps it informational)
//   - tasks[] seeded from quote.lineItems — one task per line, status
//     "pending", description = line label, sourceLineItemId set
//   - attachments[] referencing quote.attachments by id (no file copy;
//     the project reads through to the quote's directory)
//   - proposalSnapshot frozen copy of the accepted proposal at this
//     instant (sections + line items + totals + branch + acceptance
//     method + customer/property snapshot)
//
// Idempotent at the caller — the convert-to-project endpoint checks
// for an existing project with sourceQuoteId === quote.id before
// invoking this and returns the existing one if found.
async function createFromProposal(quote, { customerName = "", customerEmail = "", customerPhone = "", address = "", propertyId = null, by = "admin" } = {}) {
  if (!quote) throw new Error("createFromProposal requires a quote.");
  if (quote.type !== "project_proposal") {
    throw new Error("createFromProposal only handles project_proposal quotes.");
  }

  const namePieces = [];
  if (customerName) namePieces.push(customerName);
  namePieces.push(`(from ${quote.id})`);
  const name = namePieces.join(" ").slice(0, 200);

  // Seed tasks from line items.
  const tasks = (quote.lineItems || []).map((li, idx) => ({
    id: "task_" + random8(),
    description: String(li.label || li.sourceKey || `Task ${idx + 1}`).slice(0, 400),
    sourceLineItemId: li.id || null,
    status: "pending",
    percentComplete: 0,
    completedAt: null,
    completedByWoId: null,
    order: idx
  }));

  // Reference quote attachments (no file copy — the project reads
  // through to the quote directory). signed_pdf_return is the
  // acceptance evidence, not a project artifact — skip it here.
  const attachments = (quote.attachments || [])
    .filter((a) => a.kind !== "signed_pdf_return")
    .map((a, idx) => ({
      id: "att_" + random8(),
      sourceQuoteId: quote.id,
      sourceQuoteAttachmentId: a.id,
      kind: a.kind,
      caption: a.caption || a.filename || "",
      filename: a.filename || "",
      mimeType: a.mimeType || "",
      order: idx
    }));

  // Freeze the proposal snapshot.
  const proposalSnapshot = {
    quoteId: quote.id,
    version: quote.version || 1,
    branch: quote.branch || null,
    billingMode: quote.billingMode || null,
    acceptanceMethod: quote.acceptanceMethod || null,
    acceptedAt: quote.acceptedAt || null,
    customerName,
    customerEmail,
    customerPhone,
    address,
    proposalSections: Array.isArray(quote.proposalSections)
      ? quote.proposalSections.map((s) => ({ ...s, attachmentIds: [...(s.attachmentIds || [])] }))
      : [],
    lineItems: Array.isArray(quote.lineItems) ? quote.lineItems.map((li) => ({ ...li })) : [],
    subtotal: Number(quote.subtotal) || 0,
    hst: Number(quote.hst) || 0,
    total: Number(quote.total) || 0,
    customRates: { ...(quote.customRates || {}) },
    scope: quote.scope || "",
    frozenAt: nowIso()
  };

  // Delegate to the standard create() so the id-generation + file-write
  // path is single-source. Then patch the proposal-only fields.
  const proj = await create({
    name,
    customerName,
    customerEmail,
    customerPhone,
    address,
    propertyId,
    sourceQuoteId: quote.id,
    description: quote.scope || "",
    createdBy: by
  });

  // Patch the proposal-only fields directly on the record.
  const records = await readAll();
  const idx = records.findIndex((r) => r.id === proj.id);
  if (idx === -1) return proj;
  records[idx] = {
    ...records[idx],
    branch: quote.branch || null,
    billingMode: quote.billingMode || null,
    labourRateLocked: Number.isFinite(Number(quote.customRates?.labour))
      ? Number(quote.customRates.labour)
      : null,
    tasks,
    attachments,
    proposalSnapshot
  };
  appendHistory(records[idx], {
    action: "proposal_enriched",
    by,
    note: `tasks=${tasks.length} attachments=${attachments.length} branch=${quote.branch || "none"}`
  });
  await writeAll(records);
  return records[idx];
}

// Push a WO id onto the project's workOrderIds[]. Idempotent — if the
// WO is already attached, returns the project unchanged. Caller is
// responsible for setting the WO's reverse pointer (Phase 2 keeps this
// loose-coupled because WOs don't carry a projectId field yet — the UI
// reads project.workOrderIds[] as the source of truth).
async function attachWorkOrder(id, workOrderId) {
  if (!id || !workOrderId) return null;
  const records = await readAll();
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const proj = records[idx];
  if (!Array.isArray(proj.workOrderIds)) proj.workOrderIds = [];
  if (!proj.workOrderIds.includes(workOrderId)) {
    proj.workOrderIds.push(workOrderId);
    proj.updatedAt = nowIso();
    appendHistory(proj, { action: "wo_attached", note: workOrderId });
    records[idx] = proj;
    await writeAll(records);
  }
  return proj;
}

async function detachWorkOrder(id, workOrderId) {
  if (!id || !workOrderId) return null;
  const records = await readAll();
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const proj = records[idx];
  const before = (proj.workOrderIds || []).length;
  proj.workOrderIds = (proj.workOrderIds || []).filter((x) => x !== workOrderId);
  if (proj.workOrderIds.length !== before) {
    proj.updatedAt = nowIso();
    appendHistory(proj, { action: "wo_detached", note: workOrderId });
    records[idx] = proj;
    await writeAll(records);
  }
  return proj;
}

async function remove(id) {
  const records = await readAll();
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const [removed] = records.splice(idx, 1);
  await writeAll(records);
  return removed;
}

// Find projects whose workOrderIds[] contains this WO. Almost always 0
// or 1 — but the schema doesn't enforce uniqueness so callers should
// handle the multi case (display "in 2 projects").
async function listByWorkOrder(workOrderId) {
  if (!workOrderId) return [];
  const records = await readAll();
  return records.filter((r) => Array.isArray(r.workOrderIds) && r.workOrderIds.includes(workOrderId));
}

// ---- Brief 2: Task operations --------------------------------------

const TASK_STATUSES = ["pending", "in_progress", "done"];

// Helper — load a project, mutate via callback, write back, return next.
async function _mutate(projectId, fn) {
  const records = await readAll();
  const idx = records.findIndex((r) => r.id === projectId);
  if (idx === -1) {
    throw Object.assign(new Error("Project not found."), { code: "project_not_found" });
  }
  const next = { ...records[idx] };
  const result = await fn(next);
  next.updatedAt = nowIso();
  records[idx] = next;
  await writeAll(records);
  return result === undefined ? next : result;
}

async function seedTasksFromQuote(projectId, quote) {
  return _mutate(projectId, (proj) => {
    // Refuse if any task is already done — re-seed would erase history.
    if ((proj.tasks || []).some((t) => t.status === "done")) {
      const err = new Error("Cannot re-seed tasks once any task is done.");
      err.code = "tasks_partially_done";
      throw err;
    }
    proj.tasks = (quote.lineItems || []).map((li, idx) => ({
      id: "task_" + random8(),
      description: String(li.label || li.sourceKey || `Task ${idx + 1}`).slice(0, 400),
      sourceLineItemId: li.id || null,
      status: "pending",
      percentComplete: 0,
      completedAt: null,
      completedByWoId: null,
      order: idx,
      notes: ""
    }));
    appendHistory(proj, { action: "tasks_seeded", note: `${proj.tasks.length} from quote ${quote.id}` });
    return proj;
  });
}

async function addTask(projectId, { description, sourceLineItemId = null, notes = "" } = {}, { by = "admin" } = {}) {
  if (!description || !String(description).trim()) {
    throw Object.assign(new Error("Task description is required."), { code: "missing_description" });
  }
  return _mutate(projectId, (proj) => {
    if (!Array.isArray(proj.tasks)) proj.tasks = [];
    const task = {
      id: "task_" + random8(),
      description: String(description).slice(0, 400),
      sourceLineItemId: sourceLineItemId || null,
      status: "pending",
      percentComplete: 0,
      completedAt: null,
      completedByWoId: null,
      order: proj.tasks.length,
      notes: String(notes || "").slice(0, 2000)
    };
    proj.tasks.push(task);
    appendHistory(proj, { action: "task_added", by, note: task.id });
    return task;
  });
}

async function updateTask(projectId, taskId, patch, { by = "admin" } = {}) {
  return _mutate(projectId, (proj) => {
    const t = (proj.tasks || []).find((x) => x.id === taskId);
    if (!t) throw Object.assign(new Error("Task not found."), { code: "task_not_found" });
    if (t.status === "done") {
      throw Object.assign(new Error("Completed tasks are locked."), { code: "task_locked" });
    }
    if (typeof patch.description === "string") t.description = patch.description.slice(0, 400);
    if (typeof patch.notes === "string") t.notes = patch.notes.slice(0, 2000);
    if (Number.isFinite(Number(patch.order))) t.order = Number(patch.order);
    appendHistory(proj, { action: "task_updated", by, note: taskId });
    return t;
  });
}

async function removeTask(projectId, taskId, { by = "admin" } = {}) {
  return _mutate(projectId, (proj) => {
    const i = (proj.tasks || []).findIndex((x) => x.id === taskId);
    if (i === -1) throw Object.assign(new Error("Task not found."), { code: "task_not_found" });
    if (proj.tasks[i].status === "done") {
      throw Object.assign(new Error("Completed tasks cannot be removed."), { code: "task_locked" });
    }
    const [removed] = proj.tasks.splice(i, 1);
    appendHistory(proj, { action: "task_removed", by, note: removed.description.slice(0, 100) });
    return { removed: removed.id };
  });
}

async function markTaskComplete(projectId, taskId, completedByWoId, { by = "admin" } = {}) {
  return _mutate(projectId, (proj) => {
    const t = (proj.tasks || []).find((x) => x.id === taskId);
    if (!t) throw Object.assign(new Error("Task not found."), { code: "task_not_found" });
    if (t.status === "done") return t; // idempotent
    t.status = "done";
    t.percentComplete = 100;
    t.completedAt = nowIso();
    t.completedByWoId = completedByWoId || null;
    appendHistory(proj, { action: "task_done", by, note: `${taskId} via ${completedByWoId || "manual"}` });
    return t;
  });
}

async function unmarkTaskComplete(projectId, taskId, expectedWoId = null, { by = "admin" } = {}) {
  return _mutate(projectId, (proj) => {
    const t = (proj.tasks || []).find((x) => x.id === taskId);
    if (!t) throw Object.assign(new Error("Task not found."), { code: "task_not_found" });
    if (t.status !== "done") return t;
    // Guard — if a specific WO is asserting it completed this task,
    // refuse to unmark when a different WO actually did. Prevents
    // cross-day accidental unmarks.
    if (expectedWoId && t.completedByWoId && t.completedByWoId !== expectedWoId) {
      const err = new Error(`Task was completed by ${t.completedByWoId}, not ${expectedWoId}.`);
      err.code = "task_not_owned_by_wo";
      throw err;
    }
    t.status = "pending";
    t.percentComplete = 0;
    t.completedAt = null;
    t.completedByWoId = null;
    appendHistory(proj, { action: "task_unmarked", by, note: taskId });
    return t;
  });
}

// Apply a *delta* of progress to a task and recompute its state. Positive
// delta = work done this build day; negative = correction / undo. The task's
// percentComplete is the cumulative source of truth and `status` follows the
// invariant: 0 = pending, 1-99 = in_progress, 100 = done. The finishing WO is
// stamped (completedAt + completedByWoId) only on the upward crossing to 100,
// and cleared if the task is rolled back below 100. Legacy done tasks read as
// 100 so a pre-percentComplete record can still be corrected. Returns the task.
async function addTaskProgress(projectId, taskId, deltaPercent, completedByWoId, { by = "admin" } = {}) {
  return _mutate(projectId, (proj) => {
    const t = (proj.tasks || []).find((x) => x.id === taskId);
    if (!t) throw Object.assign(new Error("Task not found."), { code: "task_not_found" });
    const cur = t.status === "done" ? 100 : (Number(t.percentComplete) || 0);
    const delta = Math.round(Number(deltaPercent) || 0);
    const next = Math.max(0, Math.min(100, cur + delta));
    const crossedUp = cur < 100 && next >= 100;
    t.percentComplete = next;
    if (next >= 100) {
      t.status = "done";
      if (crossedUp) {
        t.completedAt = nowIso();
        t.completedByWoId = completedByWoId || null;
      }
    } else {
      t.status = next > 0 ? "in_progress" : "pending";
      t.completedAt = null;
      t.completedByWoId = null;
    }
    appendHistory(proj, {
      action: "task_progress", by,
      note: `${taskId} ${delta >= 0 ? "+" : ""}${delta}% → ${next}% via ${completedByWoId || "manual"}`
    });
    return t;
  });
}

// ---- Brief 2: Project metrics & T&M billing -----------------------

// Pure read — list all task-anchored photo refs across the project's
// build WOs. Returns [{ taskId, woId, n, filename, mediaType, addedAt }].
// Sorted newest-first. Brief 2 §3.1 + §3.8.
async function listTaskPhotos(projectId) {
  const workOrders = require("./work-orders");
  const buildWos = await workOrders.listBuildWosForProject(projectId);
  const photos = [];
  for (const wo of buildWos) {
    for (const p of (wo.photos || [])) {
      if (!p.taskId) continue;
      photos.push({
        taskId: p.taskId,
        woId: wo.id,
        n: p.n,
        filename: p.filename,
        mediaType: p.mediaType,
        addedAt: p.addedAt
      });
    }
  }
  return photos.sort((a, b) => String(b.addedAt || "").localeCompare(String(a.addedAt || "")));
}

// Pure read — recent photos (any kind) across all build WOs, capped.
// Used by the status-update snapshot to embed a photo strip.
async function listRecentProjectPhotos(projectId, { limit = 6 } = {}) {
  const workOrders = require("./work-orders");
  const buildWos = await workOrders.listBuildWosForProject(projectId);
  const photos = [];
  for (const wo of buildWos) {
    for (const p of (wo.photos || [])) {
      // Skip PDFs — strip is for image attachments only.
      if (p.mediaType && p.mediaType.startsWith("image/")) {
        photos.push({
          woId: wo.id,
          n: p.n,
          filename: p.filename,
          mediaType: p.mediaType,
          addedAt: p.addedAt,
          taskId: p.taskId || null
        });
      }
    }
  }
  photos.sort((a, b) => String(b.addedAt || "").localeCompare(String(a.addedAt || "")));
  return photos.slice(0, limit);
}

// Pure read — returns derived metrics from project + attached build WOs.
async function computeProjectMetrics(projectId) {
  const proj = await get(projectId);
  if (!proj) throw Object.assign(new Error("Project not found."), { code: "project_not_found" });
  const workOrders = require("./work-orders");
  const buildWos = await workOrders.listBuildWosForProject(projectId);

  const totalTasks = (proj.tasks || []).length;
  const doneTasks = (proj.tasks || []).filter((t) => t.status === "done").length;
  // Partial-aware progress: average each task's completion so a half-finished
  // task moves the bar, not only fully-done ones. done reads as 100 even on
  // legacy records that predate percentComplete. doneTasks is kept for the
  // "X of Y tasks" label.
  const taskPct = (t) => (t.status === "done" ? 100 : (Number(t.percentComplete) || 0));
  const percentComplete = totalTasks > 0
    ? Math.round((proj.tasks || []).reduce((sum, t) => sum + taskPct(t), 0) / totalTasks)
    : 0;

  let totalPersonHours = 0;
  let photoCount = 0;
  let daysLogged = 0;
  let lastWorkDate = null;

  for (const wo of buildWos) {
    const dl = wo.dailyLog || {};
    const sessions = Array.isArray(dl.sessions) ? dl.sessions : [];
    if (sessions.length) {
      daysLogged += 1;
      if (dl.workDate && (!lastWorkDate || dl.workDate > lastWorkDate)) {
        lastWorkDate = dl.workDate;
      }
    }
    for (const s of sessions) {
      if (!s.inAt) continue;
      const outAt = s.outAt || new Date().toISOString(); // active sessions count up to now
      const ms = new Date(outAt) - new Date(s.inAt);
      if (Number.isFinite(ms) && ms > 0) {
        totalPersonHours += (ms / 3600000) * (Number(s.labourersOnSite) || 1);
      }
    }
    photoCount += Array.isArray(wo.photos) ? wo.photos.length : 0;
  }
  totalPersonHours = Math.round(totalPersonHours * 100) / 100;

  const pendingScopeChanges = (proj.scopeChangeRequests || []).filter(
    (s) => s.status === "pending_admin_review" || s.status === "pending_customer_approval"
  ).length;

  return {
    totalTasks, doneTasks, percentComplete,
    daysLogged, totalPersonHours,
    photoCount, pendingScopeChanges,
    lastWorkDate,
    buildWoIds: buildWos.map((w) => w.id)
  };
}

// T&M billing rollup. Deterministic — pure read of build WO daily logs +
// parts.json (caller passes partsCatalog) + project.labourRateLocked.
async function computeTAndMBilling(projectId, { partsCatalog = null } = {}) {
  const proj = await get(projectId);
  if (!proj) throw Object.assign(new Error("Project not found."), { code: "project_not_found" });
  if (proj.billingMode !== "time_and_material") {
    throw Object.assign(new Error("Project is not T&M."), { code: "wrong_billing_mode" });
  }
  if (!Number.isFinite(Number(proj.labourRateLocked)) || Number(proj.labourRateLocked) <= 0) {
    throw Object.assign(new Error("Project labour rate is not set."), { code: "missing_labour_rate" });
  }

  const workOrders = require("./work-orders");
  const buildWos = await workOrders.listBuildWosForProject(projectId);

  // Labour: sum across all sessions of (hours × labourers).
  let totalHours = 0;
  for (const wo of buildWos) {
    const sessions = wo.dailyLog?.sessions || [];
    for (const s of sessions) {
      if (!s.inAt || !s.outAt) continue; // skip open sessions in billing
      const ms = new Date(s.outAt) - new Date(s.inAt);
      if (Number.isFinite(ms) && ms > 0) {
        totalHours += (ms / 3600000) * (Number(s.labourersOnSite) || 1);
      }
    }
  }
  totalHours = Math.round(totalHours * 100) / 100;
  const rate = Number(proj.labourRateLocked);

  const lineItems = [];
  const labourLineTotal = Math.round(totalHours * rate * 100) / 100;
  if (totalHours > 0) {
    lineItems.push({
      source: "labour",
      label: `Project labour — ${totalHours} hrs × $${rate.toFixed(2)}/hr`,
      qty: totalHours,
      price: rate,
      lineTotal: labourLineTotal
    });
  }

  // Materials: group by SKU, look up parts.json for label + retail price.
  const skuTotals = new Map();
  for (const wo of buildWos) {
    const mats = wo.dailyLog?.materialsConsumed || [];
    for (const m of mats) {
      const sku = String(m.partSku || "");
      if (!sku) continue;
      const qty = Number(m.qty) || 0;
      skuTotals.set(sku, (skuTotals.get(sku) || 0) + qty);
    }
  }
  // Deterministic order — sort SKUs alphabetically so re-runs produce
  // identical line item lists.
  const sortedSkus = [...skuTotals.keys()].sort();
  const unknownSkus = [];
  for (const sku of sortedSkus) {
    const qty = skuTotals.get(sku);
    const part = partsCatalog?.parts?.[sku] || partsCatalog?.[sku];
    // parts.json shape (spec §1.2): { sku, partNumber, category,
    // subcategory, size, description, priceCents, unit }. The earlier
    // implementation looked for `retail_price`/`retailPrice`/`price`
    // — those don't exist on PJL's catalog entries, so every consumed
    // SKU got flagged as "unknown" and billing refused to compute.
    // Use priceCents/100 first; the dollar-field fallbacks remain so a
    // future catalog with dollar pricing still works.
    const label = (part?.description
      ? part.description + (part.size ? ` (${part.size})` : "")
      : part?.label || part?.name || sku);
    let unitPrice = null;
    if (Number.isFinite(Number(part?.priceCents))) unitPrice = Number(part.priceCents) / 100;
    else if (Number.isFinite(Number(part?.retail_price))) unitPrice = Number(part.retail_price);
    else if (Number.isFinite(Number(part?.retailPrice))) unitPrice = Number(part.retailPrice);
    else if (Number.isFinite(Number(part?.price))) unitPrice = Number(part.price);
    if (unitPrice == null || unitPrice < 0) {
      unknownSkus.push(sku);
      continue;
    }
    const lineTotal = Math.round(unitPrice * qty * 100) / 100;
    lineItems.push({
      source: "material",
      sourceKey: sku,
      label: `${label} × ${qty}`,
      qty,
      price: unitPrice,
      lineTotal
    });
  }

  let subtotal = 0;
  for (const li of lineItems) subtotal += Number(li.lineTotal) || 0;
  subtotal = Math.round(subtotal * 100) / 100;
  const hst = Math.round(subtotal * 0.13 * 100) / 100;
  const total = Math.round((subtotal + hst) * 100) / 100;

  return {
    lineItems,
    subtotal,
    hst,
    total,
    totalHours,
    rate,
    unknownSkus
  };
}

// ---- Brief 2: Scope changes ---------------------------------------

const SCR_STATUSES = [
  "pending_admin_review",
  "pending_customer_approval",
  "approved",
  "rejected",
  "withdrawn",
  "executed_under_revision"
];

async function createScopeChangeRequest(projectId, fields, { by = "admin" } = {}) {
  const description = String(fields?.description || "").trim();
  if (!description) {
    throw Object.assign(new Error("Description is required."), { code: "missing_description" });
  }
  const suggestedLineItems = Array.isArray(fields?.suggestedLineItems)
    ? fields.suggestedLineItems.map((li) => ({
        source: ["pricing", "project_rates", "custom"].includes(li?.source) ? li.source : "custom",
        sourceKey: li?.sourceKey || null,
        label: String(li?.label || "").slice(0, 400),
        unit: typeof li?.unit === "string" ? li.unit.slice(0, 40) : "",
        qty: Number(li?.qty) || 1,
        price: Number(li?.price) || 0,
        lineTotal: Math.round(((Number(li?.qty) || 1) * (Number(li?.price) || 0)) * 100) / 100
      }))
    : [];
  const estimatedTotal = suggestedLineItems.reduce((sum, li) => sum + (Number(li.lineTotal) || 0), 0);

  return _mutate(projectId, (proj) => {
    const scr = {
      id: "scr_" + random8(),
      description: description.slice(0, 4000),
      capturedBy: by,
      capturedAt: nowIso(),
      capturedFromWoId: fields?.capturedFromWoId || null,
      photoIds: Array.isArray(fields?.photoIds) ? fields.photoIds.filter((x) => typeof x === "string") : [],
      suggestedLineItems,
      estimatedTotal: Math.round(estimatedTotal * 100) / 100,
      draftEmail: _buildScopeChangeDraftEmail(proj, description, suggestedLineItems, estimatedTotal),
      status: "pending_admin_review",
      sentAt: null,
      resolvedAt: null,
      resolvedAs: null,
      resolutionNote: null,
      linkedRevisionQuoteId: null
    };
    proj.scopeChangeRequests = [...(proj.scopeChangeRequests || []), scr];
    appendHistory(proj, { action: "scope_change_captured", by, note: `${scr.id} — ${description.slice(0, 80)}` });
    return scr;
  });
}

function _buildScopeChangeDraftEmail(proj, description, lineItems, estimatedTotal) {
  const projectName = proj.name || proj.id;
  const itemRows = lineItems.map((li) =>
    `  • ${li.label} × ${li.qty} @ $${Number(li.price).toFixed(2)} = $${Number(li.lineTotal).toFixed(2)}`
  ).join("\n");
  return {
    to: proj.customerEmail || "",
    subject: `Scope addition — ${projectName}`,
    body: `Hi,\n\nWhile working on the ${projectName} project we noted the following addition:\n\n${description}\n\nProposed pricing:\n${itemRows || "  (no line items)"}\n\nEstimated total: $${estimatedTotal.toFixed(2)} CAD before HST.\n\nLet us know if you'd like us to proceed. We'll send a revised quote for your signature once approved.\n\nThanks,\nPatrick\nPJL Land Services`
  };
}

async function updateScopeChangeRequest(projectId, scrId, patch, { by = "admin" } = {}) {
  return _mutate(projectId, (proj) => {
    const scr = (proj.scopeChangeRequests || []).find((s) => s.id === scrId);
    if (!scr) throw Object.assign(new Error("Scope change not found."), { code: "scr_not_found" });
    if (scr.status !== "pending_admin_review") {
      throw Object.assign(new Error(`Scope change is ${scr.status} — can't edit.`), { code: "scr_locked" });
    }
    if (typeof patch.description === "string") scr.description = patch.description.slice(0, 4000);
    if (Array.isArray(patch.suggestedLineItems)) {
      scr.suggestedLineItems = patch.suggestedLineItems.map((li) => ({
        source: ["pricing", "project_rates", "custom"].includes(li?.source) ? li.source : "custom",
        sourceKey: li?.sourceKey || null,
        label: String(li?.label || "").slice(0, 400),
        unit: typeof li?.unit === "string" ? li.unit.slice(0, 40) : "",
        qty: Number(li?.qty) || 1,
        price: Number(li?.price) || 0,
        lineTotal: Math.round(((Number(li?.qty) || 1) * (Number(li?.price) || 0)) * 100) / 100
      }));
      scr.estimatedTotal = Math.round(
        scr.suggestedLineItems.reduce((sum, li) => sum + (Number(li.lineTotal) || 0), 0) * 100
      ) / 100;
    }
    if (patch.draftEmail && typeof patch.draftEmail === "object") {
      scr.draftEmail = {
        to: String(patch.draftEmail.to || scr.draftEmail.to).slice(0, 254),
        subject: String(patch.draftEmail.subject || scr.draftEmail.subject).slice(0, 200),
        body: String(patch.draftEmail.body || scr.draftEmail.body).slice(0, 10000)
      };
    }
    appendHistory(proj, { action: "scope_change_updated", by, note: scrId });
    return scr;
  });
}

async function sendScopeChangeRequest(projectId, scrId, { by = "admin" } = {}) {
  return _mutate(projectId, (proj) => {
    const scr = (proj.scopeChangeRequests || []).find((s) => s.id === scrId);
    if (!scr) throw Object.assign(new Error("Scope change not found."), { code: "scr_not_found" });
    if (scr.status !== "pending_admin_review") {
      throw Object.assign(new Error(`Scope change is already ${scr.status}.`), { code: "scr_wrong_state" });
    }
    scr.status = "pending_customer_approval";
    scr.sentAt = nowIso();
    appendHistory(proj, { action: "scope_change_sent", by, note: scrId });
    return scr;
  });
}

async function resolveScopeChangeRequest(projectId, scrId, { resolution, note = "" }, { by = "admin" } = {}) {
  if (!["approved", "rejected", "withdrawn"].includes(resolution)) {
    throw Object.assign(new Error(`Unknown resolution: ${resolution}`), { code: "bad_resolution" });
  }
  return _mutate(projectId, (proj) => {
    const scr = (proj.scopeChangeRequests || []).find((s) => s.id === scrId);
    if (!scr) throw Object.assign(new Error("Scope change not found."), { code: "scr_not_found" });
    if (scr.status === "approved" || scr.status === "rejected" || scr.status === "withdrawn" || scr.status === "executed_under_revision") {
      throw Object.assign(new Error(`Scope change is already ${scr.status}.`), { code: "scr_already_resolved" });
    }
    scr.status = resolution;
    scr.resolvedAt = nowIso();
    scr.resolvedAs = resolution === "approved" ? "approved_by_customer"
      : resolution === "rejected" ? "rejected_by_customer"
      : "withdrawn_by_admin";
    scr.resolutionNote = String(note || "").slice(0, 2000);
    appendHistory(proj, { action: `scope_change_${resolution}`, by, note: scrId });
    return scr;
  });
}

// Generate a Q-vN revision from an approved scope change. Calls
// quotes.createRevision and seeds the new revision with the original
// line items + the SCR's suggested line items, then flips the SCR to
// executed_under_revision. Caller is responsible for sending the
// revision to the customer for signature.
async function generateQuoteRevisionFromScopeChange(projectId, scrId, { by = "admin" } = {}) {
  const proj = await get(projectId);
  if (!proj) throw Object.assign(new Error("Project not found."), { code: "project_not_found" });
  const scr = (proj.scopeChangeRequests || []).find((s) => s.id === scrId);
  if (!scr) throw Object.assign(new Error("Scope change not found."), { code: "scr_not_found" });
  if (scr.status !== "approved") {
    throw Object.assign(new Error("Scope change must be approved before revision."), { code: "scr_not_approved" });
  }
  if (!proj.sourceQuoteId) {
    throw Object.assign(new Error("Project has no source quote to revise."), { code: "no_source_quote" });
  }

  const quotes = require("./quotes");
  const revision = await quotes.createRevision(proj.sourceQuoteId, {
    by,
    note: `Revision from scope change ${scrId}`
  });

  // Append the SCR's suggested line items to the revision's lineItems.
  const newLines = [
    ...(revision.lineItems || []),
    ...(scr.suggestedLineItems || []).map((li) => quotes.normalizeProposalLineItem(li))
  ];
  await quotes.updateProposal(revision.id, { lineItems: newLines }, {
    by, note: `Scope-change additions from ${scrId}`
  });

  // Mark SCR as executed_under_revision.
  await _mutate(projectId, (p) => {
    const s = (p.scopeChangeRequests || []).find((x) => x.id === scrId);
    if (s) {
      s.status = "executed_under_revision";
      s.linkedRevisionQuoteId = revision.id;
      appendHistory(p, { action: "scope_change_executed", by, note: `${scrId} → ${revision.id}` });
    }
  });

  return revision;
}

// ---- Brief 2: Status updates --------------------------------------

async function generateStatusUpdate(projectId, { recipient, preamble = "" }, { by = "admin", metrics = null, recentPhotos = null } = {}) {
  return _mutate(projectId, async (proj) => {
    const m = metrics || (await computeProjectMetrics(projectId));

    // Recent completed tasks (up to 5).
    const recentTasks = (proj.tasks || [])
      .filter((t) => t.status === "done" && t.completedAt)
      .sort((a, b) => String(b.completedAt).localeCompare(String(a.completedAt)))
      .slice(0, 5);

    // Upcoming pending tasks (up to 3).
    const upcoming = (proj.tasks || [])
      .filter((t) => t.status === "pending")
      .sort((a, b) => (a.order || 0) - (b.order || 0))
      .slice(0, 3);

    const pendingScrs = (proj.scopeChangeRequests || []).filter(
      (s) => s.status === "pending_admin_review" || s.status === "pending_customer_approval"
    );

    // Recent photos (4-6) for the email's photo strip per Brief §3.5.
    const photos = recentPhotos || (await listRecentProjectPhotos(projectId, { limit: 6 }));

    const snapshot = {
      projectName: proj.name || proj.id,
      projectId: proj.id,
      customerName: proj.customerName,
      propertyAddress: proj.address,
      percentComplete: m.percentComplete,
      doneTasks: m.doneTasks,
      totalTasks: m.totalTasks,
      daysLogged: m.daysLogged,
      totalPersonHours: m.totalPersonHours,
      photoCount: m.photoCount,
      lastWorkDate: m.lastWorkDate,
      recentTasks: recentTasks.map((t) => ({
        description: t.description,
        completedAt: t.completedAt
      })),
      upcoming: upcoming.map((t) => ({ description: t.description })),
      pendingScopeChanges: pendingScrs.map((s) => ({
        description: s.description,
        status: s.status,
        sentAt: s.sentAt
      })),
      recentPhotos: photos.map((p) => ({
        woId: p.woId,
        n: p.n,
        addedAt: p.addedAt
      })),
      preamble: String(preamble || "").slice(0, 4000),
      generatedAt: nowIso()
    };

    const entry = {
      id: "su_" + random8(),
      generatedAt: snapshot.generatedAt,
      generatedBy: by,
      recipient: {
        email: String(recipient?.email || "").trim().toLowerCase(),
        name: recipient?.name ? String(recipient.name).slice(0, 200) : null
      },
      deliveryMethod: "email",
      snapshot,
      note: null
    };
    proj.statusUpdates = [...(proj.statusUpdates || []), entry];
    appendHistory(proj, { action: "status_update_sent", by, note: `${entry.id} → ${entry.recipient.email}` });
    return entry;
  });
}

// ---- Brief 2: Final WO + project completion ----------------------

async function markFinalWo(projectId, woId, { by = "admin" } = {}) {
  return _mutate(projectId, (proj) => {
    if (!Array.isArray(proj.workOrderIds) || !proj.workOrderIds.includes(woId)) {
      throw Object.assign(new Error("WO not attached to this project."), { code: "wo_not_attached" });
    }
    proj.finalWoId = woId;
    appendHistory(proj, { action: "final_wo_marked", by, note: woId });
    return { finalWoId: woId };
  });
}

// Returns a preflight check object — what's blocking completion and
// what's a warning. Caller (UI) decides whether to allow override.
async function completionPreflight(projectId) {
  const proj = await get(projectId);
  if (!proj) throw Object.assign(new Error("Project not found."), { code: "project_not_found" });
  const workOrders = require("./work-orders");

  const checks = { blockers: [], warnings: [], okayed: [] };

  // Final WO selected?
  if (!proj.finalWoId) {
    checks.warnings.push({ key: "no_final_wo", message: "No final WO selected — most recent build WO will be used." });
  } else {
    const finalWo = await workOrders.get(proj.finalWoId);
    if (!finalWo) {
      checks.blockers.push({ key: "final_wo_missing", message: `Final WO ${proj.finalWoId} not found.` });
    } else if (!finalWo.signature?.signed && !finalWo.signatureBypass) {
      checks.warnings.push({
        key: "final_wo_unsigned",
        message: `Final WO ${finalWo.id} is not signed — customer hasn't accepted the closing visit.`
      });
    } else {
      checks.okayed.push({ key: "final_wo_signed", message: "Final WO signed." });
    }
  }

  // Tasks
  const pendingTasks = (proj.tasks || []).filter((t) => t.status !== "done").length;
  if (pendingTasks > 0) {
    checks.warnings.push({
      key: "tasks_pending",
      message: `${pendingTasks} task${pendingTasks === 1 ? "" : "s"} not yet marked done.`
    });
  } else {
    checks.okayed.push({ key: "tasks_done", message: "All tasks complete." });
  }

  // Scope changes
  const unresolvedScrs = (proj.scopeChangeRequests || []).filter(
    (s) => s.status === "pending_admin_review" || s.status === "pending_customer_approval"
  );
  if (unresolvedScrs.length > 0) {
    checks.blockers.push({
      key: "scope_changes_unresolved",
      message: `${unresolvedScrs.length} scope change request${unresolvedScrs.length === 1 ? "" : "s"} not yet resolved.`
    });
  }

  // Fixed-price + approved SCR without revision = blocker
  if (proj.billingMode === "fixed_price") {
    const approvedWithoutRevision = (proj.scopeChangeRequests || []).filter(
      (s) => s.status === "approved" && !s.linkedRevisionQuoteId
    );
    if (approvedWithoutRevision.length > 0) {
      checks.blockers.push({
        key: "approved_scr_no_revision",
        message: `${approvedWithoutRevision.length} approved scope change${approvedWithoutRevision.length === 1 ? "" : "s"} need a quote revision before billing (fixed-price).`
      });
    }
  }

  // T&M without locked rate = blocker
  if (proj.billingMode === "time_and_material") {
    if (!Number.isFinite(Number(proj.labourRateLocked)) || Number(proj.labourRateLocked) <= 0) {
      checks.blockers.push({
        key: "no_labour_rate",
        message: "T&M project has no locked labour rate set."
      });
    }
  }

  return checks;
}

// Run the project completion cascade. Idempotent — re-running returns
// the existing invoice ID with no duplicate side effects.
//
// The actual invoice generation + email sending + property service
// record creation is done by completion-cascade.js's
// runProjectFinalCascade(). This function is responsible for the
// project-side state machine: stamps + status flip + history.
async function completeProject(projectId, { by = "admin", allowOverride = false, attestationNote = "", deps = {} } = {}) {
  const proj = await get(projectId);
  if (!proj) throw Object.assign(new Error("Project not found."), { code: "project_not_found" });

  // Idempotent — return existing invoice if cascade already ran.
  if (proj.projectCompletionAt && proj.finalInvoiceId) {
    return { project: proj, invoiceId: proj.finalInvoiceId, alreadyComplete: true };
  }

  // Preflight gates.
  const checks = await completionPreflight(projectId);
  if (checks.blockers.length && !allowOverride) {
    const err = new Error(
      `Cannot complete project — ${checks.blockers.length} blocker${checks.blockers.length === 1 ? "" : "s"}: ` +
      checks.blockers.map((b) => b.message).join("; ")
    );
    err.code = "preflight_blockers";
    err.blockers = checks.blockers;
    err.warnings = checks.warnings;
    throw err;
  }

  // Delegate the actual invoice generation + emails + service record
  // to completion-cascade.js. That module is the long-standing home
  // for cascade side effects and stays the single source of truth.
  // Brief 2: deps.notifyAdmin / deps.notifyCustomer forwarded so the
  // route can wire up real email senders.
  const completionCascade = require("./completion-cascade");
  const cascadeResult = await completionCascade.runProjectFinalCascade(proj, { by, deps });

  // Update project state.
  return _mutate(projectId, (p) => {
    p.status = "complete";
    p.completedAt = nowIso();
    p.projectCompletionAt = nowIso();
    p.invoiceGeneratedAt = cascadeResult.invoiceId ? nowIso() : null;
    p.finalInvoiceId = cascadeResult.invoiceId || null;
    if (cascadeResult.propertyEditsApplied) p.propertyEditsAppliedAt = nowIso();
    appendHistory(p, {
      action: "project_completed",
      by,
      note: `invoice=${cascadeResult.invoiceId || "none"}${allowOverride ? " (override)" : ""}${attestationNote ? " — " + attestationNote.slice(0, 200) : ""}`
    });
    return { project: p, invoiceId: cascadeResult.invoiceId, cascade: cascadeResult };
  });
}

module.exports = {
  STATUSES,
  BRANCHES,
  BILLING_MODES,
  TASK_STATUSES,
  SCR_STATUSES,
  list,
  get,
  create,
  createFromProposal,
  buildCustomerSnapshot,
  update,
  attachWorkOrder,
  detachWorkOrder,
  remove,
  listByWorkOrder,
  // Brief 2 — task ops
  seedTasksFromQuote,
  addTask,
  updateTask,
  removeTask,
  markTaskComplete,
  unmarkTaskComplete,
  addTaskProgress,
  // Brief 2 — metrics & billing
  computeProjectMetrics,
  computeTAndMBilling,
  listTaskPhotos,
  listRecentProjectPhotos,
  // Brief 2 — scope changes
  createScopeChangeRequest,
  updateScopeChangeRequest,
  sendScopeChangeRequest,
  resolveScopeChangeRequest,
  generateQuoteRevisionFromScopeChange,
  // Brief 2 — status updates
  generateStatusUpdate,
  // Brief 2 — project completion
  markFinalWo,
  completionPreflight,
  completeProject
};
