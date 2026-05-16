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
    out.lines.push(formatted);
  }

  if (postal) {
    // Postal code on its own line. Per the brief: postal code on its
    // own line (not appended to city).
    out.lines.push(postal);
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
  const cityProv = line.slice(bestEnd).trim();
  if (!cityProv) return [street];
  return [street, cityProv];
}

module.exports = { formatUnit, formatVendorAddress };
