// PJL Online Booking — multi-step state machine driving book.html.
//
// Steps: service -> address -> when -> contact -> confirm.
// Each step is a <article class="book-step" data-step="..."> that's hidden
// until the user reaches it. The progress strip at the top mirrors state.
//
// API contract:
//   GET  /api/booking/services                                  catalog
//   GET  /api/booking/availability?service=&address=&days=14    slots by day
//   POST /api/booking/reserve                                   create lead + reserve slot
//
// The address autocomplete is wired by coverage-checker.js — any input with
// class="js-address-autocomplete" gets Google Places autocomplete attached
// once the Maps script loads.

(function () {
  // ===== State =====
  const state = {
    step: "service",
    serviceKey: null,
    serviceMeta: null,
    address: "",
    formattedAddress: "",
    zoneCount: null,    // number 1-50 OR "unsure" (kept for booking notes)
    selectedSlot: null, // { start, end, timeLabel, dayLabel, durationMinutes }
    services: {},       // catalog from /api/booking/services
    familyFilter: null, // when set, only services with this `family` are shown
    propertyType: "residential", // toggle on the seasonal-service grid: "residential" or "commercial"
    sessionToken: null, // pre-booking session (AI handoff) — passed back on reserve
    sessionPayload: null, // diagnosis + customer hints loaded from the session
    customerFirstName: "" // captured from session handoff, used to personalize copy
  };

  // Families where confirming the customer's zone count adds value to the
  // booking. Repair/Hydrawise/Site-visit don't gate on zone count, so we
  // skip the zones step for those flows.
  const ZONE_REQUIRING_FAMILIES = new Set(["spring_opening", "fall_closing"]);

  function serviceNeedsZones() {
    if (!state.serviceMeta) return false;
    return ZONE_REQUIRING_FAMILIES.has(state.serviceMeta.family);
  }

  // ===== DOM =====
  const steps = Array.from(document.querySelectorAll(".book-step"));
  const progressSteps = Array.from(document.querySelectorAll(".book-progress-step"));
  const serviceGrid = document.getElementById("serviceGrid");
  const serviceHeading = document.getElementById("serviceHeading");
  const serviceLead = document.getElementById("serviceLead");
  const bookOtherWrap = document.getElementById("bookOtherWrap");
  const bookOtherLink = document.getElementById("bookOther");
  const bookZones = document.getElementById("bookZones");
  const zonesNextBtn = document.getElementById("zonesNextBtn");
  const bookProgress = document.getElementById("bookProgress");
  const addressBackBtn = document.getElementById("addressBackBtn");
  const addressInput = document.getElementById("bookAddress");
  const addressNextBtn = document.getElementById("addressNextBtn");
  const whenHeading = document.getElementById("whenHeading");
  const zonesHeading = document.getElementById("zonesHeading");
  const addressHeading = document.getElementById("addressHeading");
  const contactHeading = document.getElementById("contactHeading");
  const dayLoading = document.getElementById("dayLoading");
  const timePickerHost = document.getElementById("timePickerHost");
  const whenError = document.getElementById("whenError");
  const whenLead = document.getElementById("whenLead");
  const contactSummary = document.getElementById("contactSummary");
  const bookFirst = document.getElementById("bookFirst");
  const bookLast = document.getElementById("bookLast");
  const bookEmail = document.getElementById("bookEmail");
  const bookPhone = document.getElementById("bookPhone");
  const bookNotes = document.getElementById("bookNotes");
  const contactError = document.getElementById("contactError");
  const confirmBtn = document.getElementById("confirmBtn");
  const confirmTitle = document.getElementById("confirmTitle");
  const confirmDetail = document.getElementById("confirmDetail");
  const portalCta = document.getElementById("portalCta");
  const bookAnotherBtn = document.getElementById("bookAnotherBtn");

  // ===== Helpers =====
  function escapeHtml(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // Lower-case the first character so we can splice family headings into
  // a greeting cleanly: "Pick your spring opening." → "pick your spring opening."
  function lowerFirst(text) {
    if (!text) return "";
    return text.charAt(0).toLowerCase() + text.slice(1);
  }

  // Greet the customer by name on every step that has a heading we can
  // personalize. Called once we know the first name (after session prefill,
  // or after the customer fills in the contact step manually). Static
  // fallback copy is preserved when no name is available so cold visitors
  // don't see "Hi , how many zones..." weirdness.
  function personalizeStepHeadings() {
    const name = state.customerFirstName;
    if (!name) return;
    if (zonesHeading)   zonesHeading.textContent   = `Hi ${name}, how many zones does your system have?`;
    if (addressHeading) addressHeading.textContent = `Hi ${name}, where's the property?`;
    if (contactHeading) contactHeading.textContent = `Last bit, ${name} — your contact info.`;
    // The service-step heading is set by renderServiceCards (it depends on
    // the active family filter); the time-step heading is set by
    // loadAvailability. Both check state.customerFirstName at render time.
  }

  // ===== Scroll helpers =====
  // scrollIntoView({ block: "start" | "center" }) moves the page even when the
  // target is already fully visible — it re-aligns it to the top/centre of the
  // viewport. Every call site below swaps content in place, so the target is
  // usually already on screen and the re-alignment reads as an unprompted
  // lurch. It is worst on a phone: the distance thrown is the element's
  // distance from the top of the viewport, which on a ~700px handset is most
  // of a screen height. Scroll only when the target genuinely is off-screen.
  //
  // pinnedTopBarHeight measures whatever bar is pinned across the TOP of the
  // viewport at call time, so this tracks each page's own responsive
  // breakpoints instead of a hard-coded number that silently drifts.
  function pinnedTopBarHeight() {
    let height = 0;
    document.querySelectorAll(".nav, .pjl-app-topbar, .tech-header, header").forEach((el) => {
      const position = window.getComputedStyle(el).position;
      // Sticky counts: a pinned sticky bar (the CRM topbar, the tech header)
      // overlaps scrolled content exactly as a fixed one does.
      if (position !== "fixed" && position !== "sticky") return;
      const rect = el.getBoundingClientRect();
      // Only a bar actually spanning the top edge is overhead. This is what
      // keeps the CRM's full-height fixed sidebar (.pjl-admin-nav is
      // top:0;bottom:0) out of the measurement — it is pinned, but it sits
      // beside the content, not above it, and counting it would report a
      // viewport-tall "header" and make everything look off-screen.
      if (rect.top > 4 || rect.bottom <= 0) return;
      if (rect.height > window.innerHeight * 0.4) return;
      height = Math.max(height, Math.round(rect.bottom));
    });
    return height;
  }

  function revealIfOffscreen(el, block) {
    if (!el || typeof el.getBoundingClientRect !== "function") return;
    const headerH = pinnedTopBarHeight();
    const rect = el.getBoundingClientRect();
    const LOWER_BOUND = window.innerHeight * 0.85;   // "still comfortably in view"
    if (rect.top >= headerH && rect.top <= LOWER_BOUND) return;
    // scroll-margin-top keeps block:"start" from parking the target underneath
    // the pinned bar. Set rather than restored: it is idempotent, and any later
    // scroll of this element wants the same clearance.
    el.style.scrollMarginTop = headerH + "px";
    const reduceMotion = window.matchMedia
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: block || "start" });
  }

  function showStep(name, { scroll = true } = {}) {
    state.step = name;
    steps.forEach((s) => { s.hidden = s.dataset.step !== name; });

    // A zone count can arrive pre-filled (?zones= on a seasonal CTA, or a
    // session handoff), which fires no change event. Re-check it on entry so
    // a mismatched tier is announced here rather than swapped silently when
    // the customer taps Continue.
    if (name === "zones" && typeof reviewZoneAnswer === "function") reviewZoneAnswer();

    // Hide the whole progress strip on the confirm/success state — the
    // "You're booked!" card already says everything the strip would
    // (and Patrick rightly pointed out the duplicate steps drove him
    // nuts). Restored when the user starts a new booking.
    if (bookProgress) bookProgress.hidden = (name === "confirm");

    // The progress strip toggles between 5-dot (no zones) and 6-dot (with
    // zones) based on whether the current service needs the zones step.
    // The .no-zones class hides the conditional dot via CSS.
    const showZones = serviceNeedsZones();
    bookProgress.classList.toggle("no-zones", !showZones);

    // Active-step list depends on whether zones is in the flow. Indices in
    // this array drive the "completed/current/pending" classes.
    const order = showZones
      ? ["service", "zones", "address", "when", "contact", "confirm"]
      : ["service", "address", "when", "contact", "confirm"];
    const idx = order.indexOf(name);
    progressSteps.forEach((p) => {
      p.classList.remove("is-current", "is-complete");
      const stepIdx = order.indexOf(p.dataset.step);
      if (stepIdx === -1) return; // step not in current flow (e.g. zones when hidden)
      if (stepIdx < idx) p.classList.add("is-complete");
      else if (stepIdx === idx) p.classList.add("is-current");
    });

    // Re-target the address-step's back button: when the zones step is in
    // play, "back" should return to zones; otherwise to service. Same button,
    // smarter routing.
    if (addressBackBtn) {
      if (showZones) {
        addressBackBtn.dataset.backTo = "zones";
        addressBackBtn.textContent = "← Change zones";
      } else {
        addressBackBtn.dataset.backTo = "service";
        addressBackBtn.textContent = "← Change service";
      }
    }

    // Bring the active step into view when it lands off-screen — wanted for
    // customer-driven step changes (Next, Back, service-card click), and
    // opted out via { scroll: false } for the deep-link bootstrap, which
    // otherwise lurches the page on first paint. Steps swap in place, so the
    // new step is usually already on screen: revealIfOffscreen leaves the
    // page alone in that case rather than re-aligning what you're looking at.
    const active = steps.find((s) => s.dataset.step === name);
    if (scroll && active) revealIfOffscreen(active, "start");
  }

  // ===== Service catalog =====
  // Friendly meta — emoji + short blurb — keyed off what server.js exposes
  // via /api/booking/services. If the server adds a new bookable service
  // with no entry here, it falls back to a default icon.
  // 2026-05-02 RESTRUCTURE: one entry per pricing.json tier, no overlaps.
  // Blurb is the price + scope; durationText() appends the time at render time
  // so we never double-up the time string.
  const SERVICE_META = {
    // Spring opening — residential (5 tiers)
    spring_open_4z:                  { icon: "🌿", blurb: "$90 · seasonal startup, head check, schedule reset" },
    spring_open_6z:                  { icon: "🌿", blurb: "$105 · seasonal startup with full system check" },
    spring_open_8z:                  { icon: "🌿", blurb: "$120 · seasonal startup with full system check" },
    spring_open_15z:                 { icon: "🌿", blurb: "$165 · large-system startup with full inspection" },
    spring_open_16plus:              { icon: "🌿", blurb: "Custom quote · large-system startup, quoted on-site" },
    // Spring opening — commercial (3 tiers)
    spring_open_commercial:          { icon: "🏢", blurb: "$145 · commercial spring opening" },
    spring_open_commercial_8z:       { icon: "🏢", blurb: "$255 · commercial spring opening" },
    spring_open_commercial_9plus:    { icon: "🏢", blurb: "Custom quote · commercial, quoted on-site" },

    // Fall winterization — residential (5 tiers)
    fall_close_4z:                   { icon: "🍂", blurb: "$90 · winterization with compressed-air blowout" },
    fall_close_6z:                   { icon: "🍂", blurb: "$105 · winterization with full-system check" },
    fall_close_8z:                   { icon: "🍂", blurb: "$120 · full-system winterization" },
    fall_close_15z:                  { icon: "🍂", blurb: "$165 · large-system winterization with full inspection" },
    fall_close_16plus:               { icon: "🍂", blurb: "Custom quote · large-system winterization, quoted on-site" },
    // Fall winterization — commercial (3 tiers)
    fall_close_commercial:           { icon: "🏢", blurb: "$145 · commercial winterization" },
    fall_close_commercial_8z:        { icon: "🏢", blurb: "$255 · commercial winterization" },
    fall_close_commercial_9plus:     { icon: "🏢", blurb: "Custom quote · commercial, quoted on-site" },

    // Repair / retrofit / consult
    sprinkler_repair:                { icon: "🔧", blurb: "Diagnose + fix on the spot" },
    hydrawise_retrofit:              { icon: "📡", blurb: "Smart controller upgrade with app + WiFi setup" },
    site_visit:                      { icon: "📋", blurb: "Free walkaround · we scope and quote new installs" }
  };

  // Property-type heuristic — the booking key naming convention is
  // "*_commercial[_8z|_9plus]". Lets us split the seasonal service grid
  // into Residential / Commercial tabs so the customer doesn't see 8 cards
  // at once.
  function propertyTypeForKey(key) {
    return /_commercial(_|$)/.test(key) ? "commercial" : "residential";
  }

  // Friendly heading + intro shown above the service grid when the user has
  // arrived via a deep link (e.g. ?service=spring_open_4z). One entry per
  // family so the page reads naturally — "Pick your spring opening" rather
  // than the generic "What do you need done?".
  const FAMILY_COPY = {
    spring_opening: {
      heading: "Pick your spring opening.",
      lead: "Choose the size that matches your system. We'll show you available times next."
    },
    fall_closing: {
      heading: "Pick your fall winterization.",
      lead: "Choose the size that matches your system. We'll show you available times next."
    },
    sprinkler_repair: {
      heading: "Book a sprinkler repair.",
      lead: "Standard 90-minute block. If we need more time on the day, we'll let you know on arrival."
    },
    hydrawise_retrofit: {
      heading: "Book your Hydrawise retrofit.",
      lead: "Smart controller swap with app + WiFi setup. About 90 minutes on site."
    },
    site_visit: {
      heading: "Book a site visit.",
      lead: "Free 30-minute walkaround. Patrick scopes the work and follows up with a written quote."
    }
  };

  // Compute the human-readable duration shown on each card.
  // Long jobs use the displayMinutes range string set by the server.
  function durationText(meta) {
    return meta.displayMinutes || `${meta.minutes} min`;
  }

  function renderServiceCards() {
    serviceGrid.innerHTML = "";
    const allEntries = Object.entries(state.services).filter(([, m]) => m.bookable);
    const familyEntries = state.familyFilter
      ? allEntries.filter(([, m]) => m.family === state.familyFilter)
      : allEntries;

    // Property-type toggle: only show when the family has BOTH residential AND
    // commercial services (spring_opening / fall_closing). For repair /
    // retrofit / site_visit families, hide the toggle entirely and show
    // every service.
    const familyHasCommercial = familyEntries.some(([k]) => propertyTypeForKey(k) === "commercial");
    const familyHasResidential = familyEntries.some(([k]) => propertyTypeForKey(k) === "residential");
    const showPropertyToggle = familyHasCommercial && familyHasResidential;

    // Apply property-type filter (only when toggle is visible)
    const filtered = showPropertyToggle
      ? familyEntries.filter(([k]) => propertyTypeForKey(k) === state.propertyType)
      : familyEntries;

    // Update heading + lead text. If the family has a custom copy block use
    // it; otherwise fall back to the generic catalog view. When we know the
    // customer's first name (via session handoff), the heading is prefixed
    // with a greeting so the page feels addressed to them, not generic.
    const name = state.customerFirstName;
    if (state.familyFilter && FAMILY_COPY[state.familyFilter]) {
      const family = FAMILY_COPY[state.familyFilter];
      serviceHeading.textContent = name ? `Hi ${name} — ${lowerFirst(family.heading)}` : family.heading;
      // When the customer arrived on a link that already names a tier, the
      // matching card is rendered active — say so, rather than showing a
      // pre-ticked box with no explanation.
      serviceLead.textContent = (state.serviceKey && filtered.some(([k]) => k === state.serviceKey))
        ? "We've carried over the size from the page you came from — change it here if that's not right."
        : family.lead;
    } else {
      serviceHeading.textContent = name
        ? `Hi ${name}, what can we help with today?`
        : "What do you need done?";
      serviceLead.textContent = "Pick the closest match. If you're not sure, choose \"Site visit\" and Patrick will scope it for you.";
    }

    // Render the property-type toggle (or remove it if not applicable)
    let toggle = document.getElementById("svcPropertyToggle");
    if (showPropertyToggle) {
      if (!toggle) {
        toggle = document.createElement("div");
        toggle.id = "svcPropertyToggle";
        toggle.className = "svc-property-toggle";
        toggle.setAttribute("role", "tablist");
        toggle.setAttribute("aria-label", "Property type");
        toggle.innerHTML = `
          <button type="button" class="svc-property-toggle__tab" data-prop="residential" role="tab">🏡 Residential</button>
          <button type="button" class="svc-property-toggle__tab" data-prop="commercial" role="tab">🏢 Commercial</button>
        `;
        serviceGrid.parentNode.insertBefore(toggle, serviceGrid);
        toggle.addEventListener("click", (e) => {
          const tab = e.target.closest("[data-prop]");
          if (!tab) return;
          state.propertyType = tab.dataset.prop;
          renderServiceCards();
        });
      }
      // Update active state
      toggle.querySelectorAll(".svc-property-toggle__tab").forEach((t) => {
        const active = t.dataset.prop === state.propertyType;
        t.classList.toggle("is-active", active);
        t.setAttribute("aria-selected", active ? "true" : "false");
      });
    } else if (toggle) {
      toggle.remove();
    }

    filtered.forEach(([key, meta]) => {
      const friendly = SERVICE_META[key] || { icon: "✓", blurb: "" };
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "service-card";
      if (key === state.serviceKey) btn.classList.add("is-active");
      btn.dataset.serviceKey = key;
      const blurb = friendly.blurb || `${meta.minutes} min`;
      btn.innerHTML = `
        <span class="icon" aria-hidden="true">${friendly.icon}</span>
        <span class="label">${escapeHtml(meta.label)}</span>
        <span class="meta">${escapeHtml(blurb)} · ${escapeHtml(durationText(meta))}</span>
      `;
      serviceGrid.append(btn);
    });

    // Show the "Book something else" link only when a filter is active AND
    // there's more than one family in the catalog. Lets the customer back out
    // of a deep-link choice without going to a different page.
    const otherFamilies = new Set(allEntries.map(([, m]) => m.family));
    bookOtherWrap.hidden = !state.familyFilter || otherFamilies.size <= 1;
  }

  // Clicking "Book something else" clears the family filter and re-renders
  // the full catalog so the customer can pick any service.
  bookOtherLink.addEventListener("click", (event) => {
    event.preventDefault();
    state.familyFilter = null;
    // Backing out of a deep link drops its tier as well — otherwise the full
    // catalog renders with a card still ticked from the page they left.
    state.serviceKey = null;
    state.serviceMeta = null;
    // Strip the ?service= param from the URL so refreshing doesn't re-filter.
    const next = new URL(window.location.href);
    next.searchParams.delete("service");
    next.searchParams.delete("zones");
    window.history.replaceState({}, "", next.toString());
    renderServiceCards();
  });

  serviceGrid.addEventListener("click", (event) => {
    const card = event.target.closest("[data-service-key]");
    if (!card) return;
    state.serviceKey = card.dataset.serviceKey;
    state.serviceMeta = state.services[state.serviceKey];
    serviceGrid.querySelectorAll(".service-card").forEach((c) => c.classList.remove("is-active"));
    card.classList.add("is-active");
    // Seasonal services (spring/fall) route through the zone-confirm step
    // first; everything else jumps straight to address.
    const nextStep = serviceNeedsZones() ? "zones" : "address";
    setTimeout(() => showStep(nextStep), 250);
  });

  // Populate the zone dropdown once at boot. 1..50 zones plus the existing
  // "unsure" sentinel that was hard-coded into book.html.
  (function buildZoneOptions() {
    if (!bookZones) return;
    // Insert numeric options BEFORE the "I'm not sure" entry so the
    // dropdown reads naturally: choose..., 1..50, then "I'm not sure".
    const unsureOption = bookZones.querySelector('option[value="unsure"]');
    for (let n = 1; n <= 50; n++) {
      const opt = document.createElement("option");
      opt.value = String(n);
      opt.textContent = n === 1 ? "1 zone" : `${n} zones`;
      bookZones.insertBefore(opt, unsureOption);
    }
  })();

  // ===== Zone confirmation vs. the tier that was picked =====
  // The service card names a zone bracket and the next step asks for the
  // zone count, so the two can disagree. Nothing used to reconcile them:
  // priceForBooking() ignores the zone count outright (its second argument
  // is marked "no longer used"), so tier, price and on-site duration all
  // followed the card while the real number went to the booking notes. A
  // customer could pick the 5-6 zone card, answer 12, and be booked and
  // priced as a 5-6 zone job.
  //
  // Resolving through pricing.json's seasonal_tiers — the same rows the
  // spring and fall page estimators price from — keeps the promise those
  // pages make: the tier you are shown is the tier you book.
  let pendingTierKey = null;

  function tierNoteEl() {
    return document.getElementById("zonesTierNote");
  }

  function clearTierNote() {
    pendingTierKey = null;
    const el = tierNoteEl();
    if (el) { el.hidden = true; el.textContent = ""; }
  }

  // Returns the service key the chosen zone count actually belongs to, or
  // null when we can't tell (non-seasonal service, "I'm not sure", or
  // pricing.json not loaded — in which case we leave the booking alone
  // rather than guessing).
  function tierKeyForZoneAnswer(value) {
    if (!state.serviceKey || !serviceNeedsZones()) return null;
    if (!value || value === "unsure") return null;
    const helper = window.PJLSeasonalTiers;
    const pricing = window.__pjlPricing;
    if (!helper || !pricing) return null;
    const tier = helper.tierForKeyAndZones(pricing.seasonal_tiers, state.serviceKey, value);
    if (!tier || !tier.key || tier.key === state.serviceKey) return null;
    return state.services[tier.key] ? tier.key : null;
  }

  function reviewZoneAnswer() {
    const key = tierKeyForZoneAnswer(bookZones.value);
    if (!key) { clearTierNote(); return; }
    pendingTierKey = key;
    const el = tierNoteEl();
    if (el) {
      el.textContent = `${zoneCountLabel(bookZones.value)} puts you in a different size — we'll book ${state.services[key].label} so the price matches your system.`;
      el.hidden = false;
    }
  }

  bookZones.addEventListener("change", reviewZoneAnswer);

  // The tier check needs pricing.json, which js/pricing-injector.js fetches
  // asynchronously. A customer who reaches this step before that resolves
  // would otherwise get no check at all, so re-run it when the rows land.
  document.addEventListener("pjl:pricing-loaded", () => {
    if (state.step === "zones") reviewZoneAnswer();
  });

  zonesNextBtn.addEventListener("click", () => {
    if (!bookZones.value) {
      bookZones.focus();
      return;
    }
    state.zoneCount = bookZones.value;
    // Apply the corrected tier before moving on: availability is fetched
    // against the service's duration, so this has to settle first.
    const corrected = pendingTierKey || tierKeyForZoneAnswer(bookZones.value);
    if (corrected && state.services[corrected]) {
      state.serviceKey = corrected;
      state.serviceMeta = state.services[corrected];
      renderServiceCards();
    }
    clearTierNote();
    showStep("address");
  });

  // ===== Address step =====
  addressNextBtn.addEventListener("click", () => {
    const value = addressInput.value.trim();
    if (!value) {
      addressInput.focus();
      return;
    }
    state.address = value;
    showStep("when");
    loadAvailability();
  });

  addressInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addressNextBtn.click();
    }
  });

  // ===== Availability =====
  // The day + time picker is now a single shared component (js/time-picker.js)
  // that renders a month-calendar + slot list. We hand it a loader function
  // that fetches /api/booking/availability for the visible 6-week window, and
  // an onSelect callback that captures the chosen slot and advances to the
  // contact step. The picker itself owns its empty / loading / error states.
  function loadAvailability() {
    state.selectedSlot = null;
    dayLoading.hidden = true;
    whenError.hidden = true;

    // Personalize the heading + lead when we have the customer's name from
    // the handoff session. Otherwise fall back to the generic copy that
    // ships with the static HTML.
    const friendlyAddress = state.formattedAddress || state.address;
    if (state.customerFirstName) {
      whenHeading.textContent = `Hey ${state.customerFirstName}!`;
      whenLead.textContent =
        `Please pick a date and time for your ${state.serviceMeta.label} appointment at ${friendlyAddress}.`;
    } else {
      whenHeading.textContent = "Pick a day, then a time.";
      whenLead.textContent =
        `Showing real-time openings for ${state.serviceMeta.label} at ${friendlyAddress}.`;
    }

    if (typeof window.mountTimePicker !== "function") {
      whenError.textContent = "Time picker failed to load. Please refresh the page or call (905) 960-0181.";
      whenError.hidden = false;
      return;
    }

    window.mountTimePicker(timePickerHost, {
      mode: "customer",
      loadAvailability: async ({ from, to }) => {
        const url = (window.PJL_API_BASE || "")
          + `/api/booking/availability`
          + `?service=${encodeURIComponent(state.serviceKey)}`
          + `&address=${encodeURIComponent(state.address)}`
          + `&from=${encodeURIComponent(from)}`
          + `&to=${encodeURIComponent(to)}`;
        const response = await fetch(url, { cache: "no-store" });
        const data = await response.json();
        if (!response.ok || !data.ok) {
          throw new Error((data.errors || ["Couldn't load availability."]).join(" "));
        }
        // Server-canonical address — keep state in sync so the contact-step
        // summary shows what the geocoder resolved, not what was typed.
        state.formattedAddress = data.address || state.address;
        return { days: data.days || [] };
      },
      onSelect: (iso, slotMeta) => {
        state.selectedSlot = {
          start: slotMeta.start || iso,
          end: slotMeta.end || null,
          timeLabel: slotMeta.timeLabel || new Date(iso).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" }),
          dayLabel: slotMeta.dayLabel || new Date(iso).toLocaleDateString("en-CA", { weekday: "long", month: "short", day: "numeric" }),
          durationMinutes: slotMeta.durationMinutes || state.serviceMeta.minutes,
          // Bucket-mode fields. When present, customer-facing copy uses
          // bucketWindow ("8 AM – 12 PM") instead of the service's
          // on-site duration — Patrick committed to no precise times in
          // customer-facing surfaces.
          bucketKey: slotMeta.bucketKey || null,
          bucketWindow: slotMeta.bucketWindow || null
        };
        // Brief debounce so the visual "selected" state lands before the
        // contact step swaps in — matches the previous flow's feel.
        setTimeout(() => {
          renderContactSummary();
          showStep("contact");
        }, 200);
      }
    });
  }

  function renderContactSummary() {
    if (!state.selectedSlot) return;
    const zoneRow = state.zoneCount
      ? `<dt>Zones</dt><dd>${escapeHtml(zoneCountLabel(state.zoneCount))}</dd>`
      : "";
    // Bucket mode: show the bucket window ("8 AM – 12 PM") instead of
    // the service's on-site duration. Customer never sees a precise
    // arrival time anywhere downstream.
    const timeSubLabel = state.selectedSlot.bucketWindow
      || state.serviceMeta.displayMinutes
      || `${state.serviceMeta.minutes} min`;
    contactSummary.innerHTML = `
      <dt>Service</dt><dd>${escapeHtml(state.serviceMeta.label)}</dd>
      ${zoneRow}
      <dt>Day</dt><dd>${escapeHtml(state.selectedSlot.dayLabel)}</dd>
      <dt>Time</dt><dd>${escapeHtml(state.selectedSlot.timeLabel)} (${escapeHtml(timeSubLabel)})</dd>
      <dt>Address</dt><dd>${escapeHtml(state.formattedAddress)}</dd>
    `;
  }

  function zoneCountLabel(value) {
    if (!value) return "";
    if (value === "unsure") return "Customer unsure";
    return value === "1" ? "1 zone" : `${value} zones`;
  }

  // ===== Confirm + reserve =====
  confirmBtn.addEventListener("click", async () => {
    contactError.hidden = true;
    const errors = [];
    if (!bookFirst.value.trim()) errors.push("First name is required.");
    if (!bookLast.value.trim()) errors.push("Last name is required.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bookEmail.value.trim())) errors.push("A valid email is required.");
    if (!bookPhone.value.trim()) errors.push("Phone is required.");
    if (errors.length) {
      contactError.textContent = errors.join(" ");
      contactError.hidden = false;
      return;
    }

    confirmBtn.disabled = true;
    const originalText = confirmBtn.textContent;
    confirmBtn.textContent = "Reserving your slot…";

    // Prepend the customer-confirmed zone count to whatever they typed in
    // the notes box so Patrick sees it at a glance in the CRM. Stays empty
    // when the flow didn't ask for zones (repair / hydrawise / site visit).
    const userNotes = bookNotes.value.trim();
    const zoneNote = state.zoneCount
      ? `Zone count (customer-confirmed): ${zoneCountLabel(state.zoneCount)}.`
      : "";
    const combinedNotes = [zoneNote, userNotes].filter(Boolean).join("\n");

    try {
      const payload = {
        serviceKey: state.serviceKey,
        slotStart: state.selectedSlot.start,
        contact: {
          firstName: bookFirst.value.trim(),
          lastName: bookLast.value.trim(),
          name: `${bookFirst.value.trim()} ${bookLast.value.trim()}`,
          email: bookEmail.value.trim(),
          phone: bookPhone.value.trim(),
          address: state.formattedAddress || state.address,
          notes: combinedNotes
        },
        zoneCount: state.zoneCount || null,
        sessionToken: state.sessionToken || null,
        pageUrl: window.location.href,
        userAgent: navigator.userAgent
      };
      // Anti-bot defense layer (see WEBSITE_MAINTENANCE §15.14). Pulls
      // contact_website (honeypot), _ts (time-trap stamp), and
      // cfTurnstileResponse off the page and merges them into the payload
      // so /api/booking/reserve can validate before reserving the slot.
      if (window.pjlAntiBot) window.pjlAntiBot.augmentPayload(payload);
      const response = await fetch((window.PJL_API_BASE || "") + "/api/booking/reserve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        // Server returns { ok, code, message, details, errors[] } on
        // failure. The customer-facing copy lives client-side now —
        // server `message` is admin-grade. Known codes get a polished
        // string; anything we don't recognise falls back to the
        // server's errors[] (still customer-readable for public-reachable
        // codes), then to a generic "try again" line.
        var CUSTOMER_COPY = {
          service_unknown: "We didn't recognize that service. Please refresh and pick one from the list.",
          slot_invalid: "That time didn't look right. Please pick a slot from the calendar.",
          address_missing: "Please enter the service address before booking.",
          slot_taken: "That slot was just taken. Please pick another time.",
          validation_failed: (data.errors || []).join(" ") || "A required field is missing — please review and try again."
        };
        var customer = CUSTOMER_COPY[data.code]
          || (data.errors || []).join(" ")
          || "Couldn't reserve. Please try a different slot or call (905) 960-0181.";
        throw new Error(customer);
      }
      // Success — personalize the confirmation copy with the name they
      // just typed in the contact step (or that was prefilled from the
      // session handoff). Falls back to a generic greeting if somehow
      // first name is empty.
      const finalFirstName = bookFirst.value.trim() || state.customerFirstName;
      confirmTitle.textContent = finalFirstName
        ? `${finalFirstName}, you're booked!`
        : "You're booked!";
      const detailIntro = finalFirstName
        ? `Thanks ${escapeHtml(finalFirstName)} — your `
        : "Your ";
      // Bucket-mode reads naturally with an em-dash separator and the
      // window subtitle: "Tuesday May 14 — Morning Appointment (8 AM – 12 PM)".
      // Legacy non-bucket slots fall back to "...set for <day> at <time>"
      // so the copy stays sensible if buckets are ever turned off.
      const bucketTail = state.selectedSlot.bucketWindow
        ? `<strong>${escapeHtml(state.selectedSlot.dayLabel)}</strong> &mdash; <strong>${escapeHtml(state.selectedSlot.timeLabel)}</strong> (${escapeHtml(state.selectedSlot.bucketWindow)})`
        : `<strong>${escapeHtml(state.selectedSlot.dayLabel)}</strong> at <strong>${escapeHtml(state.selectedSlot.timeLabel)}</strong>`;
      confirmDetail.innerHTML = `${detailIntro}${escapeHtml(state.serviceMeta.label)} is set for ${bucketTail}.`;
      portalCta.href = data.portalUrl || "#";
      // ── "Booking Request (Website)" conversion ──
      // Success path only: the !response.ok / !data.ok branch above throws
      // before reaching here, so a failed reserve can never fire this.
      // Wrapped so a blocked, missing, or misbehaving tag can never reach
      // the catch below and show a booked customer an error. Tracking must
      // never break the booking.
      try {
        if (typeof gtag === "function") {
          gtag("event", "conversion", {
            send_to: "AW-11358637592/YtmLCOCulN0cEJicnKgq"
          });
        }
      } catch (e) { /* non-fatal — booking already succeeded */ }
      showStep("confirm");
    } catch (error) {
      contactError.textContent = error.message || "Couldn't reserve. Please try a different slot or call (905) 960-0181.";
      contactError.hidden = false;
      confirmBtn.disabled = false;
      confirmBtn.textContent = originalText;
    }
  });

  // Back nav
  document.addEventListener("click", (event) => {
    const back = event.target.closest("[data-back-to]");
    if (back) showStep(back.dataset.backTo);
  });

  // Capture first name as soon as the customer types it manually, so if they
  // navigate back to an earlier step, the headings update with their name.
  bookFirst.addEventListener("input", () => {
    const trimmed = bookFirst.value.trim();
    if (trimmed && trimmed !== state.customerFirstName) {
      state.customerFirstName = trimmed;
      personalizeStepHeadings();
    }
  });

  bookAnotherBtn.addEventListener("click", () => {
    state.serviceKey = null;
    state.serviceMeta = null;
    state.address = "";
    state.selectedSlot = null;
    addressInput.value = "";
    bookFirst.value = "";
    bookLast.value = "";
    bookEmail.value = "";
    bookPhone.value = "";
    bookNotes.value = "";
    serviceGrid.querySelectorAll(".service-card").forEach((c) => c.classList.remove("is-active"));
    showStep("service");
  });

  // Apply hints from a pre-booking session (AI chat handoff). Pre-fills
  // contact fields, zone count, and selects the suggested service when
  // possible. Anything missing falls back to manual entry.
  function applySessionPrefill(session) {
    if (!session || !session.payload) return null;
    state.sessionToken = session.token;
    state.sessionPayload = session.payload;
    const hints = session.payload.customerHints || {};

    if (hints.firstName) {
      state.customerFirstName = hints.firstName;
      if (bookFirst) bookFirst.value = hints.firstName;
      // Greet by name on every step that has a personalizable heading.
      personalizeStepHeadings();
    }
    if (hints.lastName  && bookLast)  bookLast.value  = hints.lastName;
    if (hints.email     && bookEmail) bookEmail.value = hints.email;
    if (hints.phone     && bookPhone) bookPhone.value = hints.phone;
    if (hints.notes     && bookNotes) bookNotes.value = hints.notes;
    if (hints.address) {
      state.address = hints.address;
      state.formattedAddress = hints.address;
      if (addressInput) addressInput.value = hints.address;
    }

    // Zone count — set on state and pre-select the dropdown so the
    // customer can confirm or change rather than re-entering blind.
    if (hints.zoneCount === "unsure") {
      state.zoneCount = "unsure";
      if (bookZones) bookZones.value = "unsure";
    } else if (typeof hints.zoneCount === "number" && hints.zoneCount >= 1 && hints.zoneCount <= 50) {
      state.zoneCount = String(hints.zoneCount);
      if (bookZones) bookZones.value = String(hints.zoneCount);
    }

    return session.payload.suggestedService || null;
  }

  // Pick the most advanced step we can drop the customer onto, given what's
  // already filled in by the session prefill. The principle: every step the
  // customer would just be re-confirming filled-in data is skipped — they
  // land directly on the first thing that genuinely needs their input.
  //
  // Order is service → (zones if seasonal) → address → when → contact.
  // Returns one of those step names.
  function bestLandingStep() {
    if (!state.serviceKey || !state.serviceMeta) return "service";
    if (serviceNeedsZones() && !state.zoneCount) return "zones";
    if (!state.address) return "address";
    return "when";
  }

  // ===== Bootstrap: load service catalog =====
  async function init() {
    try {
      const params = new URLSearchParams(window.location.search);
      const sessionToken = params.get("session");

      // If a session token is in the URL, pull it down BEFORE fetching the
      // service catalog — this lets us prefill and pick the suggested
      // service in one pass.
      let suggestedService = null;
      if (sessionToken) {
        try {
          const sessRes = await fetch((window.PJL_API_BASE || "") + `/api/booking/session/${encodeURIComponent(sessionToken)}`, { cache: "no-store" });
          const sessData = await sessRes.json();
          if (sessRes.ok && sessData.ok) {
            suggestedService = applySessionPrefill(sessData.session);
          }
        } catch (_) { /* expired or missing — fall through to manual flow */ }
      }

      const response = await fetch(((window.PJL_API_BASE || "") + "/api/booking/services"), { cache: "no-store" });
      const data = await response.json();
      if (data.ok) {
        state.services = data.services || {};

        // Pick the deep-link service from the URL OR the session's
        // suggestedService. URL wins if both present (manual override).
        const preselect = params.get("service") || suggestedService;

        // ?zones= travels with the seasonal pages' booking CTAs so the count
        // the visitor already dialled in on the estimator isn't asked for
        // again from scratch. Same treatment as a session hint: pre-select,
        // don't assume — they still confirm.
        const zonesParam = params.get("zones");
        if (zonesParam && !state.zoneCount) {
          const n = Math.floor(Number(zonesParam));
          if (isFinite(n) && n >= 1 && n <= 50) {
            state.zoneCount = String(n);
            if (bookZones) bookZones.value = String(n);
          }
        }
        // A "session handoff" is when the AI / admin has explicitly chosen
        // the service for this customer. Trust their choice — lock the
        // service in and skip the family picker entirely.
        const fromSessionHandoff = Boolean(state.sessionToken && suggestedService && suggestedService === preselect);

        if (preselect && state.services[preselect]) {
          const family = state.services[preselect].family;
          const familyMembers = family
            ? Object.values(state.services).filter((m) => m.bookable && m.family === family)
            : [];

          // Lock the service in when the AI/admin chose it OR when the
          // family has only one variant (no real choice for the customer).
          if (fromSessionHandoff || familyMembers.length === 1) {
            state.serviceKey = preselect;
            state.serviceMeta = state.services[preselect];
            renderServiceCards();

            // Skip past every prefilled step — land on the first one that
            // still needs the customer's input. With a fully-populated
            // handoff (service + zones + address), this drops them straight
            // on the time picker and triggers the availability fetch.
            const landing = bestLandingStep();
            showStep(landing, { scroll: false });
            if (landing === "when") loadAvailability();
            return;
          }

          // Multi-variant family without a session-locked choice: show the
          // family-filtered picker so the customer picks the right size.
          // The link already named a tier, so mark that card chosen — the
          // customer confirms or corrects instead of choosing from scratch.
          // Advancing still needs a card tap; nothing auto-submits.
          state.familyFilter = family;
          state.serviceKey = preselect;
          state.serviceMeta = state.services[preselect];
          // Open on the tab the link belongs to. The grid filters by
          // property type and defaults to residential, so without this a
          // commercial link renders the residential cards with the chosen
          // tier nowhere on screen.
          state.propertyType = propertyTypeForKey(preselect);
        }
        renderServiceCards();
      }
    } catch (error) {
      serviceGrid.innerHTML = `<p class="lead" style="color:#a92e2e;">Couldn't load services. Please refresh, or call (905) 960-0181.</p>`;
    }
  }
  init();
})();
