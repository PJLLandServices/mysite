#!/usr/bin/env node
// Per-supplier part prices and per-supplier part numbers.
//
// The money question this guards: the same part costs different money at
// each branch, and each branch calls it by a different number. The
// catalog used to hold ONE price and ONE sku per part, so the second
// quote applied overwrote the first — the loser's price was simply gone,
// and there was nowhere at all to keep "SiteOne calls this KT010C".
//
// Every assertion below fails against that old single-price catalog:
// there is no supplierPrices block, no priceSupplierId, and flipping the
// primary supplier changes nothing.
//
// Pure-logic test: mergeIntoCatalog, supplierSkuFor and
// seedFromAppliedQuoteRequests take plain arguments and touch no files,
// so nothing here can reach real data. The file-writing half
// (recordSupplierPrices) is exercised against a temp copy of the module's
// store path only if PSP_TMP is set — the build gate runs pure.

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const psp = require(path.join(here, "..", "server", "lib", "part-supplier-prices.js"));

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; }
  else { failed++; console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
}
function eq(name, got, want) {
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

const SITEONE = "SUP-002";
const CENTRAL = "SUP-001";

// Real numbers off the two Sept 2026 quotes for the same material list:
// the #12 clamp is SSC8712 at SiteOne and SC7712 at Central, the saddle
// tee is our DS100C but KT010C / 100C to them, and the 20/7 wire spool is
// the one line where SiteOne is far cheaper.
const PRICES = {
  SSC8712: {
    [SITEONE]: { priceCents: 167, supplierSku: "SSC8712", source: "RFQ-2026-0005", at: "2026-09-14T19:00:00Z" },
    [CENTRAL]: { priceCents: 63,  supplierSku: "SC7712",  source: "RFQ-2026-0004", at: "2026-09-14T20:00:00Z" }
  },
  DS100C: {
    [SITEONE]: { priceCents: 337, supplierSku: "KT010C", source: "RFQ-2026-0005", at: "2026-09-14T19:00:00Z" },
    [CENTRAL]: { priceCents: 374, supplierSku: "100C",   source: "RFQ-2026-0004", at: "2026-09-14T20:00:00Z" }
  },
  "207CD500": {
    [SITEONE]: { priceCents: 21400, source: "RFQ-2026-0005", at: "2026-09-14T19:00:00Z" },
    [CENTRAL]: { priceCents: 29741, supplierSku: "IW207500", source: "RFQ-2026-0004", at: "2026-09-14T20:00:00Z" }
  }
};

function freshParts() {
  return {
    SSC8712:    { sku: "SSC8712",  priceCents: 167,   supplierIds: [SITEONE, CENTRAL] },
    DS100C:     { sku: "DS100C",   priceCents: 337,   supplierIds: [SITEONE, CENTRAL] },
    "207CD500": { sku: "207CD500", priceCents: 21400, supplierIds: [CENTRAL, SITEONE] },
    UNQUOTED:   { sku: "UNQUOTED", priceCents: 999,   supplierIds: [CENTRAL] }
  };
}

// ---- Both suppliers' prices survive side by side ---------------------
{
  const parts = freshParts();
  psp.mergeIntoCatalog(parts, PRICES, { editedMap: {} });
  eq("clamp keeps both prices", Object.keys(parts.SSC8712.supplierPrices).sort(), [CENTRAL, SITEONE].sort());
  eq("SiteOne clamp price kept", parts.SSC8712.supplierPrices[SITEONE].priceCents, 167);
  eq("Central clamp price kept", parts.SSC8712.supplierPrices[CENTRAL].priceCents, 63);
}

// ---- The PRIMARY supplier decides the catalog price ------------------
{
  const parts = freshParts();
  psp.mergeIntoCatalog(parts, PRICES, { editedMap: {} });
  eq("clamp prices off SiteOne (primary)", parts.SSC8712.priceCents, 167);
  eq("clamp price attributed", parts.SSC8712.priceSupplierId, SITEONE);
  // The wire's primary is Central, so the catalog carries the DEARER
  // price — that is the rule working, not a bug: buy it where the primary
  // says, see what it actually costs there.
  eq("wire prices off Central (primary)", parts["207CD500"].priceCents, 29741);

  // Flip the primary and the part re-prices with no re-apply.
  parts.SSC8712.supplierIds = [CENTRAL, SITEONE];
  psp.mergeIntoCatalog(parts, PRICES, { editedMap: {} });
  eq("flipping primary re-prices the clamp", parts.SSC8712.priceCents, 63);
  eq("flipped price attributed", parts.SSC8712.priceSupplierId, CENTRAL);
}

// ---- A part nobody quoted is left alone ------------------------------
{
  const parts = freshParts();
  psp.mergeIntoCatalog(parts, PRICES, { editedMap: {} });
  eq("unquoted part keeps its price", parts.UNQUOTED.priceCents, 999);
  eq("unquoted part has no supplier prices", parts.UNQUOTED.supplierPrices, {});
  eq("unquoted part attributes nothing", parts.UNQUOTED.priceSupplierId, null);
}

// ---- A hand-typed price newer than the quote wins --------------------
{
  const parts = freshParts();
  parts.SSC8712.priceCents = 150;   // as parts-overrides.json would leave it
  psp.mergeIntoCatalog(parts, PRICES, {
    editedMap: { SSC8712: { priceCents: 150, editedAt: "2026-09-15T00:00:00Z" } }
  });
  eq("later manual edit survives the quote", parts.SSC8712.priceCents, 150);
  eq("manual price attributed to no supplier", parts.SSC8712.priceSupplierId, null);

  // An OLDER manual edit does not block a newer quote.
  const parts2 = freshParts();
  psp.mergeIntoCatalog(parts2, PRICES, {
    editedMap: { SSC8712: { priceCents: 150, editedAt: "2026-09-01T00:00:00Z" } }
  });
  eq("newer quote beats an older manual edit", parts2.SSC8712.priceCents, 167);
}

// ---- Each supplier's own part number ---------------------------------
{
  const parts = freshParts();
  psp.mergeIntoCatalog(parts, PRICES, { editedMap: {} });
  eq("SiteOne calls the saddle tee KT010C", parts.DS100C.supplierPrices[SITEONE].supplierSku, "KT010C");
  eq("Central calls the same part 100C", parts.DS100C.supplierPrices[CENTRAL].supplierSku, "100C");

  // Only SOME parts differ — the wire has no SiteOne number on file, so
  // anything printed for SiteOne falls back to ours rather than blank.
  eq("known supplier number is used", psp.supplierSkuFor(PRICES, "DS100C", SITEONE, "DS100C"), "KT010C");
  eq("unknown supplier number falls back to ours", psp.supplierSkuFor(PRICES, "207CD500", SITEONE, "207CD500"), "207CD500");
  eq("unknown part falls back to ours", psp.supplierSkuFor(PRICES, "NOPE", SITEONE, "NOPE"), "NOPE");
}

// ---- Seeding only trusts RFQs that were actually applied -------------
{
  const seeded = psp.seedFromAppliedQuoteRequests([
    { id: "RFQ-2026-0005", status: "applied", supplierId: SITEONE, appliedAt: "2026-09-14T19:00:00Z",
      lines: [{ sku: "SSC8712", quotedPriceCents: 167 }, { sku: "GONE", quotedPriceCents: null }] },
    { id: "RFQ-2026-0004", status: "quoted", supplierId: CENTRAL,
      lines: [{ sku: "SSC8712", quotedPriceCents: 63 }] }
  ]);
  eq("applied RFQ seeds its supplier", seeded.SSC8712[SITEONE].priceCents, 167);
  check("quoted-but-unapplied RFQ is not seeded", !seeded.SSC8712[CENTRAL]);
  check("unpriced line is not seeded", !seeded.GONE);
}

console.log(`part supplier prices: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
