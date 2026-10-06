// Material Lists — the bill-of-materials document used everywhere PJL
// tracks parts: standalone (Phase 1), attached to a Project / Work Order
// / Quote (Phase 2), turned into one or more Purchase Orders by supplier
// (Phase 3).
//
// Design note: a material list is a LIVE planning estimate. Descriptions
// are never snapshotted (always looked up from parts.json at render), and a
// line's price is resolved LIVE from parts.json too — UNTIL the line's
// purchase order is SENT, at which point the price locks to the PO's
// snapshot, stored as `frozenPriceCents` on the line (see
// resolveLineUnitPriceCents + the send flip in server.js; cancel releases
// it back to live). The line stores
// `{ sku, qty, status, poId, frozenPriceCents, notes }`. parts.json stays
// the source of truth for everything not yet purchased — the same
// discipline the rest of the system uses for the catalog (see crm-parts.js).
//
// ID format: ML-YYYY-NNNN. Per-year counter, mirrors Q-YYYY-NNNN /
// I-YYYY-NNNN / BK-YYYY-NNNN for visual consistency in the admin.
//
// Status enum (whole list):
//   draft        — being built, not yet purchased
//   in_progress  — at least one PO has been emitted; some lines still "need"
//   complete     — every line is "have"; nothing outstanding
//   archived     — out of the default index; kept for retrieval/copy
//
// Line item status enum:
//   need         — outstanding; PO generation pulls these
//   ordered      — on a PO that's been sent (Phase 3 sets this; lineItem.poId backref)
//   have         — on the truck / installed; PO generation skips these
//
// Storage: server/data/material-lists.json. Same flat-file pattern;
// rotate to SQLite if list count crosses ~10,000.

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const partAlias = require("./part-alias");
const { withPurchasingLock, atomicWrite, assertNotHeld, holdFor, PurchasingError } = require("./purchasing-store");

const FILE = path.join(__dirname, "..", "data", "material-lists.json");

const STATUSES = ["draft", "in_progress", "complete", "archived"];
const LINE_STATUSES = ["need", "ordered", "have"];
const PARENT_TYPES = ["project", "work_order", "quote"];

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

function serialize(records) {
  return JSON.stringify(records, null, 2) + "\n";
}

// Temp file + rename: a crash mid-write can never leave half a file.
async function writeAll(records) {
  await ensureFile();
  await atomicWrite(FILE, serialize(records));
}

// The file exactly as stored — no hydrate, and a parse failure THROWS
// rather than reading as empty. purchasing.js changes only the lines a
// purchase order owns; every other record and line goes back byte-for-byte.
async function readRaw() {
  await ensureFile();
  const parsed = JSON.parse((await fs.readFile(FILE, "utf8")) || "[]");
  if (!Array.isArray(parsed)) throw new Error("material-lists.json is not a list");
  return parsed;
}

// ---- Helpers ---------------------------------------------------------

function nowIso() { return new Date().toISOString(); }

// Per-line stable id. The builder UI needs to track lines by something
// other than array index so add/remove operations don't reorder by accident.
function makeLineId() {
  return "li_" + crypto.randomBytes(6).toString("base64url");
}

function hydrateLine(line) {
  const sku = typeof line?.sku === "string" ? line.sku.trim() : "";
  const qty = Number(line?.qty);
  const safeQty = Number.isFinite(qty) && qty > 0 ? Math.floor(qty) : 1;
  const status = LINE_STATUSES.includes(line?.status) ? line.status : "need";
  // Price lock. null = live (resolve from parts.json at render — a material
  // list is a live planning estimate, not a snapshot). A non-null value is
  // the per-unit price stamped onto the line when its PO was SENT (see the
  // send flip in server.js, which copies the PO line's unitPriceCents — and
  // that was itself snapshotted from parts.json at PO-generate time, so the
  // list line and the PO can never disagree). Invariant: a "need" line is on
  // no PO by definition, so it is ALWAYS live — force null. That single rule
  // also releases the lock automatically when a cancelled PO flips a line
  // back to "need", or when the user toggles a received line back to need.
  // NB: null/undefined means "not locked" — guard before Number() because
  // Number(null) === 0 would otherwise read as "locked at $0".
  const rawFrozen = line?.frozenPriceCents;
  const frozenNum = Number(rawFrozen);
  const frozenPriceCents = status !== "need" && rawFrozen != null && Number.isFinite(frozenNum) && frozenNum >= 0
    ? Math.floor(frozenNum)
    : null;
  return {
    id: typeof line?.id === "string" && line.id ? line.id : makeLineId(),
    sku,
    qty: safeQty,
    status,
    poId: typeof line?.poId === "string" && line.poId ? line.poId : null,
    frozenPriceCents,
    notes: typeof line?.notes === "string" ? line.notes.slice(0, 500) : ""
  };
}

// ---- Retired part numbers (Patrick, 2026-10-05) -----------------------
//
// A duplicate catalog part merged into its canonical part is no longer a
// part, but a browser tab opened before the merge still has it and can
// send a line carrying the retired number. Every incoming line is passed
// through part-alias.canonical() on the way IN, so the list stores the
// canonical part — never "Unknown SKU".
//   * A line already stored with purchasing provenance is history and is
//     NEVER rewritten (it could not hold a retired number anyway: the
//     number was unreferenced when it was retired).
//   * If the save also carries a plain editable Need line for the canonical
//     part, the two become one line and their quantities add.
function canonicalizeIncomingLines(lines, storedLines = []) {
  if (!Array.isArray(lines)) return lines;
  const protectedIds = new Set((storedLines || []).map(hydrateLine).filter(isPurchasingProtected).map((l) => l.id));
  const plainNeed = (l) => l && (l.status == null || l.status === "need") && !l.poId && l.frozenPriceCents == null;
  const out = [];
  for (const line of lines) {
    const sku = typeof line?.sku === "string" ? line.sku.trim() : "";
    const to = partAlias.canonical(sku);
    if (!sku || to === sku || protectedIds.has(line.id)) { out.push(line); continue; }
    const rewritten = { ...line, sku: to };
    const twin = plainNeed(rewritten) ? out.find((l) => (typeof l?.sku === "string" ? l.sku.trim() : "") === to && plainNeed(l) && !protectedIds.has(l.id)) : null;
    if (twin) {
      twin.qty = Math.min(9999, (Math.floor(Number(twin.qty)) || 1) + (Math.floor(Number(rewritten.qty)) || 1));
      if (!twin.notes && rewritten.notes) twin.notes = rewritten.notes;
      continue;
    }
    out.push(rewritten);
  }
  return out;
}

function blankList() {
  const created = nowIso();
  return {
    id: "",
    name: "",
    status: "draft",

    // Parent linkage — Phase 1 leaves these null (standalone lists).
    // Phase 2 wires them when a list is built inside a project / WO / quote
    // editor. parentType + parentId are independent so deleting a parent
    // doesn't leave the list dangling — the index page detects "orphaned"
    // by parentId-not-found and shows a fix-up affordance.
    parentType: null,
    parentId: null,

    // Denormalized customer fields — copied from the parent record (when
    // attached) so the index can render "for Smith @ 123 Main St" without
    // a join. Standalone lists let the user type these directly so they're
    // still findable in retrieval.
    customerName: "",
    customerEmail: "",
    address: "",

    notes: "",
    lineItems: [],

    createdAt: created,
    updatedAt: created,
    createdBy: "admin",

    // Audit trail. Every status change + line mutation appends an entry.
    // Capped at 200 entries to bound JSON growth on long-lived lists.
    history: [
      { ts: created, action: "created", by: "admin", note: "" }
    ],

    // Bulk-operations soft state. NOTE: material-lists has a pre-existing
    // status="archived" that's part of its STATUSES enum and is independent
    // from this soft-delete flag. deletedAt = Trash (30-day purge); the
    // existing archived status remains as it was.
    deletedAt: null
  };
}

function hydrate(rec) {
  const base = blankList();
  const safeStatus = STATUSES.includes(rec?.status) ? rec.status : "draft";
  const safeParentType = PARENT_TYPES.includes(rec?.parentType) ? rec.parentType : null;
  return {
    ...base,
    ...rec,
    status: safeStatus,
    parentType: safeParentType,
    parentId: typeof rec?.parentId === "string" && rec.parentId ? rec.parentId : null,
    name: typeof rec?.name === "string" ? rec.name : "",
    customerName: typeof rec?.customerName === "string" ? rec.customerName : "",
    customerEmail: typeof rec?.customerEmail === "string" ? rec.customerEmail.toLowerCase() : "",
    address: typeof rec?.address === "string" ? rec.address : "",
    notes: typeof rec?.notes === "string" ? rec.notes : "",
    lineItems: Array.isArray(rec?.lineItems) ? rec.lineItems.map(hydrateLine) : [],
    history: Array.isArray(rec?.history) ? rec.history.slice(-200) : [],
    deletedAt: typeof rec?.deletedAt === "string" ? rec.deletedAt : null
  };
}

async function nextListId(year) {
  const records = await readAll();
  const prefix = `ML-${year}-`;
  let max = 0;
  for (const r of records) {
    if (typeof r.id === "string" && r.id.startsWith(prefix)) {
      const n = parseInt(r.id.slice(prefix.length), 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return `${prefix}${String(max + 1).padStart(4, "0")}`;
}

// Roll up the list's line items into a list-level status. Used after any
// line mutation so the index pill stays in sync with reality.
//   - all "have"        -> complete
//   - any "need"        -> draft  (nothing in flight yet)
//   - any "ordered"     -> in_progress
// archived is sticky — never auto-set/cleared by this rollup.
function deriveStatus(lineItems, currentStatus) {
  if (currentStatus === "archived") return "archived";
  if (!Array.isArray(lineItems) || lineItems.length === 0) return "draft";
  const hasNeed = lineItems.some((l) => l.status === "need");
  const hasOrdered = lineItems.some((l) => l.status === "ordered");
  if (!hasNeed && !hasOrdered) return "complete";
  if (hasOrdered) return "in_progress";
  return "draft";
}

function appendHistory(record, entry) {
  record.history = Array.isArray(record.history) ? record.history : [];
  record.history.push({ ts: nowIso(), by: "admin", note: "", ...entry });
  if (record.history.length > 200) record.history = record.history.slice(-200);
}

// ---- CRUD -----------------------------------------------------------

async function list({ status = null, parentType = null, parentId = null, includeArchived = false, includeDeleted = false } = {}) {
  const records = await readAll();
  return records.filter((r) => {
    if (!includeDeleted && r.deletedAt) return false;
    if (!includeArchived && r.status === "archived" && status !== "archived") return false;
    if (status && r.status !== status) return false;
    if (parentType && r.parentType !== parentType) return false;
    if (parentId && r.parentId !== parentId) return false;
    return true;
  });
}

async function get(id) {
  const records = await readAll();
  return records.find((r) => r.id === id) || null;
}

async function listByParent(parentType, parentId) {
  if (!PARENT_TYPES.includes(parentType) || !parentId) return [];
  return list({ parentType, parentId, includeArchived: true });
}

async function create({
  name = "",
  parentType = null,
  parentId = null,
  customerName = "",
  customerEmail = "",
  address = "",
  notes = "",
  lineItems = [],
  createdBy = "admin"
} = {}) {
  assertNotHeld({});   // only a hold on everything stops a new list
  const records = await readAll();
  const year = new Date().getUTCFullYear();
  const id = await nextListId(year);
  const rec = blankList();
  rec.id = id;
  rec.name = String(name || "").trim().slice(0, 200);
  rec.parentType = PARENT_TYPES.includes(parentType) ? parentType : null;
  rec.parentId = parentId && rec.parentType ? String(parentId) : null;
  rec.customerName = String(customerName || "").trim().slice(0, 200);
  rec.customerEmail = String(customerEmail || "").trim().toLowerCase().slice(0, 254);
  rec.address = String(address || "").trim().slice(0, 400);
  rec.notes = String(notes || "").slice(0, 4000);
  rec.createdBy = String(createdBy || "admin").slice(0, 80);
  rec.lineItems = Array.isArray(lineItems) ? canonicalizeIncomingLines(lineItems).map(hydrateLine) : [];
  rec.status = deriveStatus(rec.lineItems, rec.status);
  rec.history = [{ ts: nowIso(), action: "created", by: rec.createdBy, note: rec.name || "" }];
  records.unshift(rec);
  await writeAll(records);
  return rec;
}

// Full update — accepts top-level field patches and a wholesale lineItems
// replacement (the builder PATCHes the entire array). Status auto-derives
// from the line items unless the caller explicitly passes a status that's
// either "archived" or matches the derived value (lets the UI nudge an
// otherwise-complete list back to "draft" only via the archive flow).
// ONE definition of "these lines can no longer be replaced wholesale".
//
// Returns null when replacement is allowed, or { why, blockingSkus }
// when it is not. Exported so any future editing path — a route, a
// script, a re-sync — asks the same question rather than growing a
// second copy that drifts (CLAUDE.md).
//
// Two independent tests, because either alone can be wrong:
//   * the list's status is past draft, OR
//   * ANY existing line carries purchasing state, even if the status
//     still says draft — a status can be stale or set by hand, and the
//     lines are the actual evidence.
//
// ---- Line protection (Patrick, 2026-09-27 and 2026-10-03) ------------
//
// What makes a line protected is PURCHASING PROVENANCE, never the word
// "have" on its own: a line is protected when it is on a purchase order
// (`ordered`), or still carries a `poId` or a frozen purchase price. A
// line Patrick marked "have" by hand — stock already on the truck — is a
// planning status and stays fully editable (qty, notes, removal, back to
// need), and so does every "need" line.
//
// A protected line's purchasing-controlled fields are owned by the PO
// flow (purchasing.js, held to purchasingTransitionError below): sku,
// qty, status, poId, frozenPriceCents. The
// ordinary PATCH may echo them unchanged and may still edit the line's
// notes; it may not alter them, drop the line, or invent purchasing state
// on a line that has none. THE rule is this one function; update() asks
// it for every lineItems write that does not come through the PO door.
const PURCHASING_FIELDS = ["sku", "qty", "status", "poId", "frozenPriceCents"];
function isPurchasingProtected(line) {
  return !!line && (line.status === "ordered" || !!line.poId || line.frozenPriceCents != null);
}
function protectedLineViolations(current, patchLines) {
  const violations = [];
  const incoming = Array.isArray(patchLines) ? patchLines.map(hydrateLine) : [];
  const byId = new Map(incoming.map((l) => [l.id, l]));
  for (const stored of (current?.lineItems || []).map(hydrateLine)) {
    if (!isPurchasingProtected(stored)) continue;
    const sent = byId.get(stored.id);
    if (!sent) { violations.push({ id: stored.id, sku: stored.sku, what: "removed" }); continue; }
    const changed = PURCHASING_FIELDS.filter((k) => sent[k] !== stored[k]);
    if (changed.length) violations.push({ id: stored.id, sku: stored.sku, what: `changed ${changed.join(", ")}` });
    byId.delete(stored.id);
  }
  // Everything left is a new line or an unprotected stored line: it may
  // not carry purchasing state — only the PO flow sets that.
  for (const sent of byId.values()) {
    if (isPurchasingProtected(sent)) violations.push({ id: sent.id, sku: sent.sku, what: "purchasing state can only be set by a purchase order" });
  }
  return violations;
}

// What purchasing may do to a line, and nothing else (Patrick,
// 2026-10-03, from #375's PO door). THE transition rule: purchasing.js
// (planListMoves) checks every list-line move it is about to commit
// against it. Returns why a move is refused, or null.
//   need    → ordered  (send:    poId set, price frozen)
//   ordered → have     (receive: poId cleared, frozen price KEPT)
//   ordered → need     (cancel, or a receipt that still leaves some to
//                       order: poId cleared, price released)
// Anything else, or any change to another field, is refused.
function purchasingTransitionError(before, after) {
  const a = hydrateLine(before), b = hydrateLine(after);
  const same = (keys) => keys.every((k) => a[k] === b[k]);
  if (!same(["id", "sku", "qty", "notes"])) return `Purchasing may only change a line's status, PO and frozen price (${a.sku}).`;
  if (a.status === b.status) return same(["poId", "frozenPriceCents"]) ? null : `A line's PO and frozen price only change with its status (${a.sku}).`;
  const ok =
    (a.status === "need" && b.status === "ordered" && !!b.poId && b.frozenPriceCents != null) ||
    (a.status === "ordered" && b.status === "have" && b.poId === null && b.frozenPriceCents === a.frozenPriceCents) ||
    (a.status === "ordered" && b.status === "need" && b.poId === null && b.frozenPriceCents === null);
  return ok ? null : `Not a purchasing transition: ${a.sku} ${a.status} → ${b.status}.`;
}

// Purchase orders that bought — or may have emailed — against list lines
// (2026-10-03): every PO that isn't a draft, plus a draft whose send was
// interrupted. Their lines are the purchasing record, so the list and the
// lines they point at must outlive them: deleting one would leave a sent,
// received or cancelled order that belongs to no job (purchasing-audit
// source_missing). A plain draft points at nothing bought and doesn't
// count — deleting its list is fixing a mistake, and its send is refused.
// Returns listId -> [{ poId, poStatus, lineId, sku }].
async function purchasingClaims() {
  const pos = await require("./purchase-orders")._internal.readRaw();
  const out = new Map();
  for (const p of pos || []) {
    if (!p || p.deletedAt) continue;
    if ((p.status || "draft") === "draft" && !p.sendInFlight) continue;
    for (const l of p.lineItems || []) {
      if (!l || !l.sourceListId || !l.sourceLineId) continue;
      if (!out.has(l.sourceListId)) out.set(l.sourceListId, []);
      out.get(l.sourceListId).push({ poId: p.id, poStatus: p.status || "draft", lineId: l.sourceLineId, sku: l.sku || "" });
    }
  }
  return out;
}

function purchasingHistoryError(listId, claims, what, advice = "Archive the list instead, or detach it from the project.") {
  const pos = [...new Set(claims.map((c) => `${c.poId} (${c.poStatus})`))];
  return new PurchasingError(
    `Can't ${what} ${listId}: purchase order${pos.length === 1 ? "" : "s"} ${pos.slice(0, 5).join(", ")} ${pos.length === 1 ? "was" : "were"} placed for it, and ` +
    `that record has to stay with its job. ${advice}`,
    { status: 409, code: "purchasing_history" });
}

async function update(id, patch = {}) {
  const records = await readAll();
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  const current = records[idx];
  assertNotHeld({ materialLists: [current.id] });   // a recovery hold: read-only until the office releases it
  const next = { ...current };

  // Stale-write protection: a client that says which version it edited
  // is refused when the record has moved on (another tab, a PO flip).
  // Older clients that send nothing are served as before.
  if (typeof patch.baseUpdatedAt === "string" && patch.baseUpdatedAt && patch.baseUpdatedAt !== current.updatedAt) {
    throw Object.assign(
      new Error("This material list changed elsewhere. Your latest change wasn't saved. Reload to continue."),
      { code: "stale_list", updatedAt: current.updatedAt }
    );
  }

  const allowedTop = ["name", "customerName", "customerEmail", "address", "notes", "parentType", "parentId"];
  for (const key of allowedTop) {
    if (Object.prototype.hasOwnProperty.call(patch, key)) {
      if (key === "parentType") {
        next.parentType = PARENT_TYPES.includes(patch.parentType) ? patch.parentType : null;
      } else if (key === "parentId") {
        next.parentId = patch.parentId ? String(patch.parentId) : null;
      } else if (key === "customerEmail") {
        next.customerEmail = String(patch.customerEmail || "").trim().toLowerCase().slice(0, 254);
      } else if (key === "name") {
        next.name = String(patch.name || "").trim().slice(0, 200);
      } else if (key === "customerName") {
        next.customerName = String(patch.customerName || "").trim().slice(0, 200);
      } else if (key === "address") {
        next.address = String(patch.address || "").trim().slice(0, 400);
      } else if (key === "notes") {
        next.notes = String(patch.notes || "").slice(0, 4000);
      }
    }
  }

  let lineItemsChanged = false;
  // Retired part numbers resolve to their canonical part before anything
  // else looks at the lines (canonicalizeIncomingLines).
  if (Array.isArray(patch.lineItems)) patch = { ...patch, lineItems: canonicalizeIncomingLines(patch.lineItems, current.lineItems) };
  if (Array.isArray(patch.lineItems)) {
    // A lineItems write is the whole list, so it could silently drop a
    // line's `status`, `poId` and `frozenPriceCents` — the record that
    // something was ordered and the price that locked when the PO was
    // sent (the System Builder re-syncing its BOM onto a purchased list
    // was the original hole, 2026-09-27). The rule is line by line
    // (protectedLineViolations): purchased lines must come back exactly
    // as stored, everything else is the caller's to edit. Only the PO
    // flow (purchasing.js — it writes the list itself, never through
    // here) may move a line's purchasing state. A refused write changes
    // nothing.
    {
      const violations = protectedLineViolations(current, patch.lineItems);
      if (violations.length) {
        const blockingSkus = [...new Set(violations.map((v) => v.sku))];
        throw Object.assign(
          new Error(
            `Can't save the lines on ${current.id}: ${violations.length} purchased line${violations.length === 1 ? "" : "s"} would change (` +
            violations.slice(0, 5).map((v) => `${v.sku}: ${v.what}`).join("; ") +
            `). Lines on a purchase order are changed by the purchase order, not here.`
          ),
          { code: "line_items_locked", blockingSkus, violations }
        );
      }
    }
    next.lineItems = patch.lineItems.map(hydrateLine);
    // Never drop a line an order was placed for (2026-10-03) — even once
    // it's back to "need" (part arrived; the rest still to order), when the
    // test above no longer sees purchasing state on it.
    // Nor change what it is (its SKU): what arrived for it would then
    // count against a different part. Its quantity stays editable — the
    // job may need more or fewer — and still-to-order follows it.
    const keptSku = new Map(next.lineItems.map((l) => [l.id, l.sku]));
    const dropped = ((await purchasingClaims()).get(current.id) || [])
      .filter((c) => !keptSku.has(c.lineId) || keptSku.get(c.lineId) !== c.sku);
    // (The System Builder's re-sync of a list with nothing yet ordered on it
    // lands here when earlier orders were completed or cancelled: refusing
    // keeps what arrived counted, so it isn't ordered again.)
    if (dropped.length) {
      throw purchasingHistoryError(current.id, dropped, "replace the lines on",
        "Change quantities on the list itself, or start a new list for the new design.");
    }
    lineItemsChanged = true;
  }

  // Status: archived is sticky-on (must be requested explicitly). Anything
  // else derives from line state. This prevents the UI from accidentally
  // marking a half-built list as "complete" by passing the wrong status.
  if (patch.status === "archived") {
    next.status = "archived";
  } else if (current.status === "archived" && patch.status && patch.status !== "archived") {
    next.status = deriveStatus(next.lineItems, patch.status); // unarchive
  } else {
    next.status = deriveStatus(next.lineItems, current.status);
  }

  next.updatedAt = nowIso();

  // History — log the kind of change. Coalesce multiple line-item edits in
  // the same PATCH into one entry so the audit trail doesn't drown in noise.
  if (lineItemsChanged) {
    appendHistory(next, { action: "lines_updated", note: `${next.lineItems.length} line${next.lineItems.length === 1 ? "" : "s"}` });
  }
  if (current.status !== next.status) {
    appendHistory(next, { action: `status:${next.status}`, note: "" });
  }
  if (current.name !== next.name) {
    appendHistory(next, { action: "renamed", note: next.name });
  }
  if (current.parentType !== next.parentType || current.parentId !== next.parentId) {
    appendHistory(next, {
      action: "parent_changed",
      note: next.parentType ? `${next.parentType}:${next.parentId}` : "detached"
    });
  }

  records[idx] = next;
  await writeAll(records);
  return next;
}

async function remove(id) {
  const records = await readAll();
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) return null;
  assertNotHeld({ materialLists: [records[idx].id] });
  const claims = (await purchasingClaims()).get(records[idx].id) || [];
  if (claims.length) throw purchasingHistoryError(records[idx].id, claims, "permanently delete");
  const [removed] = records.splice(idx, 1);
  await writeAll(records);
  return removed;
}

// Resolve a single line's per-unit price, in cents. THE one price path —
// every read (server totals below, plus the builder's per-line render and
// savebar, which carry a byte-identical copy of this function; keep them in
// sync) must go through it so the views can never disagree. Pure:
// (line, partsMap) -> integer cents | null.
//
//   1. Frozen   — line.frozenPriceCents is set (a PO was SENT for this
//                 line). Return the snapshot verbatim; never re-resolve from
//                 the catalog, so the list line and the PO stay identical.
//   2. Live     — not locked + the SKU is in the catalog. Return the current
//                 parts.json price, so catalog edits show up immediately.
//   3. Unavail. — not locked + the SKU is absent (deleted from the catalog).
//                 Return null so callers render a clear "price unavailable"
//                 state rather than a misleading $0.
//
// There is no manual/off-catalog branch: unlike PO lines, material-list
// lines are always catalog SKUs (the builder only adds known SKUs), so a
// non-frozen line with no catalog match is a deleted SKU, not a typed price.
function resolveLineUnitPriceCents(line, partsMap) {
  // null/undefined = not locked; guard before Number() (Number(null) === 0).
  const rawFrozen = line == null ? null : line.frozenPriceCents;
  const frozen = Number(rawFrozen);
  if (rawFrozen != null && Number.isFinite(frozen) && frozen >= 0) return Math.floor(frozen);
  const part = line && partsMap && Object.prototype.hasOwnProperty.call(partsMap, line.sku) ? partsMap[line.sku] : null;
  if (part && Number.isFinite(Number(part.priceCents))) return Math.max(0, Math.floor(Number(part.priceCents)));
  return null;
}

// Compute totals against a parts catalog. Caller passes the parts map
// (catalog.parts from /api/parts). Per-unit price comes from
// resolveLineUnitPriceCents (frozen-then-live). Lines whose SKU isn't found
// (and aren't price-locked) contribute 0 to subtotals and are counted in
// both unknownSkuCount (no catalog record) and priceUnavailableCount (no
// resolvable price) so the UI can flag them. Prices are in cents.
function computeTotals(record, partsMap) {
  const totals = {
    lineCount: 0,
    needCount: 0,
    orderedCount: 0,
    haveCount: 0,
    unknownSkuCount: 0,
    priceUnavailableCount: 0,
    needSubtotalCents: 0,
    haveSubtotalCents: 0,
    orderedSubtotalCents: 0,
    grandSubtotalCents: 0
  };
  const lines = Array.isArray(record?.lineItems) ? record.lineItems : [];
  for (const line of lines) {
    totals.lineCount++;
    if (!(partsMap && Object.prototype.hasOwnProperty.call(partsMap, line.sku))) totals.unknownSkuCount++;
    const unit = resolveLineUnitPriceCents(line, partsMap);
    if (unit == null) totals.priceUnavailableCount++;
    const lineCents = (unit == null ? 0 : unit) * (Number(line.qty) || 0);
    totals.grandSubtotalCents += lineCents;
    if (line.status === "need")    { totals.needCount++;    totals.needSubtotalCents    += lineCents; }
    if (line.status === "ordered") { totals.orderedCount++; totals.orderedSubtotalCents += lineCents; }
    if (line.status === "have")    { totals.haveCount++;    totals.haveSubtotalCents    += lineCents; }
  }
  return totals;
}

// ---- Soft-delete (bulk operations) ----------------------------------

async function softDelete(id) {
  const records = await readAll();
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) throw new Error("Material list not found");
  assertNotHeld({ materialLists: [records[idx].id] });
  if (records[idx].deletedAt) throw new Error("Already in Trash");
  records[idx] = { ...records[idx], deletedAt: nowIso(), updatedAt: nowIso() };
  await writeAll(records);
  return records[idx];
}

async function restore(id) {
  const records = await readAll();
  const idx = records.findIndex((r) => r.id === id);
  if (idx === -1) throw new Error("Material list not found");
  assertNotHeld({ materialLists: [records[idx].id] });
  if (!records[idx].deletedAt) throw new Error("Not in Trash");
  records[idx] = { ...records[idx], deletedAt: null, updatedAt: nowIso() };
  await writeAll(records);
  return records[idx];
}

async function listDeleted() {
  const records = await readAll();
  return records.filter((r) => r.deletedAt);
}

async function purgeDeleted({ olderThanMs = 30 * 24 * 60 * 60 * 1000 } = {}) {
  const records = await readAll();
  assertNotHeld({ materialLists: [] });                         // a hold on everything stops the purge
  const claimed = await purchasingClaims();
  const cutoff = Date.now() - olderThanMs;
  const kept = records.filter((r) => {
    if (!r.deletedAt) return true;
    if (holdFor({ materialLists: [r.id] })) return true;       // never purge a held list
    if (claimed.has(r.id)) return true;                        // nor one an order was placed for — it stays in Trash
    const t = Date.parse(r.deletedAt);
    return !Number.isFinite(t) || t > cutoff;
  });
  const purged = records.length - kept.length;
  if (purged > 0) await writeAll(kept);
  return purged;
}

// Every write verb queues behind the shared purchasing lock, so a list
// edit can't land between the two halves of a purchase-order commit.
const locked = (fn) => (...args) => withPurchasingLock(() => fn(...args));

module.exports = {
  STATUSES,
  LINE_STATUSES,
  PARENT_TYPES,
  FILE,
  list,
  get,
  listByParent,
  create: locked(create),
  update: locked(update),
  remove: locked(remove),
  computeTotals,
  resolveLineUnitPriceCents,
  protectedLineViolations,
  isPurchasingProtected,
  canonicalizeIncomingLines,
  purchasingTransitionError,
  purchasingClaims,
  hydrateLine,
  deriveStatus,
  softDelete: locked(softDelete),
  restore: locked(restore),
  listDeleted,
  purgeDeleted: locked(purgeDeleted),
  // purchasing.js only — it holds the lock and commits the result.
  _internal: { readRaw, serialize, hydrate, hydrateLine, deriveStatus, appendHistory, nowIso }
};
