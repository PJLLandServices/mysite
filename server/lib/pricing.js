// Service pricing — tier + zone-count aware. Reads pricing.json (the canonical
// source) and applies tier-disambiguation logic for booking-flow services that
// span multiple price brackets.
//
// Returns { price, label, currency, custom, note? } given a bookable service
// key and the customer-confirmed zone count from the booking flow.
//
//   price:    numeric value used in totals (0 for custom-quote)
//   label:    customer-facing display string ("$95", "Starts at $120", "Free", "Custom quote")
//   custom:   true if it's a custom-quote item that doesn't add to fixed total
//   note:     optional disclaimer line shown next to the price
//
// Pricing source: pricing.json (loaded once at module init). The seasonal tier
// structure mirrors the live interactive calculators on
// sprinkler-spring-opening.html / sprinkler-fall-winterization.html — see
// pricing.json's `seasonal_tiers` reference table.
//
// Booking service keys map to pricing.json keys as follows:
//
//   spring_open_4z         → spring_open_4z (always)
//   spring_open_8z         → spring_open_6z if zones ≤6 else spring_open_8z (5-8 range)
//   spring_open_15z        → spring_open_15z if zones ≤15 else spring_open_16plus (9+)
//   spring_open_commercial → spring_open_commercial if zones ≤4
//                           spring_open_commercial_8z if zones ≤8
//                           spring_open_commercial_9plus otherwise
//   fall_close_6z          → fall_close_4z if zones ≤4 else fall_close_6z (1-6 range)
//   fall_close_15z         → fall_close_8z if zones ≤8 else fall_close_15z (7-15 range)
//   fall_close_large       → fall_close_15z if zones ≤15 else fall_close_16plus
//   fall_close_commercial  → fall_close_commercial / _8z / _9plus by zone count
//
// When zone count is unknown ("unsure" or absent), default to the upper end of
// each tier so we don't underquote — Patrick can adjust down on-site if the
// actual count is lower.

const path = require("path");
const fs = require("fs");

let PRICING = null;
try {
  const pricingPath = path.resolve(__dirname, "..", "..", "pricing.json");
  PRICING = JSON.parse(fs.readFileSync(pricingPath, "utf8"));
} catch (err) {
  console.error("[server/lib/pricing.js] Could not load pricing.json:", err?.message || err);
  // Module callers must handle null prices gracefully — but in practice this
  // means the server failed to boot earlier when loading pricing.json itself.
}

// Look up a single canonical price entry. Returns { price, label, currency, custom }.
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

function formatMoney(n) {
  const cents = Math.round(n * 100) % 100;
  if (cents === 0) return n.toFixed(0).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return n.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function priceForBooking(serviceKey, zoneCountInput) {
  const zones = (typeof zoneCountInput === "number")
    ? zoneCountInput
    : (/^\d+$/.test(String(zoneCountInput || "")) ? Number(zoneCountInput) : null);

  switch (serviceKey) {
    // --- Spring openings ---
    case "spring_open_4z":
      return lookup("spring_open_4z");

    case "spring_open_8z":
      // Booking variant covers the 5-8 residential range — split between
      // 5-6z ($105) and 7-8z ($120). Default to upper end if zones unknown.
      if (zones != null && zones <= 6) return lookup("spring_open_6z");
      return lookup("spring_open_8z");

    case "spring_open_15z": {
      // Booking variant covers 9+ residential. 9-15z is $165; 16+ is custom.
      if (zones != null && zones >= 16) {
        const r = lookup("spring_open_16plus");
        return { ...r, note: "16+ zone systems quoted on-site after a free assessment." };
      }
      const r = lookup("spring_open_15z");
      return { ...r, label: "Starts at " + r.label, note: "Final price confirmed on-site for systems with 12+ zones. Extended-time fees may apply." };
    }

    case "spring_open_commercial": {
      // Tiered commercial: 1-4z $145, 5-8z $255, 9+z custom.
      if (zones != null && zones >= 9) {
        const r = lookup("spring_open_commercial_9plus");
        return { ...r, note: "9+ zone commercial quoted on-site after a free assessment." };
      }
      if (zones != null && zones >= 5) return lookup("spring_open_commercial_8z");
      return lookup("spring_open_commercial");
    }

    // --- Fall winterizations ---
    case "fall_close_6z":
      // Booking variant covers ≤6 residential — split between 4z ($90) and 6z ($105).
      if (zones != null && zones <= 4) return lookup("fall_close_4z");
      return lookup("fall_close_6z");

    case "fall_close_15z":
      // Booking variant covers 7-12z residential — split between 8z ($120) and 15z ($165).
      if (zones != null && zones <= 8) return lookup("fall_close_8z");
      return lookup("fall_close_15z");

    case "fall_close_large": {
      // Booking variant covers 13+z residential. 13-15z = $165; 16+ = custom.
      if (zones != null && zones >= 16) {
        const r = lookup("fall_close_16plus");
        return { ...r, note: "16+ zone systems quoted on-site after a free assessment." };
      }
      const r = lookup("fall_close_15z");
      return { ...r, label: "Starts at " + r.label, note: "Final price confirmed on-site for systems with 16+ zones. Extended-time fees may apply." };
    }

    case "fall_close_commercial": {
      // Tiered commercial: 1-4z $145, 5-8z $255, 9+z custom.
      if (zones != null && zones >= 9) {
        const r = lookup("fall_close_commercial_9plus");
        return { ...r, note: "9+ zone commercial quoted on-site after a free assessment." };
      }
      if (zones != null && zones >= 5) return lookup("fall_close_commercial_8z");
      return lookup("fall_close_commercial");
    }

    // --- Repairs / retrofits / consults ---
    case "sprinkler_repair": {
      const r = lookup("service_call");
      return {
        ...r,
        label: r.label + " service call",
        note: "Includes mobilization + 1 hour of on-site diagnostic & labour. Parts + extra labour quoted on the spot before any work."
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
      return { price: 0, label: "Custom", currency: "CAD", custom: true };
  }
}

module.exports = { priceForBooking };
