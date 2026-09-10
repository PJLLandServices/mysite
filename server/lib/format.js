// Shared rendering helpers. Pure functions only — these are imported by
// PDF generators, CSV writers, and email body builders that need to
// normalize values for display without coupling to a specific format.
//
// Helpers live here (rather than inline in each renderer) so a bug is
// fixed once and the fix propagates. Specifically: the "eachs" bug in
// the original po-pdf.js naively pluralized `unit` by appending `s`
// when qty != 1 — broke `each` → `eachs`, `ft` → `fts`, etc.

// formatUnit — display the unit as a short, never-pluralized label.
//
// Input is the unit string as stored in parts.json (`each`, `roll`,
// `ft`, `lb`, `case`, etc.). Output is the supplier-friendly short
// form. Qty is accepted for caller ergonomics but deliberately unused
// — the brief calls for non-pluralized units across all qty values.
//
//   formatUnit("each", 25)  -> "ea"
//   formatUnit("ft",   10)  -> "ft"
//   formatUnit("roll",  3)  -> "roll"
//   formatUnit("",      1)  -> "ea"     (defensive default — matches
//                                        the parts.js hydration default)
//   formatUnit("case",  4)  -> "case"   (unknown unit: verbatim)
function formatUnit(unit /*, qty */) {
  const u = String(unit || "").trim().toLowerCase();
  if (!u) return "ea";
  if (u === "each") return "ea";
  // Everything else renders verbatim — `roll`, `ft`, `lb`, `case`,
  // `box`, etc. The parts.json catalog is open-ended (see parts.js
  // comment: "a new unit can be introduced without code changes"), so
  // we deliberately don't enumerate.
  return u;
}

// formatVendorAddress — normalize a supplier record's address fields
// into an array of display lines suitable for a PO / quote / invoice
// vendor block.
//
// Handles two pain points observed in the existing suppliers.json:
//   1. ALL-CAPS street + city ("220 CREDITSTONE ROAD CONCORD ON L4K1P3")
//      — title-case it for readability.
//   2. Postal code crammed onto the same line as city/province —
//      lift it onto its own line with a space inside the Canadian
//      "K1A 0B1" format.
//
// `supplier` is the hydrated record from server/lib/suppliers.js. We
// read `address` (the free-form field) since that's what's stored. If
// the supplier record gains structured city/province/postalCode
// fields in the future, this helper can grow accordingly without
// changing its callers.
//
// Returns: { lines: string[], attn: string | null }
//   lines[0..]  — display-ready address lines (street, city/prov, postal)
//   attn        — `Attn: <contactName>` string, or null if no contact
//
// Caller is responsible for emitting each line in order. The function
// never returns empty lines; absent fields are simply not present.
function formatVendorAddress(supplier) {
  const out = { lines: [], attn: null };
  if (!supplier || typeof supplier !== "object") return out;

  if (supplier.contactName && String(supplier.contactName).trim()) {
    out.attn = `Attn: ${String(supplier.contactName).trim()}`;
  }

  const raw = String(supplier.address || "").trim();
  if (!raw) return out;

  // Canadian postal code matcher — letter-digit-letter [space?] digit-
  // letter-digit, case-insensitive. The space is optional in stored
  // data but ALWAYS rendered in output ("K1A 0B1", not "K1A0B1").
  const POSTAL_RE = /\b([A-Za-z]\d[A-Za-z])[ ]?(\d[A-Za-z]\d)\b/;

  // Try to find a postal code anywhere in the string.
  const match = raw.match(POSTAL_RE);
  let beforePostal = raw;
  let postal = null;
  if (match) {
    postal = `${match[1].toUpperCase()} ${match[2].toUpperCase()}`;
    // Slice off the postal code from the end; trim any trailing
    // separators (commas, dashes, leftover spaces) so the city line
    // doesn't end with ", ".
    beforePostal = raw.slice(0, match.index).trim().replace(/[,\-\s]+$/, "");
  }

  // The remaining string may include street + city + province on one
  // line ("220 CREDITSTONE ROAD CONCORD ON") or on separate lines
  // (newline-delimited). Honor explicit newlines if the data has them;
  // otherwise try to split a single-line address into "street" and
  // "city + prov" by finding the last common Canadian street suffix.
  // Falls back to a single line when no suffix matches.
  let explicitLines = beforePostal
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (explicitLines.length === 1) {
    explicitLines = splitStreetFromCity(explicitLines[0]);
  }

  // Title-case helper: word-by-word, but leave 2-letter province codes
  // alone if they're already uppercase. Postal codes are already
  // handled separately. Acronyms in supplier names (e.g. "ABC Pipe")
  // round-trip cleanly because they appear in supplier.name, not
  // supplier.address.
  const titleCase = (text) => {
    // Detect "all uppercase" — letters present and every letter is
    // upper. Only retitle in that case to avoid disturbing already-
    // good casing (e.g. "McDonald", "O'Connor").
    const hasLowercase = /[a-z]/.test(text);
    if (hasLowercase) return text;
    return text
      .toLowerCase()
      .split(/\s+/)
      .map((word) => {
        if (!word) return word;
        // Province codes — 2 chars, no digits. Re-uppercase.
        if (/^[a-z]{2}$/.test(word)) return word.toUpperCase();
        // Numbered street ("123") — leave digits alone, capitalize trailing letters.
        return word
          .split("-")
          .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
          .join("-");
      })
      .join(" ");
  };

  for (const line of explicitLines) {
    // Last-line heuristic: if a line ends with a 2-letter province
    // code preceded by city text ("Concord ON"), insert a comma
    // between city and province for readability.
    let formatted = titleCase(line);
    // Common Canadian formatting: split "City PROV" → "City, PROV".
    // Detect: ends with " XX" where XX is two uppercase letters.
    const provMatch = formatted.match(/^(.*?)[\s,]+([A-Z]{2})$/);
    if (provMatch) {
      formatted = `${provMatch[1].trim()}, ${provMatch[2]}`;
    }
    // Never emit a line that opens with separator debris — whatever the
    // splitter produced, the rendered block must read like a person
    // typed it.
    formatted = formatted.replace(/^[\s,\-]+/, "").trim();
    if (formatted) out.lines.push(formatted);
  }

  if (postal) {
    // Postal code joins the LAST line (standard Canadian envelope
    // format: "Milton, ON  L9T 2X6") instead of cascading onto its own
    // line — three fragments for a one-line address read as a layout
    // bug, not an address. Own-line only as the fallback when there is
    // no other line to join.
    if (out.lines.length) {
      out.lines[out.lines.length - 1] += `  ${postal}`;
    } else {
      out.lines.push(postal);
    }
  }

  return out;
}

// Split a single-line address ("220 Creditstone Road Concord ON") into
// [street, cityProv] using common Canadian street suffixes. Returns the
// original line as a single-element array if no suffix matches.
//
// Matches whole-word suffixes only — "Road" but not "Roadside". Picks
// the LAST occurrence so addresses like "23 Park Street Court" (a
// genuine Toronto street name) treat Court as the suffix.
function splitStreetFromCity(line) {
  const SUFFIXES = [
    "road", "rd",
    "street", "st",
    "avenue", "ave", "av",
    "boulevard", "blvd",
    "drive", "dr",
    "court", "ct",
    "crescent", "cres",
    "place", "pl",
    "way",
    "lane", "ln",
    "trail", "tr",
    "highway", "hwy",
    "parkway", "pkwy",
    "circle", "cir",
    "terrace", "terr",
    "square", "sq",
    "concession"
  ];
  const lower = line.toLowerCase();
  let bestEnd = -1;
  for (const suffix of SUFFIXES) {
    // Whole-word match at the END is preferred (most addresses end the
    // street name at the suffix), but we also handle "Road Concord ON"
    // where the suffix is mid-string.
    const re = new RegExp(`\\b${suffix}\\b`, "gi");
    let m;
    while ((m = re.exec(lower)) !== null) {
      const end = m.index + m[0].length;
      if (end > bestEnd) bestEnd = end;
    }
  }
  if (bestEnd === -1) return [line];
  const street = line.slice(0, bestEnd).trim();
  // The remainder starts right after the street suffix — strip the
  // separator junk it inherits ("​, Milton, ON" → "Milton, ON"). An
  // orphaned leading comma here is exactly the "cascade" artifact that
  // made vendor blocks look machine-mangled on the PO/RFQ PDFs.
  const cityProv = line.slice(bestEnd).replace(/^[\s,\-]+/, "").trim();
  if (!cityProv) return [street];
  return [street, cityProv];
}

// parseCanadianAddress — best-effort split of a one-line (or newline-
// delimited) Canadian address into the structured parts an address
// verification (AVS) payload wants.
//
// Added for the QuickBooks Payments AVS work (Jul 2026): the pay page
// pre-fills the billing street address from `invoice.billTo.address`,
// which is stored as one free-form string. Parsing it here rather than
// in the route keeps the postal-code + street-suffix knowledge in ONE
// place — `formatVendorAddress` already owns both, and a second
// implementation would drift.
//
//   parseCanadianAddress("123 Main St, Newmarket, ON L3X 0A5")
//     -> { streetAddress: "123 Main St", city: "Newmarket",
//          region: "ON", postalCode: "L3X 0A5" }
//
// Every field is best-effort and may come back "". This output is only
// ever used to PRE-FILL an editable form — never to build a payload
// behind the customer's back — so an imperfect split costs the customer
// one correction, not a failed charge.
const CANADA_POSTAL_RE = /\b([A-Za-z]\d[A-Za-z])[ ]?(\d[A-Za-z]\d)\b/;
const PROVINCE_CODES = new Set([
  "AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"
]);

function parseCanadianAddress(raw) {
  const out = { streetAddress: "", city: "", region: "", postalCode: "" };
  let text = String(raw || "").replace(/\r\n/g, "\n").trim();
  if (!text) return out;

  // Postal code first — it can sit anywhere in the blob. Lifting it out
  // leaves a clean street/city/province remainder to split.
  const match = text.match(CANADA_POSTAL_RE);
  if (match) {
    out.postalCode = `${match[1].toUpperCase()} ${match[2].toUpperCase()}`;
    text = `${text.slice(0, match.index)}\n${text.slice(match.index + match[0].length)}`.trim();
  }
  // "Canada" is not a field of its own — the tokenization payload carries
  // an explicit country code.
  text = text.replace(/(^|[,\n\s])canada\b/gi, "$1").trim();

  let lines = text
    .split("\n")
    .map((line) => line.trim().replace(/^[,\-\s]+|[,\-\s]+$/g, ""))
    .filter(Boolean);
  if (lines.length === 1) lines = splitStreetFromCity(lines[0]);

  // Province rides on the last line ("Newmarket, ON"). Peel it off; if
  // it was the whole line, drop the line entirely.
  if (lines.length) {
    const last = lines[lines.length - 1];
    const provMatch = last.match(/(?:^|[,\s])([A-Za-z]{2})$/);
    if (provMatch && PROVINCE_CODES.has(provMatch[1].toUpperCase())) {
      out.region = provMatch[1].toUpperCase();
      const remainder = last.slice(0, provMatch.index).replace(/[,\-\s]+$/, "").trim();
      if (remainder) lines[lines.length - 1] = remainder;
      else lines.pop();
    }
  }

  out.streetAddress = lines[0] || "";
  out.city = lines.slice(1).join(", ");
  return out;
}

// resolveLineDescription — THE one description path for a PO line, shared
// by every render surface (PDF, CSV, supplier email, and — mirrored — the
// on-screen PO detail table) so they can never disagree. Pure:
// (line, partsMap) -> string. Precedence:
//
//   1. Stored line.description (non-empty) — the snapshot taken at PO
//      generation, OR a manually-typed off-catalog line. Always wins.
//   2. partsMap[line.sku].description — live catalog lookup, for legacy
//      lines generated before the snapshot fix (or blank snapshots).
//   3. "(SKU <sku>)" placeholder — genuine last resort only.
//
// Returns the description text ONLY — never prefixes `size` (the old
// `${size} — ${desc}` concatenation was a display bug; size already reads
// naturally inside most catalog descriptions). `partsMap` is the catalog
// MAP (`{ sku: {...} }`), e.g. PARTS.parts — pass the SAME map to every
// surface so an override-only SKU resolves identically on all of them.
function resolveLineDescription(line, partsMap) {
  const stored = line && typeof line.description === "string" ? line.description.trim() : "";
  if (stored) return stored;
  const sku = line && line.sku != null ? String(line.sku) : "";
  const part = partsMap && Object.prototype.hasOwnProperty.call(partsMap, sku) ? partsMap[sku] : null;
  const catalogDesc = part && typeof part.description === "string" ? part.description.trim() : "";
  if (catalogDesc) return catalogDesc;
  return `(SKU ${sku})`;
}

// townFromAddress — the town/city out of a free-text property address,
// for the CRM's "sort by town" (customers + properties indexes, Aug 2026).
//
// Properties store one free-text `address` string; there is no city field
// and adding one would mean a migration plus every intake path learning to
// fill it. Deriving it here reuses the parser that already owns Canadian
// address structure, so the town shown on a card and the town sorted on
// can never come from two different implementations.
//
//   townFromAddress("123 Main St, Newmarket, ON L3X 0A5")   -> "Newmarket"
//   townFromAddress("17 Elm St, Unit 4, King City, Ontario") -> "King City"
//   townFromAddress("Newmarket, ON, Canada")                 -> "Newmarket"
//   townFromAddress("")                                       -> ""
//
// Best-effort by construction, exactly like parseCanadianAddress: this
// drives display and ordering, never a payload or a match. An address the
// parser can't read sorts under "(no town)" rather than guessing.
const PROVINCE_NAMES = new Set([
  "alberta", "british columbia", "manitoba", "new brunswick",
  "newfoundland and labrador", "northwest territories", "nova scotia",
  "nunavut", "ontario", "prince edward island", "quebec", "québec",
  "saskatchewan", "yukon"
]);

function townFromAddress(raw) {
  const text = String(raw == null ? "" : raw).replace(/\r\n/g, "\n").trim();
  if (!text) return "";

  // Strip the parts that are never the town: postal code, country, and the
  // province in either form. What's left is street + unit + town.
  let rest = text
    .replace(CANADA_POSTAL_RE, " ")
    .replace(/(^|[,\n\s])canada\b/gi, "$1");
  const segments = rest
    .split(/[,\n]/)
    .map((part) => part.trim().replace(/^[,\-\s]+|[,\-\s]+$/g, "").replace(/\s+/g, " "))
    .filter(Boolean)
    .filter((part) => !PROVINCE_NAMES.has(part.toLowerCase()) && !PROVINCE_CODES.has(part.toUpperCase()));

  // A comma-formatted address (what the geocoder returns and what gets
  // typed in practice) puts the town in the last segment. Trusting the
  // commas rather than parseCanadianAddress's street-suffix split matters:
  // that list knows "St" and "Blvd" but not "Rue", "Gate", "Grove" or
  // "Green", and an address ending in one of those would come back with no
  // town at all.
  if (segments.length > 1) {
    const last = segments[segments.length - 1];
    // "…, Newmarket ON" — province riding on the town segment without a
    // comma of its own.
    const trimmed = last.replace(/[\s,]+(?:[A-Za-z]{2})$/, (m) =>
      PROVINCE_CODES.has(m.trim().toUpperCase()) ? "" : m).trim();
    return normalizeTownCase(trimmed || last);
  }

  // No commas to go on: fall back to the shared parser, which splits a
  // run-on line at the street suffix ("123 Main St Newmarket ON").
  const parsed = parseCanadianAddress(text);
  if (parsed.city) {
    const tail = parsed.city
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean)
      .filter((part) => !PROVINCE_NAMES.has(part.toLowerCase()) && !PROVINCE_CODES.has(part.toUpperCase()));
    if (tail.length) return normalizeTownCase(tail[tail.length - 1]);
  }
  // A town-only address ("Newmarket", the shape left after stripping the
  // province off a geocoder formattedAddress). Take it only when it
  // doesn't open with a street number, so "12 Main St" with a missing town
  // stays townless rather than becoming one.
  const only = segments[0] || "";
  return /^\d/.test(only) ? "" : normalizeTownCase(only);
}

// Normalize SHOUTED imports ("NEWMARKET" from an xlsx) so the badge column
// doesn't read as two different towns. Mixed case is left alone — "King
// City" and "St. Catharines" are already right, and re-casing them would
// be the guess.
function normalizeTownCase(town) {
  if (!town || town !== town.toUpperCase() || !/[A-Z]/.test(town)) return town;
  return town.toLowerCase().replace(/(^|[\s\-'])([a-z])/g, (m, sep, ch) => sep + ch.toUpperCase());
}

// ---------------------------------------------------------------------
// documentFilename — the one name a saved PJL document wears.
//
//   2026-08-21 - Inspection Report - Kristen Holmes - 90 Oriole Dr.pdf
//   2026-08-21 - I-2026-0065 Invoice - Kristen Holmes - 90 Oriole Dr.pdf
//
// Four parts, always in this order: the date ON the document, what the
// document is, who it is for, and which address it concerns. Before this
// every route named its own downloads and they had drifted apart —
// I-2026-0065.pdf, PJL-Service-Report-WO-2026-0100-2026-08-21.pdf,
// Q-2026-0007.pdf — so a folder of saved PJL paperwork sorted by nothing
// useful and told you nothing without opening it.
//
// THE DATE IS THE CALLER'S AND IT COMES FROM THE DOCUMENT, NEVER THE
// CLOCK. An invoice uses its issue date, a report its visit date, a quote
// when it was sent. There is deliberately no `new Date()` fallback: a
// missing date drops the component rather than stamping today onto a
// document from August, which is the failure that would go unnoticed
// longest — you would only catch it by re-downloading an old file and
// noticing the name had changed.
function documentFilename({ date, label, customerName, address, ext = "pdf" } = {}) {
  const parts = [
    isoDay(date),
    clean(label),
    clean(customerName),
    // Street line only — "90 Oriole Dr", not the town, province and
    // postal code. The town is the same for most of the book and adds
    // length without telling you which job this was.
    clean(streetLine(address))
  ].filter(Boolean);
  // Every part empty would leave a bare ".pdf" — hand back something a
  // person can still identify rather than a hidden dotfile.
  if (!parts.length) return `PJL Document.${ext}`;
  // 180 leaves room for the extension and a browser's " (1)" inside the
  // 255-byte limit every common filesystem imposes.
  return `${parts.join(" - ").slice(0, 180).trim()}.${ext}`;
}

// The street line, with the town kept out of it.
//
// parseCanadianAddress() gets this right most of the time, but its
// single-line split works off a street-SUFFIX list, so a street type the
// list doesn't carry leaves the town glued on: "8 Rue Principale,
// Montréal", "22 Kingsmere Gate, Aurora", "4293 ON-7, Norwood". Splitting
// on the first comma instead fixes those and breaks a different case —
// "Unit 4, 17 Elm St, King City" collapses to "Unit 4", which names no
// street at all.
//
// So: take the parser's answer, and if it still carries a comma, drop the
// trailing segment UNLESS the leading one is a unit designator — the only
// shape where both halves are genuinely part of the street.
const UNIT_PREFIX = /^(unit|apt|apartment|suite|ste|#)\b/i;
function streetLine(address) {
  const parsed = parseCanadianAddress(address).streetAddress || String(address || "");
  const segments = parsed.split(",").map((x) => x.trim()).filter(Boolean);
  if (segments.length < 2) return parsed;
  if (UNIT_PREFIX.test(segments[0])) return segments.slice(0, 2).join(", ");
  return segments[0];
}

// YYYY-MM-DD from an ISO string or a Date. Anything unparseable yields ""
// so the caller's name simply loses its date rather than gaining a wrong one.
function isoDay(value) {
  if (!value) return "";
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? "" : value.toISOString().slice(0, 10);
  }
  const text = String(value).trim();
  const iso = text.match(/^(\d{4}-\d{2}-\d{2})/);
  return iso ? iso[1] : "";
}

// Strip what filesystems refuse and what would fold the name onto a second
// line, but KEEP accents — "Renée" stays "Renée". The wire encoding is
// contentDisposition()'s job, not this function's.
function clean(value) {
  return String(value == null ? "" : value)
    .replace(/[/\\:*?"<>|]/g, " ")     // illegal on Windows and/or POSIX
    .replace(/[\u0000-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Content-Disposition value carrying BOTH spellings of the name.
//
// `filename=` is ASCII-only by the RFC, so a name with an accent has to
// travel in `filename*=UTF-8''…` (RFC 5987) as well — send only the plain
// one and browsers mangle "Renée" into "RenÃ©e" or drop the name entirely.
// Send only the encoded one and older clients ignore it. Both, in that
// order, is what every client understands: the ones that grasp filename*
// prefer it, the rest fall back.
function contentDisposition(filename, { download = false } = {}) {
  const name = String(filename || "document.pdf");
  // The ASCII fallback: strip accents to their base letters, then drop
  // anything still non-ASCII, so the plain parameter stays legal.
  const ascii = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036F]/g, "")
    .replace(/[^\x20-\x7E]/g, "")
    .replace(/["\\]/g, "")
    .trim() || "document.pdf";
  return `${download ? "attachment" : "inline"}; filename="${ascii}"; ` +
    `filename*=UTF-8''${encodeURIComponent(name)}`;
}

module.exports = {
  formatUnit,
  formatVendorAddress,
  parseCanadianAddress,
  townFromAddress,
  resolveLineDescription,
  documentFilename,
  contentDisposition
};
