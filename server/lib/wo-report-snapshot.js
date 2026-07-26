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
const { renderWoReportToFile, reportFilename } = require("./wo-report-pdf");

// Hash a file by streaming it. Never read a whole report into memory just
// to digest it — that was part of the OOM.
function sha256OfFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const rs = fsSync.createReadStream(filePath);
    rs.on("data", (c) => hash.update(c));
    rs.on("end", () => resolve(hash.digest("hex")));
    rs.on("error", reject);
  });
}

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

  // Render the INTERNAL copy only, streamed straight to disk.
  //
  // Two deliberate changes after the Jul 2026 OOM (a 20-photo WO produced
  // a ~281 MB report and killed the 512 MB instance on every render):
  //   1. Stream to file instead of Buffer.concat. Concat held the whole
  //      document TWICE at peak (chunk array + concatenated result).
  //   2. Write internal only. The customer copy is rendered lazily on the
  //      first portal read (see readSnapshot below) and cached from then
  //      on, so a send no longer pays for two full renders back to back.
  // renderWoReportToFile also generates the downscaled photo derivatives
  // before rendering, which is what actually removes the bulk.
  const dir = path.join(SNAPSHOT_DIR, woId);
  const filePath = path.join(dir, `${snapshotId}.pdf`);
  await renderWoReportToFile({ wo, property, customer, mode, audience: "internal" }, filePath);

  // Hash by streaming the finished file — never load it whole to hash it.
  const sha256 = await sha256OfFile(filePath);
  const filename = reportFilename({ wo, mode });

  const record = {
    snapshotId,
    ts: new Date().toISOString(),
    triggerType,
    mode,
    quoteId: triggerType === "quote_send" ? (quoteId || null) : null,
    filename,
    path: filePath,
    sha256,
    // schemaVersion 3: internal-only at write time. A v3 record with no
    // pathCustomer is EXPECTED, not a migration failure — readSnapshot
    // renders and caches the customer copy on first customer-audience read
    // (same lazy path v1 records use).
    pathCustomer: null,
    sha256Customer: null,
    schemaVersion: 3,
    by
  };

  await workOrders.appendReportSnapshot(woId, record);
  return record;
}

// Read a snapshot back from disk. Verifies the recorded snapshot exists
// on the WO (so an attacker can't request arbitrary snapshot IDs and
// guess existence) and that the file is actually on disk. Returns
// { buffer, record } on success, null on miss.
async function readSnapshot({ woId, snapshotId, audience = "internal" }) {
  if (!woId || !snapshotId) return null;
  const wo = await workOrders.get(woId);
  if (!wo) return null;
  const record = (wo.reportSnapshots || []).find((s) => s.snapshotId === snapshotId);
  if (!record) return null;

  // Customer audience — serve the customer-render file. Legacy snapshots
  // (schemaVersion < 2) only have the single internal file; render the
  // customer copy on demand, cache it to disk, and stamp the record so
  // the next read is a straight file serve. Self-healing migration, no
  // batch backfill needed.
  if (audience === "customer") {
    if (record.pathCustomer && record.pathCustomer.startsWith(SNAPSHOT_DIR)
        && fsSync.existsSync(record.pathCustomer)) {
      return { buffer: await fs.readFile(record.pathCustomer), record };
    }
    // Lazy render + cache of the customer copy, from CURRENT wo state.
    // Covers BOTH legacy v1 snapshots (which only ever had the internal
    // file) and v3 snapshots (internal-only by design). Streamed to disk
    // first, then served from disk, so we never hold the document twice.
    const { property, customer } = await loadRenderContext(wo);
    const pathCustomer = path.join(SNAPSHOT_DIR, woId, `${snapshotId}-customer.pdf`);
    await renderWoReportToFile(
      { wo, property, customer, mode: record.mode, audience: "customer" },
      pathCustomer
    );
    let sha256Customer = null;
    try { sha256Customer = await sha256OfFile(pathCustomer); } catch (_) {}
    try {
      await workOrders.patchReportSnapshot(woId, snapshotId, { pathCustomer, sha256Customer });
    } catch (err) { /* serve the render even if the record patch failed */ }
    return {
      buffer: await fs.readFile(pathCustomer),
      record: { ...record, pathCustomer, sha256Customer }
    };
  }

  // Internal audience — resolve the internal path but verify it lives
  // inside SNAPSHOT_DIR (defense against any historical record that
  // escaped the per-WO directory).
  const filePath = record.path && record.path.startsWith(SNAPSHOT_DIR)
    ? record.path
    : path.join(SNAPSHOT_DIR, woId, `${snapshotId}.pdf`);
  if (!fsSync.existsSync(filePath)) return null;
  const buffer = await fs.readFile(filePath);
  return { buffer, record };
}

// Serve the NEWEST snapshot for a WO in the requested audience. Powers
// the customer portal's stable (snapshotId-less) report link so a
// corrected report always resolves to the current version.
async function readLatestSnapshot({ woId, audience = "internal" }) {
  if (!woId) return null;
  const wo = await workOrders.get(woId);
  if (!wo || !Array.isArray(wo.reportSnapshots) || !wo.reportSnapshots.length) return null;
  const latest = [...wo.reportSnapshots]
    .sort((a, b) => String(a.ts || "").localeCompare(String(b.ts || ""))).pop();
  return readSnapshot({ woId, snapshotId: latest.snapshotId, audience });
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
  readLatestSnapshot,
  findLatestCascadeSnapshot,
  SNAPSHOT_DIR
};
