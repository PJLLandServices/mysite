// Service pricing — dumb key lookup against pricing.json.
//
// 2026-05-02 SIMPLIFICATION: every bookable service in
// server/lib/availability.js now corresponds 1:1 with a pricing.json item key.
// No more zone-count disambiguation logic in here. The customer's confirmed
// zone count is captured for the work order; the price is whatever pricing.json
// says for the chosen service key.
//
// Returns { price, label, currency, custom, note? } given a bookable service key.
//
//   price:    numeric value used in totals (0 for custom-quote)
//   label:    customer-facing display string ("$95", "Free", "Custom quote")
//   custom:   true if it's a custom-quote item that doesn't add to fixed total
//   note:     optional disclaimer line shown next to the price

const path = require("path");
const fs = require("fs");

let PRICING = null;
try {
  const pricingPath = path.resolve(__dirname, "..", "..", "pricing.json");
  PRICING = JSON.parse(fs.readFileSync(pricingPath, "utf8"));
} catch (err) {
  console.error("[server/lib/pricing.js] Could not load pricing.json:", err?.message || err);
}

function formatMoney(n) {
  const cents = Math.round(n * 100) % 100;
  if (cents === 0) return n.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

// Look up a single canonical price entry.
function lookup(key) {
  if (!PRICING || !PRICING.items || !PRICING.items[key]) {
    return { price: 0, label: "Custom", currency: "CAD", custom: true };
  }
  const item = PRICING.items[key];
  const isCustom = item.quoteType === "custom";
  return {
    price: item.price,
    label: isCustom ? "Custom quote" : "$" + formatMoney(item.price),
    currency: PRICING.currency || "CAD",
    custom: isCustom
  };
}

// Special-case service keys that don't correspond directly to a pricing.json
// item or need a more elaborate label/note. Everything else falls through to
// the dumb lookup at the bottom.
function priceForBooking(serviceKey /*, zoneCountInput — no longer used */) {
  switch (serviceKey) {
    case "sprinkler_repair": {
      const r = lookup("service_call");
      return {
        ...r,
        label: r.label + " service call",
        note: "Covers mobilization + a quick on-site assessment. Diagnostic & repair labour billed separately at $95/hr. Repair quotes assume a reasonable amount of time for the diagnosed work; if it runs over, additional labour quoted on the spot before continuing. AI-intake bonus: a correct AI diagnosis earns the customer 1 hour of repair labour free."
      };
    }

    case "hydrawise_retrofit": {
      const c14 = lookup("controller_1_4");
      const c816 = lookup("controller_8_16");
      return {
        price: 0, label: "Quote on-site", currency: "CAD", custom: true,
        note: `Hydrawise pricing depends on your zone count (${c14.label} for 1-4 zones up to ${c816.label} for 8-16 zones). We confirm before any work.`
      };
    }

    case "site_visit":
      return {
        price: 0, label: "Free", currency: "CAD", custom: false,
        note: "Free walk-around with a written quote — no obligation."
      };

    default:
      // Every seasonal service key (spring_open_4z / 6z / 8z / 15z / 16plus /
      // commercial / commercial_8z / commercial_9plus, and the fall_close_
      // equivalents) maps directly to a pricing.json item. Custom-quote tiers
      // (16plus, commercial_9plus) come back as { price:0, label:"Custom quote",
      // custom:true } from the lookup above and surface that way in the UI.
      return lookup(serviceKey);
  }
}

module.exports = { priceForBooking };
