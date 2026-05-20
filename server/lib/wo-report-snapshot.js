// Work Order Report Snapshot — freezes a render of the WO's
// service / inspection report to disk and appends a record on the WO.
// The on-disk file becomes the customer's source of truth: the cascade
// email attaches the cascade-triggered snapshot, the send-for-approval
// email attaches the quote_send snapshot, and the customer portal
// "Download service report" link serves whatever was frozen.
//
// Why snapshots and not deterministic re-render?
//   - Photos can be deleted, zones can be edited post-completion, tech
//     notes can be amended. A frozen PDF is a legal record of what the
//     customer received at the moment the email left the building.
//
// File layout: server/data/wo-reports/<woId>/<snapshotId>.pdf
// Per-WO directory keeps cleanup simple if a WO is ever hard-deleted.
//
// Snapshot record shape (lives on wo.reportSnapshots[]):
//   { snapshotId, ts, triggerType, mode, quoteId?, filename, path, sha256?, by }
//     snapshotId   — sn_<8-char-random> from the unambiguous alphabet
//     triggerType  — "quote_send" | "cascade" | "manual"
//     mode         — "inspection_report" | "service_report"
//                    (derived from wo.locked at creation time)
//     quoteId      — populated only on quote_send triggers
//     filename     — human-readable PJL-{Service|Inspection}-Report-...pdf
//     path         — absolute path on the persistent disk
//     sha256       — hex digest of the PDF bytes (integrity hash)
//     by           — "system" | "admin" | "tech"

const fs = require("node:fs/promises");
const fsSync = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const workOrders = require("./work-orders");
const properties = require("./properties");
const customers = require("./customers");
const { generateWoReportPdf, reportFilename } = require("./wo-report-pdf");

const SNAPSHOT_DIR = path.resolve(__dirname, "..", "data", "wo-reports");

// Same unambiguous alphabet as WO IDs — no I/O/0/1. Snapshot IDs are
// short because they live in URLs (admin history download, customer
// portal download link).
function makeSnapshotId() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = crypto.randomBytes(8);
  let id = "sn_";
  for (let i = 0; i < 8; i++) id += alphabet[bytes[i] % alphabet.length];
  return id;
}

// Resolve property + customer for the renderer. Always fetches fresh —
// the snapshot captures what was true at write time, including any
// concurrent property edits that landed before the cascade fired.
async function loadRenderContext(wo) {
  let property = null;
  let customer = null;
  if (wo.propertyId) {
    try { property = await properties.get(wo.propertyId); } catch (_) {}
  }
  if (wo.customerId) {
    try { customer = await customers.get(wo.customerId); } catch (_) {}
  }
  if (!customer && wo.customerName) {
    customer = { customerName: wo.customerName, customerPhone: wo.customerPhone, customerEmail: wo.customerEmail };
  }
  return { property: property || {}, customer: customer || {} };
}

// Create a snapshot — render PDF, write to disk, append record on WO.
// Mode is auto-derived from wo.locked at the moment of creation
// (locked === true → service_report; else → inspection_report). Callers
// don't pass mode directly.
async function createSnapshot({ woId, triggerType, quoteId = null, by = "system" }) {
  if (!woId) throw new Error("createSnapshot: woId is required.");
  if (!["quote_send", "cascade", "manual"].includes(triggerType)) {
    throw new Error(`createSnapshot: invalid triggerType "${triggerType}".`);
  }

  const wo = await workOrders.get(woId);
  if (!wo) {
    const err = new Error("Work order not found.");
    err.code = "wo_not_found";
    throw err;
  }

  const mode = wo.locked === true ? "service_report" : "inspection_report";
  const snapshotId = makeSnapshotId();
  const { property, customer } = await loadRenderContext(wo);

  // Render — pdfkit streams, we collect to a buffer so we can hash and
  // write atomically. Memory cost: ~2-5 MB per report (photos dominate).
  const stream = generateWoReportPdf({ wo, property, customer, mode });
  const chunks = [];
  const pdfBuffer = await new Promise((resolve, reject) => {
    stream.on("data", (c) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks)));
    stream.on("error", reject);
  });

  const sha256 = crypto.createHash("sha256").update(pdfBuffer).digest("hex");
  const filename = reportFilename({ wo, mode });

  // Ensure the per-WO directory exists, then write the file. Snapshots
  // are immutable post-write — no overwrite logic, ever.
  const dir = path.join(SNAPSHOT_DIR, woId);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${snapshotId}.pdf`);
  await fs.writeFile(filePath, pdfBuffer);

  const record = {
    snapshotId,
    ts: new Date().toISOString(),
    triggerType,
    mode,
    quoteId: triggerType === "quote_send" ? (quoteId || null) : null,
    filename,
    path: filePath,
    sha256,
    by
  };

  await workOrders.appendReportSnapshot(woId, record);
  return record;
}

// Read a snapshot back from disk. Verifies the recorded snapshot exists
// on the WO (so an attacker can't request arbitrary snapshot IDs and
// guess existence) and that the file is actually on disk. Returns
// { buffer, record } on success, null on miss.
async function readSnapshot({ woId, snapshotId }) {
  if (!woId || !snapshotId) return null;
  const wo = await workOrders.get(woId);
  if (!wo) return null;
  const record = (wo.reportSnapshots || []).find((s) => s.snapshotId === snapshotId);
  if (!record) return null;
  // Resolve the path from the record but verify it lives inside the
  // SNAPSHOT_DIR — defense against any historical record that escaped
  // the per-WO directory.
  const filePath = record.path && record.path.startsWith(SNAPSHOT_DIR)
    ? record.path
    : path.join(SNAPSHOT_DIR, woId, `${snapshotId}.pdf`);
  if (!fsSync.existsSync(filePath)) return null;
  const buffer = await fs.readFile(filePath);
  return { buffer, record };
}

// Look up the most recent cascade-triggered snapshot on a WO. Used by
// the cascade short-circuit when re-firing: instead of generating a
// duplicate, attach the existing file.
function findLatestCascadeSnapshot(wo) {
  if (!wo || !Array.isArray(wo.reportSnapshots)) return null;
  for (let i = wo.reportSnapshots.length - 1; i >= 0; i--) {
    if (wo.reportSnapshots[i].triggerType === "cascade") return wo.reportSnapshots[i];
  }
  return null;
}

module.exports = {
  createSnapshot,
  readSnapshot,
  findLatestCascadeSnapshot,
  SNAPSHOT_DIR
};
