// Service pricing — tier + zone-count aware.
//
// Returns { price, label, currency, custom, note? } given a bookable service
// key and the customer-confirmed zone count from the booking flow.
//
//   price:    numeric value used in totals (0 for custom-quote)
//   label:    customer-facing display string ("$95", "Starts at $120", "Free", "Custom quote")
//   custom:   true if it's a custom-quote item that doesn't add to fixed total
//   note:     optional disclaimer line shown next to the price
//
// Pricing source: master_pricing.md (locked 2026-04-28). Where the booking
// tier overlaps multiple price brackets (e.g. fall_close_6z covers 1-6 zones,
// which spans ≤4z @ $90 and 5-6z @ $95), we use the customer's confirmed
// zone count to pick the right bracket. When zone count is unknown ("unsure"
// or absent), default to the upper end of the bracket so we don't underquote
// — Patrick can adjust down on-site if the actual count is lower.

function priceForBooking(serviceKey, zoneCountInput) {
  const zones = (typeof zoneCountInput === "number")
    ? zoneCountInput
    : (/^\d+$/.test(String(zoneCountInput || "")) ? Number(zoneCountInput) : null);

  switch (serviceKey) {
    // --- Spring openings ---
    case "spring_open_4z":
      return { price: 90, label: "$90", currency: "CAD", custom: false };

    case "spring_open_8z":
      // 5-7 zones — falls in master pricing's "≤8 zones residential = $120" bracket.
      return { price: 120, label: "$120", currency: "CAD", custom: false };

    case "spring_open_15z":
      // 8+ zones — beyond master pricing's defined residential brackets.
      return {
        price: 120, label: "Starts at $120", currency: "CAD", custom: false,
        note: "Final price confirmed on-site for systems with 12+ zones."
      };

    case "spring_open_commercial":
      return { price: 285, label: "$285", currency: "CAD", custom: false };

    // --- Fall winterizations ---
    case "fall_close_6z":
      // ≤6 zones — could be $90 (≤4) or $95 (5-6).
      if (zones != null && zones <= 4) {
        return { price: 90, label: "$90", currency: "CAD", custom: false };
      }
      return { price: 95, label: "$95", currency: "CAD", custom: false };

    case "fall_close_15z":
      // 7-12 zones — could be $120 (≤8) or $145 (9-15).
      if (zones != null && zones <= 8) {
        return { price: 120, label: "$120", currency: "CAD", custom: false };
      }
      return { price: 145, label: "$145", currency: "CAD", custom: false };

    case "fall_close_large":
      // 13+ zones — beyond master pricing's defined residential brackets.
      return {
        price: 145, label: "Starts at $145", currency: "CAD", custom: false,
        note: "Final price confirmed on-site for systems with 16+ zones."
      };

    case "fall_close_commercial":
      return {
        price: 0, label: "Custom quote", currency: "CAD", custom: true,
        note: "We'll quote based on your specific commercial property and zone count after the site assessment."
      };

    // --- Repairs / retrofits / consults ---
    case "sprinkler_repair":
      return {
        price: 95, label: "$95 service call", currency: "CAD", custom: false,
        note: "Includes mobilization + 1 hour of on-site diagnostic & labour. Parts + extra labour quoted on the spot before any work."
      };

    case "hydrawise_retrofit":
      return {
        price: 0, label: "Quote on-site", currency: "CAD", custom: true,
        note: "Hydrawise pricing depends on your zone count ($595 for 1-4 zones up to $1,195 for 8-16 zones). We confirm before any work."
      };

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
