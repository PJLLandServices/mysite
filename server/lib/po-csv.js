// Purchase Order CSV companion file. Generated alongside the PDF when
// a PO transitions draft → sent. Attached to the supplier email so the
// counter-staff can paste line items directly into their order system
// without re-keying from the PDF.
//
// Format: RFC 4180 — comma-separated, fields quoted when they contain
// commas, double quotes, or newlines; embedded double quotes escaped
// by doubling. Header row exactly as the brief specifies:
//
//   SKU,Description,Qty,Unit,UnitPrice,LineTotal
//
// Prices are in decimal dollars (supplier systems expect this — they
// don't store cents). Descriptions and units use the same lookup as
// po-pdf.js (parts.json), and the same formatUnit() helper so the
// "eachs" pluralization fix flows through to the CSV too.

const fsSync = require("node:fs");
const path = require("node:path");
const { formatUnit, resolveLineDescription } = require("./format");

// Catalog lookup — same as po-pdf.js. The cache is process-lifetime,
// reset on restart. Snapshot-on-send (server.js) holds the rendered CSV
// byte-identically thereafter, so a parts.json change after send never
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
// → catalog → placeholder, no size prefix) — identical to the PDF, email,
// and on-screen detail. The caller passes the merged catalog (PARTS.parts);
// we fall back to the on-disk parts.json only when none is provided.
function catalogParts(passed) {
  if (passed && typeof passed === "object") return passed;
  return loadParts().parts || {};
}

function unitFor(sku) {
  const cat = loadParts();
  const part = cat.parts && cat.parts[sku];
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

// Decimal-dollar formatter — two fixed decimals, no currency symbol
// (per RFC 4180 numeric convention; supplier systems strip non-numeric
// chars or fail on them).
function fmtDollars(cents) {
  const v = (Number(cents) || 0) / 100;
  return v.toFixed(2);
}

// Render the CSV. Returns a Buffer so the caller can both pipe to HTTP
// and attach to email without juggling strings vs streams. UTF-8 with
// a BOM so Excel on Windows interprets non-ASCII characters (em-dashes,
// accented part names, etc.) inside descriptions correctly.
function generatePoCsv(po, partsMap) {
  const catalog = catalogParts(partsMap);
  const lines = [];
  lines.push("SKU,Description,Qty,Unit,UnitPrice,LineTotal");
  for (const line of (po.lineItems || [])) {
    const description = resolveLineDescription(line, catalog);
    const unit = formatUnit(unitFor(line.sku), line.qty);
    const row = [
      quoteField(line.sku || ""),
      quoteField(description),
      String(line.qty),
      quoteField(unit),
      fmtDollars(line.unitPriceCents),
      fmtDollars(line.lineTotalCents)
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

module.exports = { generatePoCsv };
