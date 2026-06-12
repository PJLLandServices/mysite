// Request for Quotation CSV companion file. Generated alongside the PDF
// when an RFQ transitions draft → sent. Attached to the supplier email so
// the counter-staff can paste line items directly into their quoting
// system without re-keying from the PDF.
//
// Format: RFC 4180 — comma-separated, fields quoted when they contain
// commas, double quotes, or newlines; embedded double quotes escaped
// by doubling. Header row exactly as the brief specifies:
//
//   SKU,Description,Qty,Unit
//
// NO price columns — by design. An RFQ asks the supplier for prices, so
// the document we send must carry none (the vendor's quoted prices come
// back on their reply, captured later as quotedPriceCents). Descriptions
// and units use the same resolution as rfq-pdf.js (line snapshot first,
// catalog fallback), and the same formatUnit() helper so the "eachs"
// pluralization fix flows through to the CSV too.

const fsSync = require("node:fs");
const path = require("node:path");
const { formatUnit, resolveLineDescription } = require("./format");

// Catalog lookup — same as rfq-pdf.js. The cache is process-lifetime,
// reset on restart. Snapshot-on-send (server.js) holds the rendered CSV
// byte-identically thereafter, so a catalog change after send never
// alters a sent CSV.
let _partsCache = null;
function loadParts() {
  if (_partsCache) return _partsCache;
  try {
    const p = path.resolve(__dirname, "..", "..", "parts.json");
    _partsCache = JSON.parse(fsSync.readFileSync(p, "utf8"));
  } catch {
    _partsCache = { parts: {} };
  }
  return _partsCache;
}

// Description resolution is shared via format.resolveLineDescription (stored
// → catalog → placeholder, no size prefix) — identical to the PDF and the
// on-screen detail. The caller passes the merged catalog (PARTS.parts);
// we fall back to the on-disk parts.json only when none is provided.
function catalogParts(passed) {
  if (passed && typeof passed === "object") return passed;
  return loadParts().parts || {};
}

// Unit resolution mirrors rfq-pdf.js: the unit snapshotted on the line at
// generation wins; catalog unit is the fallback; "each" the last resort.
function unitForLine(line, catalog) {
  if (line && line.unit) return line.unit;
  const sku = line && line.sku != null ? String(line.sku) : "";
  const part = catalog && Object.prototype.hasOwnProperty.call(catalog, sku) ? catalog[sku] : null;
  return (part && part.unit) || "each";
}

// RFC 4180 field quoting. A field needs quoting if it contains a
// comma, a double quote, a newline, or leading/trailing whitespace.
// Inner double quotes are escaped by doubling ("" inside a quoted field).
function quoteField(value) {
  const s = value == null ? "" : String(value);
  if (/[",\r\n]/.test(s) || /^\s|\s$/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

// Render the CSV. Returns a Buffer so the caller can both pipe to HTTP
// and attach to email without juggling strings vs streams. UTF-8 with
// a BOM so Excel on Windows interprets non-ASCII characters (em-dashes,
// accented part names, etc.) inside descriptions correctly.
function generateRfqCsv(rfq, partsMap) {
  const catalog = catalogParts(partsMap);
  const lines = [];
  lines.push("SKU,Description,Qty,Unit");
  for (const line of (rfq.lines || [])) {
    const description = resolveLineDescription(line, catalog);
    const unit = formatUnit(unitForLine(line, catalog), line.quantity);
    const row = [
      quoteField(line.sku || ""),
      quoteField(description),
      String(line.quantity),
      quoteField(unit)
    ].join(",");
    lines.push(row);
  }
  // CRLF line endings — RFC 4180 recommendation; safer for Windows
  // consumers (Excel, supplier ERP CSV importers).
  const body = lines.join("\r\n") + "\r\n";
  // UTF-8 BOM so Excel auto-detects the encoding instead of mojibaking
  // em-dashes and other non-ASCII characters.
  return Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(body, "utf8")]);
}

module.exports = { generateRfqCsv };
