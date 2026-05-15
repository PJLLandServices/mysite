// Bulk admin operations — shared dispatcher for /api/admin/bulk/:resource
// and the /admin/trash recovery flow.
//
// The brief (Session 2 — CRM Bulk Operations):
//   - one endpoint per resource, gated by requireAdmin() in server.js
//   - per-resource action whitelist enforced here (defence in depth — the
//     client UI also enforces but the server is the source of truth)
//   - soft-delete with 30-day Trash retention for: leads, properties,
//     work-orders, quotes, material-lists, purchase-orders
//   - archive (no auto-purge) for: properties, work-orders (completed),
//     suppliers (existing `archived: boolean`)
//   - status-change / resend for all
//   - every action writes one line to server/data/bulk-actions.log
//
// Leads have no lib module — server.js owns leads.json. The module wires
// up leads handlers via `attachLeadsHelpers(...)` so we don't reach into
// server.js internals from this file (and avoid the circular require that
// would create).

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");

const properties = require("./properties");
const workOrders = require("./work-orders");
const quotes = require("./quotes");
const invoices = require("./invoices");
const materialLists = require("./material-lists");
const suppliers = require("./suppliers");
const purchaseOrders = require("./purchase-orders");

const DATA_DIR = path.join(__dirname, "..", "data");
const AUDIT_LOG_FILE = path.join(DATA_DIR, "bulk-actions.log");
const AUDIT_LOG_ROTATE_BYTES = 5 * 1024 * 1024;

// Cap on the number of records a single request can act on. The frontend
// chunks larger selections; the server REFUSES anything past the cap so a
// malformed request can't OOM the process.
const MAX_IDS_PER_REQUEST = 500;

// 30-day Trash retention before nightly purge hard-deletes the records.
const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// Per-resource action whitelist. NEVER trust the client — every dispatch
// validates resource × action against this map. An unlisted combination
// returns 400 with "action-not-allowed". Frontend-only restrictions
// (button visibility) are convenience, not security.
//
// Resources that support soft-delete (deletedAt + Trash) get `delete` and
// the trash verbs (`restore`, `purge`). Resources that only support
// status-change / archive omit `delete`.
const ACTION_WHITELIST = {
  leads:             ["delete", "dismiss", "change-stage", "tag", "restore", "purge"],
  properties:        ["delete", "archive", "unarchive", "restore", "purge"],
  "work-orders":     ["change-status", "archive", "unarchive", "delete-drafts", "restore", "purge"],
  quotes:            ["expire", "delete-drafts", "restore", "purge"],
  invoices:          ["change-status", "resend"],   // no delete — accounting / QB ledger
  "material-lists":  ["delete", "change-status", "restore", "purge"],
  suppliers:         ["archive", "unarchive"],       // no delete — referenced by parts.json
  "purchase-orders": ["change-status", "resend", "delete-drafts", "restore", "purge"]
};

const VALID_RESOURCES = Object.keys(ACTION_WHITELIST);

// Leads handlers come from server.js (leads have no lib module). Wired at
// boot via attachLeadsHelpers(). Each handler is async (id, payload?) and
// either returns or throws (the error message lands in the per-id failure
// row in the response).
let leadsHelpers = null;

function attachLeadsHelpers(helpers) {
  leadsHelpers = helpers;
}

function assertLeadsAttached() {
  if (!leadsHelpers) throw new Error("bulk-actions: leads helpers not attached (server boot bug)");
}

// ---- Validation ------------------------------------------------------

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "ValidationError";
  }
}

function validateBulkRequest({ resource, action, ids }) {
  if (!VALID_RESOURCES.includes(resource)) {
    throw new ValidationError(`Unknown resource: ${resource}`);
  }
  if (!ACTION_WHITELIST[resource].includes(action)) {
    throw new ValidationError(`Action "${action}" is not allowed for resource "${resource}".`);
  }
  if (!Array.isArray(ids)) {
    throw new ValidationError("ids must be an array.");
  }
  if (ids.length === 0) {
    throw new ValidationError("ids array is empty.");
  }
  if (ids.length > MAX_IDS_PER_REQUEST) {
    throw new ValidationError(`Cannot process more than ${MAX_IDS_PER_REQUEST} ids in one request.`);
  }
  // Deduplicate while preserving order — handles UI bugs that double-submit.
  const seen = new Set();
  const cleaned = [];
  for (const raw of ids) {
    const id = typeof raw === "string" ? raw.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    cleaned.push(id);
  }
  if (!cleaned.length) {
    throw new ValidationError("ids array contains no usable values.");
  }
  return cleaned;
}

// ---- Per-resource action handlers ------------------------------------
//
// Each handler is async (id, payload?). Throwing puts the id in failedIds
// with the error message as the reason. Returning marks it succeeded.

function getHandler(resource, action) {
  // Leads — wired at boot via attachLeadsHelpers.
  if (resource === "leads") {
    assertLeadsAttached();
    switch (action) {
      case "delete":
        return (id) => leadsHelpers.softDelete(id);
      case "dismiss":
        return (id) => leadsHelpers.updateCrm(id, { status: "lost" });
      case "change-stage":
        return (id, payload) => {
          const stage = payload && typeof payload.newStatus === "string" ? payload.newStatus : null;
          if (!stage) throw new Error("newStatus is required for change-stage");
          return leadsHelpers.updateCrm(id, { status: stage });
        };
      case "tag":
        return (id, payload) => {
          const tag = payload && typeof payload.tag === "string" ? payload.tag : null;
          if (tag === "bot-spam") return leadsHelpers.updateCrm(id, { botFlagged: true });
          throw new Error(`Unknown tag: ${tag}`);
        };
      case "restore":
        return (id) => leadsHelpers.restore(id);
      case "purge":
        return (id) => leadsHelpers.hardDelete(id);
    }
  }

  if (resource === "properties") {
    switch (action) {
      case "delete":    return (id) => properties.softDelete(id);
      case "archive":   return (id) => properties.softArchive(id);
      case "unarchive":
      case "restore":   return (id) => properties.restore(id);
      case "purge":     return async (id) => {
        const rec = await properties.get(id);
        if (!rec) throw new Error("Not found");
        await properties.remove(id);
        return rec;
      };
    }
  }

  if (resource === "work-orders") {
    switch (action) {
      case "delete-drafts":
        // Per brief: only drafts can be soft-deleted. Gate enforced here so
        // a single failed id doesn't abort the batch.
        return async (id) => {
          const wo = await workOrders.get(id);
          if (!wo) throw new Error("Work order not found");
          if (wo.status && wo.status !== "draft") {
            throw new Error(`Only draft work orders can be deleted (this one is "${wo.status}")`);
          }
          if (wo.signature && wo.signature.signed) {
            throw new Error("Cannot delete a signed work order");
          }
          return workOrders.softDelete(id);
        };
      case "archive":
        // Per brief: only completed WOs can be archived (active WOs stay
        // on the main list). Status "completed" OR signed → archivable.
        return async (id) => {
          const wo = await workOrders.get(id);
          if (!wo) throw new Error("Work order not found");
          const isCompleted = wo.status === "completed" || (wo.signature && wo.signature.signed);
          if (!isCompleted) throw new Error("Only completed work orders can be archived");
          return workOrders.softArchive(id);
        };
      case "unarchive":
      case "restore":
        return (id) => workOrders.restore(id);
      case "change-status":
        return async (id, payload) => {
          const newStatus = payload && typeof payload.newStatus === "string" ? payload.newStatus : null;
          if (!newStatus) throw new Error("newStatus is required");
          const wo = await workOrders.get(id);
          if (!wo) throw new Error("Work order not found");
          // Refuse status changes on signed (locked) WOs — they're contractual.
          if (wo.locked) throw new Error("Signed work orders are locked");
          return workOrders.update(id, { status: newStatus });
        };
      case "purge":
        return async (id) => {
          const rec = await workOrders.get(id);
          if (!rec) throw new Error("Not found");
          await workOrders.remove(id);
          return rec;
        };
    }
  }

  if (resource === "quotes") {
    switch (action) {
      case "delete-drafts":
        return async (id) => {
          const q = await quotes.get(id);
          if (!q) throw new Error("Quote not found");
          if (q.status !== "draft" && q.status !== "expired") {
            throw new Error(`Only draft or expired quotes can be deleted (this one is "${q.status}")`);
          }
          return quotes.softDelete(id);
        };
      case "expire":
        return async (id) => {
          const q = await quotes.get(id);
          if (!q) throw new Error("Quote not found");
          if (q.status !== "sent") {
            throw new Error(`Only sent quotes can be expired (this one is "${q.status}")`);
          }
          return quotes.expire(id);
        };
      case "restore":
        return (id) => quotes.restore(id);
      case "purge":
        return async (id) => {
          const rec = await quotes.get(id);
          if (!rec) throw new Error("Not found");
          await quotes.remove(id);
          return rec;
        };
    }
  }

  if (resource === "invoices") {
    switch (action) {
      case "change-status":
        return async (id, payload) => {
          const newStatus = payload && typeof payload.newStatus === "string" ? payload.newStatus : null;
          if (!newStatus) throw new Error("newStatus is required");
          const inv = await invoices.get(id);
          if (!inv) throw new Error("Invoice not found");
          if (inv.status === "paid") throw new Error("Cannot change status of a paid invoice");
          if (inv.status === "void") throw new Error("Cannot change status of a void invoice");
          // Only allow forward transitions admin can reasonably bulk: draft → sent
          if (!(inv.status === "draft" && newStatus === "sent")) {
            throw new Error(`Bulk change-status only supports draft → sent (you asked for "${inv.status}" → "${newStatus}")`);
          }
          return invoices.update(id, { status: newStatus, sentAt: new Date().toISOString() });
        };
      case "resend":
        // Bulk-resend records the intent on each invoice; the actual email
        // is fired by the caller (server.js endpoint that integrates with
        // notify-customer.js). This handler just appends a history entry.
        return async (id) => {
          const inv = await invoices.get(id);
          if (!inv) throw new Error("Invoice not found");
          if (inv.status !== "sent") throw new Error("Only sent invoices can be re-sent");
          await invoices.appendHistory(id, { action: "resent", by: "admin", note: "bulk resend" });
          return inv;
        };
    }
  }

  if (resource === "material-lists") {
    switch (action) {
      case "delete":
        return (id) => materialLists.softDelete(id);
      case "change-status":
        return async (id, payload) => {
          const newStatus = payload && typeof payload.newStatus === "string" ? payload.newStatus : null;
          if (!newStatus) throw new Error("newStatus is required");
          return materialLists.update(id, { status: newStatus });
        };
      case "restore":
        return (id) => materialLists.restore(id);
      case "purge":
        return async (id) => {
          const rec = await materialLists.get(id);
          if (!rec) throw new Error("Not found");
          await materialLists.remove(id);
          return rec;
        };
    }
  }

  if (resource === "suppliers") {
    switch (action) {
      case "archive":   return (id) => suppliers.setArchived(id, true);
      case "unarchive": return (id) => suppliers.setArchived(id, false);
    }
  }

  if (resource === "purchase-orders") {
    switch (action) {
      case "delete-drafts":
        return async (id) => {
          const po = await purchaseOrders.get(id);
          if (!po) throw new Error("PO not found");
          if (po.status !== "draft") {
            throw new Error(`Only draft POs can be deleted (this one is "${po.status}")`);
          }
          return purchaseOrders.softDelete(id);
        };
      case "change-status":
        return async (id, payload) => {
          const newStatus = payload && typeof payload.newStatus === "string" ? payload.newStatus : null;
          if (!newStatus) throw new Error("newStatus is required");
          return purchaseOrders.update(id, { status: newStatus });
        };
      case "resend":
        return async (id) => {
          const po = await purchaseOrders.get(id);
          if (!po) throw new Error("PO not found");
          return purchaseOrders.markResent(id, { toEmail: po.supplierEmail, toName: po.supplierName });
        };
      case "restore":
        return (id) => purchaseOrders.restore(id);
      case "purge":
        return async (id) => {
          const rec = await purchaseOrders.get(id);
          if (!rec) throw new Error("Not found");
          await purchaseOrders.remove(id);
          return rec;
        };
    }
  }

  return null;
}

// ---- Audit log -------------------------------------------------------
//
// Format: pipe-delimited so a future log-parser can tokenize. Schema:
//   <iso-ts> | <session> | <resource> | <action> | <count> | <ids> | <result>
//
// `session` is the first 8 chars of the admin user id (NOT the password)
// so the audit trail is correlatable without exposing credentials. The
// nightly purge passes "system" instead.
//
// `ids` truncated at 500 chars so a 500-id batch doesn't bloat the log
// line beyond reason.
//
// `result` is one of: "success", "partial:<n>-failed", "rejected:<reason>".
//
// The log is opaque to the rest of the system — only read for audit; never
// surfaced via any API.

async function ensureDataDir() {
  await fs.mkdir(DATA_DIR, { recursive: true });
}

async function rotateLogIfNeeded() {
  try {
    const stat = await fs.stat(AUDIT_LOG_FILE);
    if (stat.size < AUDIT_LOG_ROTATE_BYTES) return;
    const rotated = AUDIT_LOG_FILE + ".1";
    // Best-effort rename — if a previous .1 exists, overwrite it. We keep
    // only one historical file; older history would need explicit archival.
    try { await fs.unlink(rotated); } catch {}
    await fs.rename(AUDIT_LOG_FILE, rotated);
  } catch {
    // File doesn't exist yet — nothing to rotate.
  }
}

function shortSession(session) {
  if (!session) return "anon";
  const uid = session.uid || "";
  // First 8 chars of the user id is sufficient correlation without
  // exposing the actual cookie/secret. Single-admin install almost
  // always renders the same prefix; that's fine — the field is for
  // audit forensics, not access control.
  return "adminSess:" + uid.replace(/[^A-Za-z0-9]/g, "").slice(0, 8);
}

function joinIdsForLog(ids) {
  const joined = ids.join(",");
  if (joined.length <= 500) return joined;
  return joined.slice(0, 497) + "...";
}

async function writeAuditLine({ session, resource, action, succeededIds, failedIds, rejectionReason }) {
  try {
    await ensureDataDir();
    await rotateLogIfNeeded();
    const ts = new Date().toISOString();
    const sess = shortSession(session);
    const allIds = [...succeededIds, ...failedIds.map((f) => f.id)];
    const count = allIds.length;
    const idsField = joinIdsForLog(allIds);
    let result;
    if (rejectionReason) {
      result = `rejected:${rejectionReason}`;
    } else if (failedIds.length === 0) {
      result = "success";
    } else if (succeededIds.length === 0) {
      result = `failed:${failedIds.length}`;
    } else {
      result = `partial:${failedIds.length}-failed`;
    }
    const line = `${ts} | ${sess} | ${resource} | ${action} | ${count} | ${idsField} | ${result}\n`;
    await fs.appendFile(AUDIT_LOG_FILE, line, "utf8");
  } catch (err) {
    // Audit logging failure is non-fatal — log to console and continue.
    // The DB state is already committed by the time we get here.
    console.warn("[bulk-actions] audit log write failed:", err?.message);
  }
}

async function writeSystemAuditLine({ resource, action, count, result }) {
  try {
    await ensureDataDir();
    await rotateLogIfNeeded();
    const ts = new Date().toISOString();
    const line = `${ts} | system | ${resource} | ${action} | ${count} | (auto) | ${result}\n`;
    await fs.appendFile(AUDIT_LOG_FILE, line, "utf8");
  } catch (err) {
    console.warn("[bulk-actions] system audit log write failed:", err?.message);
  }
}

// ---- Dispatcher ------------------------------------------------------

async function handleBulkAction({ resource, action, ids, payload, session }) {
  let cleanedIds;
  try {
    cleanedIds = validateBulkRequest({ resource, action, ids });
  } catch (err) {
    if (err instanceof ValidationError) {
      await writeAuditLine({
        session,
        resource: resource || "(unknown)",
        action: action || "(unknown)",
        succeededIds: [],
        failedIds: [],
        rejectionReason: err.message.slice(0, 200)
      });
      return { ok: false, status: 400, error: err.message };
    }
    throw err;
  }

  const handler = getHandler(resource, action);
  if (!handler) {
    // Should not happen — the whitelist passed but no handler matched.
    // Treat as 500: the code is inconsistent.
    return { ok: false, status: 500, error: `No handler wired for ${resource}/${action}` };
  }

  const succeededIds = [];
  const failedIds = [];

  // Serial processing — each handler does a read-modify-write on the
  // resource's JSON file, so parallel runs would race. PJL's volume keeps
  // this fast enough (500 records × ~5ms ≈ 2.5s worst case).
  for (const id of cleanedIds) {
    try {
      await handler(id, payload);
      succeededIds.push(id);
    } catch (err) {
      failedIds.push({ id, reason: (err && err.message) || String(err) });
    }
  }

  await writeAuditLine({ session, resource, action, succeededIds, failedIds });

  return {
    ok: failedIds.length === 0,
    status: 200,
    resource,
    action,
    succeededIds,
    failedIds,
    message: formatMessage({ resource, action, succeededIds, failedIds })
  };
}

function formatMessage({ resource, action, succeededIds, failedIds }) {
  const n = succeededIds.length;
  const m = failedIds.length;
  const noun = resourceNoun(resource, n);
  const verb = pastTenseFor(action);
  if (m === 0) return `${n} ${noun} ${verb}.`;
  if (n === 0) return `0 of ${m + n} ${noun} ${verb}. ${m} failed.`;
  return `${n} of ${n + m} ${noun} ${verb}. ${m} failed.`;
}

function resourceNoun(resource, count) {
  const singular = {
    leads: "lead",
    properties: "property",
    "work-orders": "work order",
    quotes: "quote",
    invoices: "invoice",
    "material-lists": "material list",
    suppliers: "supplier",
    "purchase-orders": "purchase order"
  }[resource] || resource;
  if (count === 1) return singular;
  if (resource === "properties") return "properties";
  return singular + "s";
}

function pastTenseFor(action) {
  const map = {
    "delete": "moved to Trash",
    "delete-drafts": "moved to Trash",
    "dismiss": "dismissed",
    "change-stage": "updated",
    "change-status": "updated",
    "tag": "tagged",
    "archive": "archived",
    "unarchive": "unarchived",
    "restore": "restored",
    "purge": "permanently deleted",
    "expire": "expired",
    "resend": "resent"
  };
  return map[action] || action + "d";
}

// ---- Trash listing ---------------------------------------------------

async function listTrash(resource) {
  if (!VALID_RESOURCES.includes(resource)) {
    throw new ValidationError(`Unknown resource: ${resource}`);
  }
  if (resource === "leads") {
    assertLeadsAttached();
    return leadsHelpers.listDeleted();
  }
  if (resource === "properties") return properties.listDeleted();
  if (resource === "work-orders") return workOrders.listDeleted();
  if (resource === "quotes") return quotes.listDeleted();
  if (resource === "material-lists") return materialLists.listDeleted();
  if (resource === "purchase-orders") return purchaseOrders.listDeleted();
  // Suppliers & invoices have no Trash — archive-only / no-delete.
  return [];
}

async function listArchive(resource) {
  if (resource === "properties") return properties.listArchived();
  if (resource === "work-orders") return workOrders.listArchived();
  if (resource === "suppliers") {
    const all = await suppliers.list({ includeArchived: true });
    return all.filter((s) => s.archived);
  }
  return [];
}

// ---- Nightly purge ---------------------------------------------------
//
// Walks every soft-delete-aware resource and hard-removes records whose
// deletedAt is older than TRASH_RETENTION_MS. Invoked at boot AND on a
// daily setInterval from server.js. Logs one audit line per resource.

async function purgeAllExpired() {
  const results = {};
  for (const [resource, runner] of [
    ["leads",            () => leadsHelpers ? leadsHelpers.purgeDeleted({ olderThanMs: TRASH_RETENTION_MS }) : 0],
    ["properties",       () => properties.purgeDeleted({ olderThanMs: TRASH_RETENTION_MS })],
    ["work-orders",      () => workOrders.purgeDeleted({ olderThanMs: TRASH_RETENTION_MS })],
    ["quotes",           () => quotes.purgeDeleted({ olderThanMs: TRASH_RETENTION_MS })],
    ["material-lists",   () => materialLists.purgeDeleted({ olderThanMs: TRASH_RETENTION_MS })],
    ["purchase-orders",  () => purchaseOrders.purgeDeleted({ olderThanMs: TRASH_RETENTION_MS })]
  ]) {
    try {
      const purged = await runner();
      results[resource] = purged;
      if (purged > 0) {
        await writeSystemAuditLine({ resource, action: "purge-trash", count: purged, result: "success" });
      }
    } catch (err) {
      results[resource] = `error: ${err?.message || err}`;
      await writeSystemAuditLine({ resource, action: "purge-trash", count: 0, result: `error:${err?.message?.slice(0, 60) || "unknown"}` });
    }
  }
  return results;
}

module.exports = {
  ACTION_WHITELIST,
  VALID_RESOURCES,
  MAX_IDS_PER_REQUEST,
  TRASH_RETENTION_MS,
  attachLeadsHelpers,
  handleBulkAction,
  listTrash,
  listArchive,
  purgeAllExpired,
  ValidationError
};
