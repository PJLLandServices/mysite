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

// The one zone-count rule, shared by every tier lookup: zones the
// technician DOCUMENTED (property.system.zones[]) always win; a
// DECLARED count (property.system.zoneCount — the customer's own
// number from booking or their appointment page, or a manual entry)
// fills in only while nothing is mapped yet. assignments.zoneCountFor
// and resequence.onSiteMinutes lean on this same helper so the tier a
// customer is booked at, the price they are shown, and the minutes the
// sequencer plans for them can never disagree about how many zones
// they have.
function effectiveZoneCount(property) {
  const documented = Array.isArray(property?.system?.zones) ? property.system.zones.length : 0;
  if (documented > 0) return documented;
  const declared = Math.floor(Number(property?.system?.zoneCount) || 0);
  return declared > 0 ? declared : 0;
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
//
// Options (fall-closing fix #7), both defaulting to the old behaviour:
//   commercial — the owner's accountType is "commercial": use the
//                commercial tier table. Was hard-coded false, so a
//                commercial site was always priced residential.
//   zoneCount  — the zones actually on the work order, when known. A job
//                booked at 4 zones where the tech walked 6 bills the 5-6
//                tier, not the tier it was booked at.
function resolveSeasonalPrice(property, serviceType, { commercial = false, zoneCount: zoneCountOverride = null } = {}) {
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
  // Tier fallback. Zone count drives the bracket — documented zones
  // first, the declared count when nothing is mapped (effectiveZoneCount
  // above); missing both buckets into the 1-4 tier (deriveSeasonalKey's
  // existing behavior).
  const overrideCount = Math.floor(Number(zoneCountOverride) || 0);
  const zoneCount = overrideCount > 0 ? overrideCount : effectiveZoneCount(property);
  const key = deriveSeasonalKey(serviceType, zoneCount, commercial === true);
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


// ---- Suggested price for a closing Patrick prices himself (PJL-96) -----
//
// Ruling (Patrick, 2026-09-23): 16+ zone residential and 9+ zone
// commercial are priced by Patrick, and so is every commercial account
// without a price of its own. The system SUGGESTS a price from the zone
// count so he has something to go off; he confirms or changes it on the
// office invoice before anything is payable.
//
// THE RULE — pricing.json only, no typed prices (Hard Rule 21):
//   Take the LAST TWO PRICED tiers of seasonal_tiers.<group> (custom-quote
//   tiers skipped). Place each at its UPPER zone bound and its pricing.json
//   item price, and extend the per-zone slope between them past the top
//   priced tier:
//
//     perZone   = (price[top] − price[prev]) / (upper[top] − upper[prev])
//     suggested = price[top] + (zones − upper[top]) × perZone
//
//   rounded to the whole dollar. On today's table that is residential
//   7–8 → 9–15 and commercial 1–4 → 5–8. If pricing.json gains a tier,
//   the rule follows it with no code change.
//
//   Inside a priced tier (a commercial account with no price of its own,
//   ruling 2) the suggestion is simply that tier's price.
//
// Returns { amount, perZone, zones, tier, extraZones, key, basis } — basis
// is the arithmetic in words, shown to Patrick on the office invoice and
// never to the customer — or null when the table has no priced tier.
function tierRange(t) {
  const r = String(t?.zones || "").trim();
  const lo = parseInt(r, 10) || 0;
  if (r.endsWith("+")) return { lo, hi: Infinity };
  if (r.includes("-")) {
    const hi = parseInt(r.split("-")[1], 10);
    return { lo, hi: Number.isFinite(hi) ? hi : lo };
  }
  return { lo, hi: lo };
}
const dollars = (n) => "$" + formatMoney(Math.round(Number(n) * 100) / 100);

function suggestSeasonalPrice(woType, zoneCount, group = "residential") {
  const tiers = PRICING?.seasonal_tiers?.[group];
  if (!Array.isArray(tiers)) return null;
  const keyField = woType === "spring_opening" ? "key_spring" : "key_fall";
  const priced = tiers
    .map((t) => ({ t, key: t[keyField], item: PRICING.items?.[t[keyField]], ...tierRange(t) }))
    .filter((x) => x.item && x.item.quoteType !== "custom" && Number(x.item.price) > 0 && Number.isFinite(x.hi));
  if (!priced.length) return null;
  const zones = Math.max(0, Math.floor(Number(zoneCount) || 0));
  const where = group === "commercial" ? "commercial " : "";
  const n = Math.max(zones, priced[0].lo);
  const inTier = priced.find((x) => n >= x.lo && n <= x.hi);
  if (inTier || priced.length < 2) {
    const x = inTier || priced[priced.length - 1];
    const amount = Math.round(Number(x.item.price));
    return {
      amount, perZone: null, zones, tier: x.t.zones, extraZones: 0, key: x.key,
      basis: `${zones} zone${zones === 1 ? "" : "s"}: suggested ${dollars(amount)}, the ${where}${x.t.zones} zone tier`
    };
  }
  const prev = priced[priced.length - 2];
  const top = priced[priced.length - 1];
  const perZone = (Number(top.item.price) - Number(prev.item.price)) / (top.hi - prev.hi);
  const extraZones = zones - top.hi;
  const amount = Math.round(Number(top.item.price) + extraZones * perZone);
  return {
    amount, perZone: Math.round(perZone * 100) / 100, zones, tier: top.t.zones, extraZones, key: top.key,
    basis: `${zones} zones: suggested ${dollars(amount)}, from the ${where}${top.t.zones} zone tier (${dollars(top.item.price)}) `
      + `plus ${extraZones} zone${extraZones === 1 ? "" : "s"} at ${dollars(perZone)}/zone`
  };
}

// ---- The seasonal fee POLICY (PJL-96) ----------------------------------
//
// Which price a spring opening / fall closing carries:
//
//   1. The property has its own price (seasonalPricing override)
//        → that price, confirmed. Residential or commercial alike. (There is
//        no account-level price on the customer record today.)
//   2. A COMMERCIAL account with no price of its own → PRICE PENDING,
//      reason "commercial_unpriced". The commercial tier table is not
//      their price (ruling 2); it is only the suggestion.
//   3. A custom-quote size (16+ residential, 9+ commercial) → PRICE
//      PENDING, reason "custom_size" (ruling 3).
//   4. Otherwise → the pricing.json tier price, confirmed.
//
// Returns { status: "confirmed"|"pending", price, key, source, tier,
// reason, zoneCount }. A pending decision carries NO price: the work order
// the customer signs never shows a number PJL has not set. The suggestion
// is computed only when the office invoice is drafted (billableLines).
const PRICE_PENDING_NOTES = {
  custom_size: "Custom size — PJL confirms the price",
  commercial_unpriced: "Commercial account — PJL confirms the price"
};
function seasonalFeeDecision(property, serviceType, { commercial = false, zoneCount = null } = {}) {
  const resolved = resolveSeasonalPrice(property || {}, serviceType, { commercial, zoneCount });
  const zones = Math.floor(Number(zoneCount) || 0) > 0 ? Math.floor(Number(zoneCount)) : effectiveZoneCount(property);
  if (resolved.source === "property_override") {
    return { status: "confirmed", price: resolved.price, key: resolved.key, source: resolved.source, tier: null, reason: null, zoneCount: zones };
  }
  if (commercial === true || resolved.custom) {
    return {
      status: "pending", price: null,
      key: resolved.key || deriveSeasonalKey(serviceType, zones, commercial === true) || "",
      source: "price_pending", tier: resolved.tier || null,
      reason: commercial === true ? "commercial_unpriced" : "custom_size",
      zoneCount: zones
    };
  }
  return { status: "confirmed", price: resolved.price, key: resolved.key, source: resolved.source, tier: resolved.tier || null, reason: null, zoneCount: zones };
}

// A seasonal fee line marked price-pending: no price, the reason, and the
// customer-safe note. The zones it was decided on ride in source so the
// office invoice's suggestion is computed from the same count.
function pendingFeeLine(line, decision) {
  return {
    ...line,
    key: decision.key || line.key || "",
    originalPrice: null,
    overridePrice: null,
    custom: true,
    priceStatus: "pending",
    priceReason: decision.reason,
    note: PRICE_PENDING_NOTES[decision.reason] || PRICE_PENDING_NOTES.custom_size,
    source: { ...(line.source || {}), baseline: true, recordedZones: decision.zoneCount }
  };
}
const isPricePending = (line) => line?.priceStatus === "pending";

// The seasonal baseline line in a builder list, or -1.
function feeLineIndex(lines) {
  return (Array.isArray(lines) ? lines : []).findIndex((l) => l && l.source && l.source.baseline === true
    && !l.source.propertyAdditionalFallBlowout && l.key !== "fall_additional_plumbing" && !l.source.aiBonusCredit);
}

// The lines a work order BILLS. A price-pending fee line becomes a
// SUGGESTED line priced by suggestSeasonalPrice — the invoice then drafts
// with that amount prefilled and flagged for Patrick to confirm
// (invoices.createDraft reads priceStatus "suggested"). Every other line
// passes through untouched. Used by the completion cascade and the manual
// create-invoice route, so both bill the same way.
function billableLines(wo, lines) {
  const list = Array.isArray(lines) ? lines : [];
  if (!list.some(isPricePending)) return list;
  return list.map((l) => {
    if (!isPricePending(l)) return l;
    const zones = Number.isFinite(Number(l.source?.recordedZones)) ? Number(l.source.recordedZones) : 0;
    const s = suggestSeasonalPrice(wo?.type, zones, l.priceReason === "commercial_unpriced" ? "commercial" : "residential");
    return { ...l, originalPrice: s ? s.amount : 0, priceStatus: "suggested", suggestion: s };
  });
}

// The seasonal fee a work order should bill, from the zones actually on it
// (fall-closing fix #7). The baseline line is seeded when the WO is opened
// — from the BOOKED count — and the cascade used to bill that snapshot, so
// 4 booked / 6 walked billed the 1-4 tier. This re-resolves the same line
// through seasonalFeeDecision at completion (and for the app's preview):
//
//   * a per-property override still wins (it is resolveSeasonalPrice's
//     first rule — grandfathered/legacy rates included);
//   * a line Patrick priced by hand on this WO (overridePrice) is left alone;
//   * a custom-quote size or a commercial account without its own price
//     becomes PRICE PENDING (PJL-96) — no flat price, Patrick confirms it on
//     the office invoice — and a job with NO seeded line of that kind gets
//     one inserted, so it can never close as free;
//   * only the seasonal baseline line moves; the additional-plumbing line
//     and anything else is untouched.
//
// Returns { lines, changed, before, after, zoneCount, customQuote?,
// pending?, inserted? } — `lines` is the full builder list with the
// baseline replaced (or inserted) when changed. `after` for a pending line
// is { key, price: null, custom: true, pending: true, reason }.
//
// The note that marked a custom line on drafts made before PJL-96. Still
// read (invoices.isPriceUnconfirmed) so those drafts stay unpayable too.
const CUSTOM_QUOTE_NOTE_PREFIX = "Custom quote — Patrick to price";
//
// NOTHING IS RE-PRICED AFTER SIGNING (PJL-96, ruling 1). The fee line is
// priced at the moment the signature or bypass freezes the work order
// (pricedQuoteForLock below, which stamps source.pricedAtLock). Pass
// `frozen: true` for a locked WO: a stamped line then stands exactly as
// signed — the signed WO, the report and the invoice carry one number.
// An UNSTAMPED line on a locked WO (signed before this rule) still gets
// the re-resolve, as the safety net it always was.
function refreshSeasonalBaseline(wo, property, { commercial = false, frozen = false } = {}) {
  const lines = Array.isArray(wo?.onSiteQuote?.builderLineItems) ? wo.onSiteQuote.builderLineItems : [];
  const none = { lines, changed: false, before: null, after: null, zoneCount: 0 };
  if (wo?.type !== "spring_opening" && wo?.type !== "fall_closing") return none;
  const idx = feeLineIndex(lines);
  const zoneCount = Array.isArray(wo.zones) ? wo.zones.filter((z) => z && (z.kind || "zone") === "zone").length : 0;
  if (frozen && idx !== -1 && lines[idx]?.source?.pricedAtLock) {
    const signed = lines[idx];
    const asSigned = isPricePending(signed)
      ? { key: signed.key || "", price: null, custom: true, pending: true, reason: signed.priceReason || null }
      : { key: signed.key || "", price: Number(signed.overridePrice ?? signed.originalPrice) || 0 };
    return { ...none, zoneCount, lockedAtSigning: true, pending: isPricePending(signed), customQuote: isPricePending(signed),
      before: asSigned, after: asSigned };
  }
  const decision = seasonalFeeDecision(property || {}, wo.type, { commercial, zoneCount });
  const pendingAfter = { key: decision.key || "", price: null, custom: true, pending: true, reason: decision.reason, source: decision.source, tier: decision.tier || null };
  if (idx === -1) {
    // No seeded line. A size Patrick prices (or an unpriced commercial
    // account) gets a price-pending line INSERTED: before PJL-96 this job
    // drafted no invoice at all and read "no charge".
    if (decision.status !== "pending") return none;
    const year = new Date(wo.scheduledFor || wo.createdAt || Date.now()).getUTCFullYear();
    const base = {
      key: decision.key || "",
      label: `${wo.type === "spring_opening" ? "Spring Opening" : "Fall Closing"} (${year})`,
      qty: 1,
      source: { zoneNumbers: [], issueIds: [], baseline: true }
    };
    return { lines: [pendingFeeLine(base, decision), ...lines], changed: true, customQuote: true, pending: true, inserted: true,
      before: null, after: pendingAfter, zoneCount };
  }
  const line = lines[idx];
  if (line.overridePrice != null && line.overridePrice !== "") return { ...none, zoneCount };
  const before = isPricePending(line)
    ? { key: line.key || "", price: null, pending: true }
    : { key: line.key || "", price: Number(line.originalPrice) || 0 };
  if (decision.status === "pending") {
    const nextLine = pendingFeeLine(line, decision);
    const same = isPricePending(line) && line.key === nextLine.key && line.priceReason === nextLine.priceReason
      && Number(line.source?.recordedZones) === zoneCount;
    if (same) return { ...none, zoneCount, customQuote: true, pending: true, before, after: pendingAfter };
    const next = [...lines];
    next[idx] = nextLine;
    return { lines: next, changed: true, customQuote: true, pending: true, before, after: pendingAfter, zoneCount };
  }
  const after = { key: decision.key || line.key || "", price: decision.price, source: decision.source, tier: decision.tier || null };
  if (!isPricePending(line) && before.price === after.price && before.key === after.key) return { ...none, zoneCount, before, after };
  const next = [...lines];
  const { priceStatus: _ps, priceReason: _pr, ...rest } = line;
  const staleNote = rest.note === "Per-property rate" || Object.values(PRICE_PENDING_NOTES).includes(rest.note);
  next[idx] = {
    ...rest,
    key: after.key,
    originalPrice: after.price,
    custom: false,
    note: decision.source === "property_override" ? "Per-property rate" : (staleNote ? "" : (rest.note || ""))
  };
  return { lines: next, changed: true, before, after, zoneCount };
}

// The seasonal fee, priced the moment the work order is signed (PJL-96,
// ruling 1). Called at BOTH lock points — the customer's signature and the
// nobody-home bypass — with the WO as it stands just before it freezes
// (`zones` = zones carried in the same signing payload, if any). Re-prices
// the fee line from the zones recorded (refreshSeasonalBaseline: tier,
// override, or price pending) and stamps it source.pricedAtLock, so the
// work order the customer signs carries the price the invoice will bill,
// and nothing moves it afterwards. Returns { onSiteQuote, refresh } or
// null when there is no seasonal fee to price.
function pricedQuoteForLock(wo, property, { commercial = false, zones = null } = {}) {
  if (wo?.type !== "spring_opening" && wo?.type !== "fall_closing") return null;
  const view = Array.isArray(zones) ? { ...wo, zones } : wo;
  const refresh = refreshSeasonalBaseline(view, property, { commercial });
  const idx = feeLineIndex(refresh.lines);
  if (idx === -1) return null;
  const lines = refresh.lines.slice();
  lines[idx] = { ...lines[idx], source: { ...(lines[idx].source || {}), pricedAtLock: new Date().toISOString(), recordedZones: refresh.zoneCount } };
  return { onSiteQuote: { ...(wo.onSiteQuote || {}), builderLineItems: lines }, refresh };
}

module.exports = {
  priceForBooking, deriveSeasonalKey, resolveSeasonalPrice, effectiveZoneCount, refreshSeasonalBaseline, CUSTOM_QUOTE_NOTE_PREFIX,
  // PJL-96
  suggestSeasonalPrice, seasonalFeeDecision, pendingFeeLine, isPricePending, feeLineIndex, billableLines, PRICE_PENDING_NOTES,
  pricedQuoteForLock
};
