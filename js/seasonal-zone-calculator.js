/* =============================================================
   PJL SEASONAL ZONE CALCULATOR
   Shared by sprinkler-spring-opening.html and
   sprinkler-fall-winterization.html.

   Renders the flat-rate seasonal price for the visitor's property type +
   zone count AND points every booking CTA on the page at the ?service=
   key for that exact tier.

   Before this script existed each page carried its own copy of the tier
   logic and every CTA href was static, so the fall page quoted "$90, up
   to 4 zones" and booked fall_close_6z ($105) no matter what the visitor
   selected. The price and the booking key now come off the same row.

   ── Single source of truth ────────────────────────────────────
   pricing.json → seasonal_tiers, served at /api/pricing and published on
   window.__pjlPricing by js/pricing-injector.js. Every row carries the
   zone range, the price, and BOTH season keys:

     { "zones": "1-4", "price": 90,
       "key_spring": "spring_open_4z", "key_fall": "fall_close_4z" }

   One row is resolved per render: its price drives the display, its
   key_spring / key_fall drives the href. There is deliberately no
   tier -> key table in here — a second copy of the keys would drift from
   pricing.json the first time a tier boundary moved, which is the exact
   failure this file exists to remove.

   ── Page contract ─────────────────────────────────────────────
     <div class="sprk-zone" data-seasonal-calc="fall"
          data-season-label="Fall winterization"> ... </div>

       data-seasonal-calc   "spring" | "fall" — picks key_spring vs key_fall
       data-season-label    service name used in the tier-pill copy

     <a href="book.html?service=fall_close_4z" data-seasonal-cta>...</a>

       Every booking CTA that should follow the calculator carries
       data-seasonal-cta. Its hardcoded href is the no-JS fallback and
       must match the calculator's default state (residential, 4 zones).
       Unparameterised links — the nav "Get a Free Estimate", the footer
       "Book Online" — deliberately do not carry the attribute and are
       never touched.

   ── Custom-quote tiers ────────────────────────────────────────
   Residential 16+ and commercial 9+ carry "price": 0 — they are not
   flat-rate work. Their CTA leaves the booking flow for CUSTOM_QUOTE_HREF
   instead of dropping an unpriced job into a fixed-price slot.

   ── Fallback ──────────────────────────────────────────────────
   FALLBACK_TIERS covers the window before /api/pricing resolves (and the
   case where it never does). It mirrors pricing.json's prices and
   boundaries only — never keys. While it is in play the CTAs keep their
   static hrefs, so a stale fallback can show a stale price but can never
   send a visitor to a tier the page did not quote.
   ============================================================= */
(function () {
  "use strict";

  var root = document.querySelector("[data-seasonal-calc]");
  if (!root) return;

  var season = root.getAttribute("data-seasonal-calc") === "fall" ? "fall" : "spring";
  var KEY_FIELD = season === "fall" ? "key_fall" : "key_spring";
  var SEASON_LABEL = root.getAttribute("data-season-label") || "Service";

  // Where a custom-quote tier sends the visitor instead of book.html.
  // quote.html and estimate.html are both live and there is an open
  // question about consolidating them — this is the documented default,
  // kept as one constant so redirecting it later is a one-line change.
  var CUSTOM_QUOTE_HREF = "quote.html";

  var MIN_ZONES = 1;
  var FALLBACK_MAX_ZONES = 16;

  // Prices and boundaries only. See the fallback note in the header.
  var FALLBACK_TIERS = {
    residential: [
      { zones: "1-4", price: 90 },
      { zones: "5-6", price: 105 },
      { zones: "7-8", price: 120 },
      { zones: "9-15", price: 165 },
      { zones: "16+", price: 0, custom: true }
    ],
    commercial: [
      { zones: "1-4", price: 145 },
      { zones: "5-8", price: 255 },
      { zones: "9+", price: 0, custom: true }
    ]
  };

  var zones = 4;
  var mode = "residential";
  var tiers = null;       // normalised { residential: [...], commercial: [...] }
  var tiersAreLive = false; // true once the rows came from pricing.json
  var maxZones = FALLBACK_MAX_ZONES;

  // ---- Tier rows -----------------------------------------------------

  // "1-4" / "5–6" / "16+" / "7" -> { min, max }. Anything else is skipped
  // rather than guessed at, so a malformed row can't silently mis-price.
  function parseRange(text) {
    var m = /^(\d+)\s*\+$/.exec(text);
    if (m) return { min: +m[1], max: Infinity };
    m = /^(\d+)\s*[-–—]\s*(\d+)$/.exec(text);
    if (m) return { min: +m[1], max: +m[2] };
    m = /^(\d+)$/.exec(text);
    if (m) return { min: +m[1], max: +m[1] };
    return null;
  }

  // Reproduces the tier-pill wording the pages shipped with:
  // "Up to 4 zones" / "5–6 zones" / "16+ zones".
  function rangeLabel(range) {
    if (range.max === Infinity) return range.min + "+ zones";
    if (range.min <= 1) return "Up to " + range.max + " zones";
    return range.min + "–" + range.max + " zones";
  }

  function normaliseRows(rows) {
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
        key: row[KEY_FIELD] || null,
        custom: custom,
        label: rangeLabel(range)
      });
    });
    out.sort(function (a, b) { return a.min - b.min; });
    return out.length ? out : null;
  }

  function adoptTiers(seasonal, live) {
    var residential = normaliseRows(seasonal && seasonal.residential);
    var commercial = normaliseRows(seasonal && seasonal.commercial);
    if (!residential || !commercial) return false;

    tiers = { residential: residential, commercial: commercial };
    tiersAreLive = !!live;

    // The stepper caps at the first open-ended residential tier ("16+"),
    // which is also the "16+" the counter shows at the top of its range.
    var openRow = null;
    residential.forEach(function (row) {
      if (row.max === Infinity && !openRow) openRow = row;
    });
    maxZones = openRow ? openRow.min : FALLBACK_MAX_ZONES;
    if (zones > maxZones) zones = maxZones;
    return true;
  }

  function tierFor(n) {
    var rows = tiers[mode] || tiers.residential;
    for (var i = 0; i < rows.length; i++) {
      if (n <= rows[i].max) return rows[i];
    }
    return rows[rows.length - 1];
  }

  // ---- Render --------------------------------------------------------

  function ctaHref(row) {
    if (row.custom) return CUSTOM_QUOTE_HREF;
    if (!row.key) return null;
    return "book.html?service=" + encodeURIComponent(row.key);
  }

  function updateCtas(row) {
    // Only steer the CTAs off pricing.json rows. On the fallback rows the
    // links keep the static href the page shipped with, which matches the
    // calculator's default state.
    if (!tiersAreLive) return;
    var href = ctaHref(row);
    if (!href) return;
    document.querySelectorAll("[data-seasonal-cta]").forEach(function (a) {
      a.setAttribute("href", href);
    });
  }

  function update() {
    var row = tierFor(zones);
    var tierText = (mode === "commercial" ? "Commercial" : "Residential") + " • " + row.label;

    var countEl = document.querySelector("[data-zone-count]");
    if (countEl) countEl.textContent = zones >= maxZones ? maxZones + "+" : zones;

    document.querySelectorAll("[data-zone-display]").forEach(function (el) {
      el.textContent = row.custom ? "—" : row.price;
    });

    // "From " drops away once the visitor has picked a specific zone count.
    document.querySelectorAll("[data-zone-prefix]").forEach(function (el) {
      el.textContent = "";
    });

    var amount = document.querySelector(".sprk-zone__amount");
    if (amount) {
      amount.innerHTML = row.custom
        ? 'Custom Quote<span class="sprk-zone__per">contact us</span>'
        : '$<span data-zone-display>' + row.price + '</span><span class="sprk-zone__per">/service</span>';
    }
    root.classList.toggle("sprk-zone--quote", !!row.custom);

    var note = document.querySelector("[data-zone-note]");
    if (note) {
      if (row.custom) {
        note.textContent = "For systems beyond 15 zones, we'll price it right — just contact us.";
      } else if (zones > 10) {
        note.textContent = tierText + " • Extended-time fees may apply for 10+ zone systems.";
      } else {
        note.textContent = tierText + " • " + SEASON_LABEL + " at this zone count.";
      }
    }

    var heroTierMeta = document.querySelector("[data-zone-tier-meta]");
    if (heroTierMeta) {
      heroTierMeta.textContent = row.custom ? "— call for a custom quote" : "(" + tierText + ")";
    }

    var dec = document.querySelector("[data-zone-dec]");
    var inc = document.querySelector("[data-zone-inc]");
    if (dec) dec.disabled = zones <= MIN_ZONES;
    if (inc) inc.disabled = zones >= maxZones;

    updateCtas(row);
  }

  // ---- Wiring --------------------------------------------------------

  document.addEventListener("click", function (e) {
    if (!e.target || typeof e.target.closest !== "function") return;
    if (e.target.closest("[data-zone-dec]") && zones > MIN_ZONES) { zones--; update(); }
    if (e.target.closest("[data-zone-inc]") && zones < maxZones) { zones++; update(); }
    var tab = e.target.closest(".sprk-zone__tab");
    if (tab) {
      mode = tab.getAttribute("data-mode") === "commercial" ? "commercial" : "residential";
      document.querySelectorAll(".sprk-zone__tab").forEach(function (t) {
        var active = t === tab;
        t.classList.toggle("is-active", active);
        t.setAttribute("aria-selected", active ? "true" : "false");
      });
      update();
    }
  });

  function onPricing(pricing) {
    if (adoptTiers(pricing && pricing.seasonal_tiers, true)) update();
  }

  // pricing-injector.js publishes window.__pjlPricing and fires
  // pjl:pricing-loaded once /api/pricing resolves. Handle both orderings.
  document.addEventListener("pjl:pricing-loaded", function (e) { onPricing(e.detail); });

  adoptTiers(FALLBACK_TIERS, false);
  update();
  if (window.__pjlPricing) onPricing(window.__pjlPricing);
})();
