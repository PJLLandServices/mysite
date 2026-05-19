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

// Derive the seasonal pricing key for a WO when the booking didn't carry
// one (e.g., WO created from /admin/handoff with just a property, or a
// legacy lead.booking missing serviceKey). Reads pricing.json's
// canonical seasonal_tiers structure so we never duplicate the
// 1-4/5-6/7-8/9-15/16+ residential or 1-4/5-8/9+ commercial brackets in
// code. The seed paths in server.js prefer lead.booking.serviceKey when
// available (the customer paid for that exact tier); this helper is the
// fallback when that signal is missing.
//
// Args:
//   woType        — "spring_opening" | "fall_closing"
//   zoneCount     — number of zones on the linked property (default 0;
//                   0 falls into the 1-4 bracket as the safest default —
//                   a fresh WO with no property data still gets a sensible
//                   price line, fixable by the tech / Patrick)
//   commercial    — boolean (default false; we don't track commercial
//                   on the property record yet, so callers default false
//                   unless they have explicit signal)
//
// Returns: pricing.json item key (e.g. "spring_open_6z") or null if
// woType is unrecognized.
function deriveSeasonalKey(woType, zoneCount = 0, commercial = false) {
  if (!PRICING || !PRICING.seasonal_tiers) return null;
  const tierGroup = commercial ? PRICING.seasonal_tiers.commercial : PRICING.seasonal_tiers.residential;
  if (!Array.isArray(tierGroup) || !tierGroup.length) return null;
  const isSpring = woType === "spring_opening";
  const isFall   = woType === "fall_closing";
  if (!isSpring && !isFall) return null;
  const n = Math.max(0, Math.floor(Number(zoneCount) || 0));
  // Walk the tier brackets in order. Each entry's `zones` is one of
  // "1-4" / "5-6" / "7-8" / "9-15" / "16+" (residential) or "1-4" /
  // "5-8" / "9+" (commercial). Match by parsing the range — this stays
  // honest if the tier table ever gains a new bracket in pricing.json
  // without code changes here.
  for (const tier of tierGroup) {
    const range = String(tier.zones || "").trim();
    let lo = 0, hi = Infinity;
    if (range.endsWith("+")) {
      lo = parseInt(range, 10) || 0;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-").map((x) => parseInt(x, 10));
      if (Number.isFinite(a)) lo = a;
      if (Number.isFinite(b)) hi = b;
    } else {
      const single = parseInt(range, 10);
      if (Number.isFinite(single)) { lo = single; hi = single; }
    }
    // Zero zones still picks the lowest bracket (1-4 typically) — a
    // fresh property without any zones logged yet is more usefully
    // priced than left null.
    const effective = n === 0 ? lo : n;
    if (effective >= lo && effective <= hi) {
      return isSpring ? tier.key_spring : tier.key_fall;
    }
  }
  // Past the top tier — fall through to the last bracket's key (16+
  // residential / 9+ commercial). Those are custom-quote tiers
  // (price 0) so the WO will show $0 and Patrick can quote on-site.
  const last = tierGroup[tierGroup.length - 1];
  return isSpring ? (last.key_spring || null) : (last.key_fall || null);
}

// Resolve the canonical seasonal price for a property + service type.
// Property override (property.seasonalPricing.springOpeningPrice or
// fallClosingPrice) wins; falls back to the pricing.json tier lookup
// by zone count via deriveSeasonalKey(). Per
// feature-per-property-seasonal-pricing-brief.md §3.2 this is the
// ONLY entry point for seasonal-fee resolution going forward —
// priceForBooking() stays for non-seasonal services.
//
// service_call ($95 mobilization) is intentionally NOT overridable
// per-property — the brief calls it out in §6. This helper enforces
// that by refusing any service type other than spring_opening /
// fall_closing.
//
// Args:
//   property     — full property record (any shape; missing
//                  seasonalPricing falls back cleanly)
//   serviceType  — "spring_opening" | "fall_closing"
//
// Returns:
//   {
//     price: number,           // dollars (rounded to cents)
//     source: "property_override" | "pricing_json_tier" | "custom_quote_required",
//     label: string,           // "$120.00" or "Custom quote"
//     custom: boolean,         // true when no flat price (caller must
//                              // not seed a baseline line — surface a
//                              // custom-quote banner instead)
//     key:   string | null,    // pricing.json item key when tier-resolved
//     zoneCount: number,       // input used for tier lookup (0 when no override hit)
//     tier:  string | null     // human-readable tier label (e.g. "Spring opening — 7-8 zones residential")
//   }
function resolveSeasonalPrice(property, serviceType) {
  if (serviceType !== "spring_opening" && serviceType !== "fall_closing") {
    throw new Error(
      `resolveSeasonalPrice: serviceType must be 'spring_opening' or 'fall_closing' (got '${serviceType}'). Per-property overrides do not apply to other services — service_call stays canonical.`
    );
  }
  const sp = (property && typeof property === "object" && property.seasonalPricing && typeof property.seasonalPricing === "object")
    ? property.seasonalPricing
    : {};
  const overrideField = serviceType === "spring_opening" ? "springOpeningPrice" : "fallClosingPrice";
  const rawOverride = sp[overrideField];
  if (rawOverride !== null && rawOverride !== undefined) {
    const n = Number(rawOverride);
    if (Number.isFinite(n) && n >= 0) {
      const rounded = Math.round(n * 100) / 100;
      return {
        price: rounded,
        source: "property_override",
        label: "$" + formatMoney(rounded),
        custom: false,
        key: null,
        zoneCount: 0,
        tier: null
      };
    }
  }
  // Tier fallback. Zone count drives the bracket; missing zones bucket
  // into the 1-4 tier (deriveSeasonalKey's existing behavior).
  const zoneCount = Array.isArray(property?.system?.zones)
    ? property.system.zones.length
    : 0;
  const key = deriveSeasonalKey(serviceType, zoneCount, false);
  if (!key || !PRICING?.items?.[key]) {
    // Defensive: pricing.json never has this state today, but guard so
    // callers always get the documented shape.
    return {
      price: 0, source: "custom_quote_required",
      label: "Custom quote", custom: true,
      key, zoneCount, tier: null
    };
  }
  const item = PRICING.items[key];
  if (item.quoteType === "custom") {
    return {
      price: 0, source: "custom_quote_required",
      label: "Custom quote", custom: true,
      key, zoneCount, tier: item.label
    };
  }
  const price = Math.round((Number(item.price) || 0) * 100) / 100;
  return {
    price,
    source: "pricing_json_tier",
    label: "$" + formatMoney(price),
    custom: false,
    key,
    zoneCount,
    tier: item.label
  };
}

module.exports = { priceForBooking, deriveSeasonalKey, resolveSeasonalPrice };
