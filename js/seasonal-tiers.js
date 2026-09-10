/* =============================================================
   PJL SEASONAL TIERS — shared tier resolution.

   pricing.json's seasonal_tiers block is the one place the seasonal
   zone brackets, their prices and their booking keys are written down:

     { "zones": "1-4", "price": 90,
       "key_spring": "spring_open_4z", "key_fall": "fall_close_4z" }

   Every customer-facing surface that has to answer "which tier is this
   visitor in?" resolves it through here, so the seasonal pages' price
   readout and book.html's zone confirmation can never disagree about
   where a bracket ends.

   Served to the browser at /api/pricing and published on
   window.__pjlPricing by js/pricing-injector.js.

   Consumers:
     js/seasonal-zone-calculator.js  (the spring / fall page estimators)
     js/booking.js                   (book.html's zone-confirmation step)

   No DOM, no fetching — pure resolution over a seasonal_tiers object.
   ============================================================= */
(function (global) {
  "use strict";

  // "1-4" / "5–6" / "16+" / "7" -> { min, max }. Anything unparseable
  // returns null and is skipped by the caller rather than guessed at, so a
  // malformed row can never silently mis-tier somebody.
  function parseRange(text) {
    var m = /^(\d+)\s*\+$/.exec(text);
    if (m) return { min: +m[1], max: Infinity };
    m = /^(\d+)\s*[-–—]\s*(\d+)$/.exec(text);
    if (m) return { min: +m[1], max: +m[2] };
    m = /^(\d+)$/.exec(text);
    if (m) return { min: +m[1], max: +m[1] };
    return null;
  }

  // Wording the seasonal pages ship with: "Up to 4 zones" / "5–6 zones"
  // / "16+ zones".
  function rangeLabel(range) {
    if (range.max === Infinity) return range.min + "+ zones";
    if (range.min <= 1) return "Up to " + range.max + " zones";
    return range.min + "–" + range.max + " zones";
  }

  // Normalise one group ("residential" | "commercial") of raw pricing.json
  // rows into sorted tier objects. `season` is "spring" | "fall" and picks
  // which of the row's two keys travels with the tier.
  function normalise(rows, season) {
    var field = season === "fall" ? "key_fall" : "key_spring";
    var out = [];
    (rows || []).forEach(function (row) {
      if (!row) return;
      var range = parseRange(String(row.zones || "").trim());
      if (!range) return;
      var price = Number(row.price);
      var custom = row.custom === true || !(price > 0);
      out.push({
        min: range.min,
        max: range.max,
        price: custom ? null : price,
        key: row[field] || null,
        custom: custom,
        label: rangeLabel(range)
      });
    });
    out.sort(function (a, b) { return a.min - b.min; });
    return out.length ? out : null;
  }

  // seasonal_tiers -> { residential: [...], commercial: [...] } or null if
  // either group is missing/unusable. Callers treat null as "not loaded"
  // and fall back to whatever the page already shows.
  function build(seasonalTiers, season) {
    if (!seasonalTiers) return null;
    var residential = normalise(seasonalTiers.residential, season);
    var commercial = normalise(seasonalTiers.commercial, season);
    if (!residential || !commercial) return null;
    return { residential: residential, commercial: commercial };
  }

  // The tier a given zone count falls in. Counts past the last bracket
  // land in it — that bracket is open-ended ("16+") by construction.
  function tierFor(tiers, mode, zones) {
    if (!tiers) return null;
    var rows = tiers[mode === "commercial" ? "commercial" : "residential"] || tiers.residential;
    for (var i = 0; i < rows.length; i++) {
      if (zones <= rows[i].max) return rows[i];
    }
    return rows[rows.length - 1];
  }

  // Booking keys are named "<season>_<tier>" with "_commercial" in the
  // middle for commercial tiers — enough to read a key back into the two
  // facts needed to re-resolve it: which season, which tier table.
  function readKey(serviceKey) {
    var key = String(serviceKey || "");
    var season = /^spring_open/.test(key) ? "spring"
      : /^fall_close/.test(key) ? "fall"
        : null;
    if (!season) return null;
    return { season: season, mode: /_commercial(_|$)/.test(key) ? "commercial" : "residential" };
  }

  // One-shot convenience for callers holding a service key and a zone
  // count: "given this booking key, which tier does N zones actually
  // belong to?" Returns a tier object (with .key) or null when the key
  // isn't seasonal or the tier table isn't available.
  function tierForKeyAndZones(seasonalTiers, serviceKey, zones) {
    var parsed = readKey(serviceKey);
    if (!parsed) return null;
    var n = Math.floor(Number(zones));
    if (!isFinite(n) || n < 1) return null;
    var tiers = build(seasonalTiers, parsed.season);
    if (!tiers) return null;
    return tierFor(tiers, parsed.mode, n);
  }

  global.PJLSeasonalTiers = {
    parseRange: parseRange,
    rangeLabel: rangeLabel,
    build: build,
    tierFor: tierFor,
    readKey: readKey,
    tierForKeyAndZones: tierForKeyAndZones
  };
})(window);
