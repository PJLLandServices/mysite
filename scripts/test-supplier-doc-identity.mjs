#!/usr/bin/env node
// What a supplier document says about the PARTS — their number, and a
// description that names nobody else.
//
// Two real failures on PO-2026-0012 (sent to Central Pro, 2026-09-21):
//   1. The email's quick-paste block — the one the branch pastes straight
//      into their system — listed OUR SKUs (207CD500, SSC8712), which
//      resolve to nothing at their counter. The PDF and CSV had already
//      been taught their numbers; the email had not.
//   2. A catalog description still carried an import-era tag naming the
//      OTHER supplier — "Standard irrigation wire HD poly jacket 500 ft
//      (SiteOne 207CD500)" — so Central's own purchase order quoted
//      SiteOne's part number back at them.
//
// Both assertions below fail against the pre-fix code: renderQuickPaste*
// took no sku resolver, and resolveLineDescription passed the tag through
// untouched.

import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const fmt = require(path.join(here, "..", "server", "lib", "format.js"));
const notify = require(path.join(here, "..", "server", "lib", "notify-supplier.js"));

let passed = 0, failed = 0;
function check(name, cond, detail = "") {
  if (cond) { passed++; }
  else { failed++; console.log(`  FAIL  ${name}${detail ? " — " + detail : ""}`); }
}
function eq(name, got, want) {
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

const CENTRAL = "SUP-001";
const SITEONE = "SUP-002";

const PARTS = {
  "207CD500": {
    sku: "207CD500",
    description: "Standard irrigation wire HD poly jacket 500 ft (SiteOne 207CD500)",
    unit: "spool",
    supplierPrices: {
      [CENTRAL]: { priceCents: 29741, supplierSku: "IW207500" },
      [SITEONE]: { priceCents: 21400, supplierSku: "207CD500" }
    }
  },
  SSC8712: {
    sku: "SSC8712",
    description: "Boshart #12 301 Stainless Steel Clamp",
    unit: "each",
    supplierPrices: { [CENTRAL]: { priceCents: 63, supplierSku: "SC7712" } }
  },
  PP125X300: {
    sku: "PP125X300",
    description: "Poly Pipe 1-1/4 in. x 300 ft. Non-NSF 100 PSI (price per roll)",
    unit: "roll",
    supplierPrices: { [CENTRAL]: { priceCents: 19221, supplierSku: "POPO125300" } }
  }
};

// ---- A description on a vendor document names no other vendor ---------
{
  const line = { sku: "207CD500", qty: 2 };
  const desc = fmt.resolveLineDescription(line, PARTS);
  eq("the rival's tag is gone", desc, "Standard irrigation wire HD poly jacket 500 ft");
  check("no supplier name survives", !/SiteOne|Central/i.test(desc), desc);

  // A stored line description carries the same tag once it is snapshotted
  // onto a PO line, so it has to be scrubbed on that path too.
  const snapshotted = fmt.resolveLineDescription(
    { sku: "207CD500", description: "Standard irrigation wire HD poly jacket 500 ft (SiteOne 207CD500)" },
    PARTS
  );
  check("a snapshotted description is scrubbed too", !/SiteOne/i.test(snapshotted), snapshotted);

  // Parentheticals that are NOT part numbers must survive untouched.
  eq("a plain note survives", fmt.resolveLineDescription({ sku: "PP125X300" }, PARTS),
     "Poly Pipe 1-1/4 in. x 300 ft. Non-NSF 100 PSI (price per roll)");
  eq("(New) survives", fmt.stripSupplierTag("Rain Bird Xeri Dripline 17Mm Tee (New)"),
     "Rain Bird Xeri Dripline 17Mm Tee (New)");
}

// ---- The email's paste block carries THEIR number ---------------------
{
  const po = {
    id: "PO-2026-0012",
    supplierId: CENTRAL,
    supplierName: "Central Pro Supply",
    subtotalCents: 30000,
    lineItems: [
      { sku: "207CD500", qty: 2, unitPriceCents: 29741, lineTotalCents: 59482 },
      { sku: "SSC8712", qty: 150, unitPriceCents: 63, lineTotalCents: 9450 }
    ]
  };
  const describeLine = (l) => fmt.resolveLineDescription(l, PARTS);
  const skuForLine = (l) => fmt.resolveSupplierSku(l, PARTS, po.supplierId);
  const { text, html } = notify.buildPoEmail({ po, toName: "Concord branch", describeLine, skuForLine });

  check("plain-text block shows their wire number", text.includes("IW207500"), "missing IW207500");
  check("plain-text block shows their clamp number", text.includes("SC7712"), "missing SC7712");
  check("html block shows their wire number", html.includes("IW207500"), "missing IW207500");
  check("our SKU is still there to match back", text.includes("207CD500") && text.includes("SSC8712"));
  check("no rival supplier named anywhere in the email", !/SiteOne/i.test(text) && !/SiteOne/i.test(html));

  // Without a resolver the block must still work — our SKU, as before.
  const plain = notify.buildPoEmail({ po, toName: "Concord branch", describeLine });
  check("falls back to our SKU when no resolver is given", plain.text.includes("207CD500"));
}

console.log(`supplier doc identity: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
