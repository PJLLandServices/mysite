// Retired part numbers → the part they were merged into (Patrick,
// 2026-10-05).
//
// lib/parts.js owns the markers (the `merged` section of the catalog
// overrides) and the rule, canonicalSku(). This module is how every other
// store asks that ONE question without each of them reading the catalog:
// server.js publishes the current alias map here after every catalog
// rebuild, and each door that accepts or groups by a part number calls
// canonical() — Material List saves, work-order materials, PO and RFQ
// planning, the project materials read model.
//
// Until something is published, every number answers with itself, so a
// library used on its own (tests, scripts) behaves exactly as before.

let aliases = {};

// `map` is { retiredSku: canonicalSku }.
function publish(map) {
  aliases = map && typeof map === "object" ? { ...map } : {};
}

function canonical(sku) {
  const key = typeof sku === "string" ? sku.trim() : String(sku == null ? "" : sku).trim();
  return Object.prototype.hasOwnProperty.call(aliases, key) ? aliases[key] : key;
}

function isRetired(sku) {
  return Object.prototype.hasOwnProperty.call(aliases, String(sku == null ? "" : sku).trim());
}

function current() { return { ...aliases }; }

module.exports = { publish, canonical, isRetired, current };
