/* =============================================================
   PJL SEASON — the public site's single season resolver.

   Loaded synchronously in <head> (it is tiny and must run before first
   paint) by every sprinkler-service-*.html town page and by the pillar
   page, sprinkler-systems.html. Nothing else on the site may compute the
   season from the calendar; read window.PJLSeason instead.

   ── Windows (a product setting — season.config.json, nowhere else) ──
   The dates live in season.config.json, shared with the build-time
   title/meta switch (scripts/sync-seasonal-meta.mjs). The build stamps
   that JSON into the CONFIG block below; the table here is documentation.
   Two views of one calendar. `season` is the three-way marketing answer
   the town pages render from; `phase` is the finer six-step view the
   pillar page's hero controller and #repair promotion key off. The
   phases nest inside the seasons so the two can never disagree:

     season  phase        window
     fall    pre-fall     Aug 15 – Sep 4    (fall closings booking)
     fall    fall         Sep 5  – Nov 20
     off     winter       Nov 21 – Jan 14   (neutral copy, calc -> spring)
     off     pre-spring   Jan 15 – Mar 14   (pillar: "spring booking soon")
     spring  spring       Mar 15 – Jun 15   (spring openings booking)
     off     midseason    Jun 16 – Aug 14   (repairs; calc -> fall)

   These are MARKETING windows: when the site leads with a service. The
   operational windows (first/last day a truck rolls, public booking
   cut-offs) are a separate product setting in seasons.json, read by
   server/lib/seasons.js and enforced by the booking flow. Keep them
   separate on purpose — promotion opens before the first route day.

   ── Page contract (town pages) ───────────────────────────────
     <html data-season-override="spring">   optional, QA only. Accepts a
                                            season (fall|spring|off) or a
                                            phase name. ?season= in the URL
                                            does the same without an edit.
     <section class="area-hero-v2" data-town="Innisfil" data-tier="extended">
       [data-season-kicker]      kicker text
       [data-season-cta]         primary CTA: label + href
       [data-scheduling-stat]    scheduling stat, rendered from TIER_STATS
                                 by data-tier — never hand-written
     <section class="season-block" id="price">
       [data-season-band]        band title
       [data-season-meta]        band meta (carries a data-price token)
       [data-season-h2]          section H2
       [data-season-calc-cta]    calculator CTA label
       [data-season-page-link]   "what's included" link: href + label
       .sprk-zone[data-seasonal-calc="auto"]
                                 js/seasonal-zone-calculator.js resolves
                                 "auto" through PJLSeason.calcSeason

   The <html> element is stamped with data-season-phase (the phase) and
   data-pjl-season (the season) before the body parses, so CSS can key
   off either with no layout shift. The static markup on each page is
   authored for FALL; apply() rewrites it for the other seasons.

   ── Preload (fallback-image pages) ──────────────────────────
   Town pages without a photo of their own take a season-keyed shared
   hero image via CSS (.area-hero-v2--seasonal). Those pages put the two
   image base names on this script tag so the right one is preloaded:
     <script src="js/season.js" data-hero-fall="fall-sprinkler-running"
             data-hero-spring="estate-sprinkler-hero" data-hero-ext=".jpg">
   Per-town photo pages preload with a static <link> instead.
   ============================================================= */
(function (global) {
  "use strict";

  // The windows live in season.config.json (shared with the build-time
  // title/meta switch in scripts/sync-seasonal-meta.mjs). This script runs
  // synchronously in <head> and cannot fetch, so the build stamps the JSON
  // in here between the markers below and its --check mode fails on drift.
  // Edit the JSON, not this block.
  /* @@PJL:season-config-START */
  // Generated from season.config.json by scripts/sync-seasonal-meta.mjs — edit the JSON.
  var CONFIG = {"fall":{"page":["08-15","11-20"],"meta":["08-01","11-20"],"preUntil":"09-04"},"spring":{"page":["03-15","06-15"],"meta":["03-01","06-15"],"preFrom":"01-15"}};
  /* @@PJL:season-config-END */

  // MM-DD keys compare lexically. Windows are inclusive.
  function key(d) {
    var m = d.getMonth() + 1, day = d.getDate();
    return (m < 10 ? "0" : "") + m + "-" + (day < 10 ? "0" : "") + day;
  }
  function within(k, w) { return k >= w[0] && k <= w[1]; }

  function resolvePhase(d) {
    d = d || new Date();
    var k = key(d);
    var fall = CONFIG.fall, spring = CONFIG.spring;
    if (within(k, fall.page)) return k <= fall.preUntil ? "pre-fall" : "fall";
    if (within(k, spring.page)) return "spring";
    if (k >= spring.preFrom && k < spring.page[0]) return "pre-spring";
    if (k > fall.page[1] || k < spring.preFrom) return "winter";
    return "midseason"; // between the spring and fall page windows
  }

  // phase -> season. Only pre-fall/fall sell fall and only spring sells
  // spring; everything else is neutral copy.
  function seasonForPhase(phase) {
    if (phase === "fall" || phase === "pre-fall") return "fall";
    if (phase === "spring") return "spring";
    return "off";
  }

  // The season the calculator defaults to. In season it is that season;
  // off-season it is the NEXT one (winter/pre-spring -> spring, midseason
  // -> fall).
  function calcSeasonForPhase(phase) {
    var season = seasonForPhase(phase);
    if (season !== "off") return season;
    return phase === "midseason" ? "fall" : "spring";
  }

  function resolveSeason(d) { return seasonForPhase(resolvePhase(d)); }

  var PHASES = ["pre-fall", "fall", "winter", "pre-spring", "spring", "midseason"];

  // QA override: <html data-season-override="…"> or ?season=… . A season
  // name maps to its representative phase; a phase name is taken as-is.
  function readOverride() {
    var value = null;
    try {
      var html = global.document && global.document.documentElement;
      value = html && html.getAttribute("data-season-override");
      if (!value && global.location) {
        var q = /[?&]season=([a-z-]+)/i.exec(global.location.search || "");
        if (q) value = q[1];
      }
    } catch (e) { /* no DOM */ }
    if (!value) return null;
    value = String(value).toLowerCase();
    if (PHASES.indexOf(value) !== -1) return value;
    if (value === "fall") return "fall";
    if (value === "spring") return "spring";
    if (value === "off") return "midseason";
    return null;
  }

  // ---- Scheduling stat by tier --------------------------------------
  // The ONLY place same-day wording exists for the town pages. Pages
  // declare data-tier; the stat is rendered from this table, and
  // scripts/lint-town-tiers.mjs checks the static fallback text in every
  // page against it.
  var TIER_STATS = {
    core:     { icon: "⚡", strong: "Same-day repair",     rest: " in season" },
    tier2:    { icon: "📅", strong: "Priority scheduling", rest: " · 1–3 business days" },
    extended: { icon: "📅", strong: "Scheduled route",     rest: " · weekly in season" }
  };

  function tierStatHtml(tier) {
    var t = TIER_STATS[tier] || TIER_STATS.extended;
    return t.icon + " <b>" + t.strong + "</b>" + t.rest;
  }

  // ---- Copy ----------------------------------------------------------
  function priceSpan(key, fallback) {
    return '<span data-price="' + key + '">' + fallback + '</span>';
  }

  // Everything the town pages render per season. Prices are tokens; the
  // literal is the pre-hydration fallback and mirrors pricing.json.
  function copyFor(season, next, town) {
    var fallPrice = priceSpan("fall_close_4z", "$90");
    var springPrice = priceSpan("spring_open_4z", "$90");
    if (season === "fall") {
      return {
        kicker: "Fall closing season · Now booking",
        ctaHtml: "Book Fall Closing — From " + fallPrice,
        ctaHref: "book.html?service=fall_close_4z&zones=4",
        bandHtml: "🍂 Fall closing — " + town,
        metaHtml: "From " + fallPrice + " · Booking September–November",
        h2: "Fall closing season in " + town + ". Book before the freeze.",
        calcCta: "Book fall closing",
        pageHref: "sprinkler-fall-winterization.html",
        pageLabel: "What a fall closing includes"
      };
    }
    if (season === "spring") {
      return {
        kicker: "Spring opening season · Now booking",
        ctaHtml: "Book Spring Opening — From " + springPrice,
        ctaHref: "book.html?service=spring_open_4z&zones=4",
        bandHtml: "🌱 Spring opening — " + town,
        metaHtml: "From " + springPrice + " · Booking April–June",
        h2: "Spring opening season in " + town + ". Get running before the heat.",
        calcCta: "Book spring opening",
        pageHref: "sprinkler-spring-opening.html",
        pageLabel: "What a spring opening includes"
      };
    }
    var nextIsFall = next === "fall";
    return {
      kicker: "Sprinkler repair, installs and seasonal service",
      ctaHtml: "Book online — seasonal service from " + fallPrice,
      ctaHref: nextIsFall ? "book.html?service=fall_close_4z&zones=4"
                          : "book.html?service=spring_open_4z&zones=4",
      bandHtml: "Seasonal service — " + town,
      metaHtml: "Openings and closings from " + fallPrice,
      h2: "Seasonal sprinkler service in " + town + ".",
      calcCta: nextIsFall ? "Book fall closing online" : "Book spring opening online",
      pageHref: nextIsFall ? "sprinkler-fall-winterization.html" : "sprinkler-spring-opening.html",
      pageLabel: nextIsFall ? "What a fall closing includes" : "What a spring opening includes"
    };
  }

  // Fill any data-price tokens we just wrote if pricing has already
  // hydrated (the injector only runs once, and may have run before us).
  function fillPrices(scope) {
    var pricing = global.__pjlPricing;
    if (!pricing || !pricing.items) return;
    scope.querySelectorAll("[data-price]").forEach(function (el) {
      var item = pricing.items[el.getAttribute("data-price")];
      if (item && typeof item.price === "number") el.textContent = "$" + item.price;
    });
  }

  // ---- Resolve once, stamp <html> -----------------------------------
  var phase = readOverride() || resolvePhase();
  var season = seasonForPhase(phase);
  var calcSeason = calcSeasonForPhase(phase);

  try {
    var root = global.document.documentElement;
    root.setAttribute("data-season-phase", phase);
    root.setAttribute("data-pjl-season", season);
  } catch (e) { /* no DOM */ }

  // Preload the shared fallback hero image on pages that use one.
  try {
    var me = global.document.currentScript;
    var base = me && (season === "fall" ? me.getAttribute("data-hero-fall") : me.getAttribute("data-hero-spring"));
    if (base) {
      var ext = me.getAttribute("data-hero-ext") || ".jpg";
      [["@800w", "(max-width: 800px)"], ["@1280w", "(min-width: 801px)"]].forEach(function (v) {
        var link = global.document.createElement("link");
        link.rel = "preload";
        link.as = "image";
        link.href = base + v[0] + ext;
        link.media = v[1];
        global.document.head.appendChild(link);
      });
    }
  } catch (e) { /* ignore */ }

  // ---- Town-page DOM pass -------------------------------------------
  function apply() {
    var doc = global.document;
    var hero = doc.querySelector(".area-hero-v2");
    if (!hero) return;
    var town = hero.getAttribute("data-town") || "your area";
    var copy = copyFor(season, calcSeason, town);

    var set = function (sel, html) {
      doc.querySelectorAll(sel).forEach(function (el) { el.innerHTML = html; });
    };
    set("[data-season-kicker]", copy.kicker);
    set("[data-season-band]", copy.bandHtml);
    set("[data-season-meta]", copy.metaHtml);
    set("[data-season-h2]", copy.h2);
    set("[data-season-calc-cta]", copy.calcCta);

    doc.querySelectorAll("[data-season-cta]").forEach(function (a) {
      a.innerHTML = copy.ctaHtml;
      a.setAttribute("href", copy.ctaHref);
    });
    doc.querySelectorAll("[data-season-page-link]").forEach(function (a) {
      a.textContent = copy.pageLabel;
      a.setAttribute("href", copy.pageHref);
    });
    doc.querySelectorAll("[data-scheduling-stat]").forEach(function (li) {
      li.innerHTML = tierStatHtml(hero.getAttribute("data-tier"));
    });

    fillPrices(doc);
  }

  global.PJLSeason = {
    phase: phase,
    season: season,
    calcSeason: calcSeason,
    resolvePhase: resolvePhase,
    resolveSeason: resolveSeason,
    seasonForPhase: seasonForPhase,
    calcSeasonForPhase: calcSeasonForPhase,
    TIER_STATS: TIER_STATS,
    tierStatHtml: tierStatHtml,
    copyFor: copyFor,
    apply: apply
  };

  if (global.document) {
    if (global.document.readyState === "loading") {
      global.document.addEventListener("DOMContentLoaded", apply);
    } else {
      apply();
    }
  }
})(typeof window !== "undefined" ? window : this);
