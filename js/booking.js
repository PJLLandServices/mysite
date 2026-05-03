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
    selectedDate: null, // YYYY-MM-DD
    selectedSlot: null, // { start, end, timeLabel, ... }
    days: [],           // grouped slots from /api/booking/availability
    services: {},       // catalog from /api/booking/services
    familyFilter: null, // when set, only services with this `family` are shown
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
  const dayStrip = document.getElementById("dayStrip");
  const timeSection = document.getElementById("timeSection");
  const timeGrid = document.getElementById("timeGrid");
  const timeLead = document.getElementById("timeLead");
  const noSlots = document.getElementById("noSlots");
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

  function showStep(name) {
    state.step = name;
    steps.forEach((s) => { s.hidden = s.dataset.step !== name; });

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

    // Scroll to the active step on mobile so the user always sees it.
    const active = steps.find((s) => s.dataset.step === name);
    if (active) active.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ===== Service catalog =====
  // Friendly meta — emoji + short blurb — keyed off what server.js exposes
  // via /api/booking/services. If the server adds a new bookable service
  // with no entry here, it falls back to a default icon.
  // 2026-05-02 RESTRUCTURE: one entry per pricing.json tier, no overlaps. Blurb
  // wording matches the price tier exactly so labels + descriptions can never
  // disagree again.
  const SERVICE_META = {
    // Spring opening — residential (5 tiers)
    spring_open_4z:                  { icon: "🌿", blurb: "1-4 zones · $90 · seasonal startup, head check, schedule reset · 45 min" },
    spring_open_6z:                  { icon: "🌿", blurb: "5-6 zones · $105 · seasonal startup with full system check · 50 min" },
    spring_open_8z:                  { icon: "🌿", blurb: "7-8 zones · $120 · seasonal startup with full system check · 60 min" },
    spring_open_15z:                 { icon: "🌿", blurb: "9-15 zones · $165 · large-system startup with full inspection · 90-120 min" },
    spring_open_16plus:              { icon: "🌿", blurb: "16+ zones · custom quote · large-system startup, quoted on-site" },
    // Spring opening — commercial (3 tiers)
    spring_open_commercial:          { icon: "🏢", blurb: "1-4 zones commercial · $145 · morning or afternoon appointment" },
    spring_open_commercial_8z:       { icon: "🏢", blurb: "5-8 zones commercial · $255 · morning or afternoon appointment" },
    spring_open_commercial_9plus:    { icon: "🏢", blurb: "9+ zones commercial · custom quote · morning or afternoon appointment" },

    // Fall winterization — residential (5 tiers)
    fall_close_4z:                   { icon: "🍂", blurb: "1-4 zones · $90 · winterization with compressed-air blowout · 30 min" },
    fall_close_6z:                   { icon: "🍂", blurb: "5-6 zones · $105 · winterization with full-system check · 35 min" },
    fall_close_8z:                   { icon: "🍂", blurb: "7-8 zones · $120 · full-system winterization · 45 min" },
    fall_close_15z:                  { icon: "🍂", blurb: "9-15 zones · $165 · large-system winterization with full inspection · 60-90 min" },
    fall_close_16plus:               { icon: "🍂", blurb: "16+ zones · custom quote · large-system winterization, quoted on-site" },
    // Fall winterization — commercial (3 tiers)
    fall_close_commercial:           { icon: "🏢", blurb: "1-4 zones commercial · $145 · morning or afternoon appointment" },
    fall_close_commercial_8z:        { icon: "🏢", blurb: "5-8 zones commercial · $255 · morning or afternoon appointment" },
    fall_close_commercial_9plus:     { icon: "🏢", blurb: "9+ zones commercial · custom quote · morning or afternoon appointment" },

    // Repair / retrofit / consult
    sprinkler_repair:                { icon: "🔧", blurb: "90-min default · diagnose + fix on the spot" },
    hydrawise_retrofit:              { icon: "📡", blurb: "Smart controller upgrade with app + WiFi setup" },
    site_visit:                      { icon: "📋", blurb: "Free walkaround · we scope and quote new installs" }
  };

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
    const filtered = state.familyFilter
      ? allEntries.filter(([, m]) => m.family === state.familyFilter)
      : allEntries;

    // Update heading + lead text. If the family has a custom copy block use
    // it; otherwise fall back to the generic catalog view. When we know the
    // customer's first name (via session handoff), the heading is prefixed
    // with a greeting so the page feels addressed to them, not generic.
    const name = state.customerFirstName;
    if (state.familyFilter && FAMILY_COPY[state.familyFilter]) {
      const family = FAMILY_COPY[state.familyFilter];
      serviceHeading.textContent = name ? `Hi ${name} — ${lowerFirst(family.heading)}` : family.heading;
      serviceLead.textContent = family.lead;
    } else {
      serviceHeading.textContent = name
        ? `Hi ${name}, what can we help with today?`
        : "What do you need done?";
      serviceLead.textContent = "Pick the closest match. If you're not sure, choose \"Site visit\" and Patrick will scope it for you.";
    }

    filtered.forEach(([key, meta]) => {
      const friendly = SERVICE_META[key] || { icon: "✓", blurb: `${meta.minutes} min` };
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "service-card";
      btn.dataset.serviceKey = key;
      btn.innerHTML = `
        <span class="icon" aria-hidden="true">${friendly.icon}</span>
        <span class="label">${escapeHtml(meta.label)}</span>
        <span class="meta">${escapeHtml(friendly.blurb)} · ${escapeHtml(durationText(meta))}</span>
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
    // Strip the ?service= param from the URL so refreshing doesn't re-filter.
    const next = new URL(window.location.href);
    next.searchParams.delete("service");
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

  zonesNextBtn.addEventListener("click", () => {
    if (!bookZones.value) {
      bookZones.focus();
      return;
    }
    state.zoneCount = bookZones.value;
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
  async function loadAvailability() {
    state.days = [];
    state.selectedDate = null;
    state.selectedSlot = null;
    dayLoading.hidden = false;
    dayStrip.hidden = true;
    timeSection.hidden = true;
    noSlots.hidden = true;
    whenError.hidden = true;
    dayStrip.innerHTML = "";
    timeGrid.innerHTML = "";

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

    try {
      const url = ((window.PJL_API_BASE || "") + `/api/booking/availability?service=${encodeURIComponent(state.serviceKey)}&address=${encodeURIComponent(state.address)}&days=14`);
      const response = await fetch(url, { cache: "no-store" });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error((data.errors || ["Couldn't load availability."]).join(" "));
      state.days = data.days || [];
      state.formattedAddress = data.address || state.address;
      renderDays();
    } catch (error) {
      whenError.textContent = error.message || "We couldn't load availability right now. Please try again or call us.";
      whenError.hidden = false;
    } finally {
      dayLoading.hidden = true;
    }
  }

  function renderDays() {
    dayStrip.innerHTML = "";
    if (!state.days.length) {
      noSlots.hidden = false;
      return;
    }
    dayStrip.hidden = false;
    state.days.forEach((day) => {
      const date = new Date(`${day.date}T12:00:00`);
      const card = document.createElement("button");
      card.type = "button";
      card.className = "day-card" + (day.slots.length === 0 ? " is-empty" : "");
      card.dataset.dayDate = day.date;
      card.disabled = day.slots.length === 0;
      card.innerHTML = `
        <span class="dow">${date.toLocaleDateString("en-CA", { weekday: "short" })}</span>
        <span class="date">${date.getDate()}</span>
        <span class="month">${date.toLocaleDateString("en-CA", { month: "short" })}</span>
        <span class="slots-pill">${day.slots.length} slot${day.slots.length === 1 ? "" : "s"}</span>
      `;
      dayStrip.append(card);
    });
  }

  dayStrip.addEventListener("click", (event) => {
    const card = event.target.closest("[data-day-date]");
    if (!card || card.disabled) return;
    state.selectedDate = card.dataset.dayDate;
    dayStrip.querySelectorAll(".day-card").forEach((c) => c.classList.remove("is-active"));
    card.classList.add("is-active");
    renderTimes();
  });

  function renderTimes() {
    const day = state.days.find((d) => d.date === state.selectedDate);
    if (!day) return;
    timeGrid.innerHTML = "";
    timeSection.hidden = false;
    timeLead.textContent = `${day.label} — pick a start time:`;
    day.slots.forEach((slot) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "time-btn";
      btn.dataset.slotStart = slot.start;
      btn.textContent = slot.timeLabel;
      timeGrid.append(btn);
    });
  }

  timeGrid.addEventListener("click", (event) => {
    const btn = event.target.closest("[data-slot-start]");
    if (!btn) return;
    const day = state.days.find((d) => d.date === state.selectedDate);
    state.selectedSlot = day.slots.find((s) => s.start === btn.dataset.slotStart);
    timeGrid.querySelectorAll(".time-btn").forEach((b) => b.classList.remove("is-active"));
    btn.classList.add("is-active");
    setTimeout(() => {
      renderContactSummary();
      showStep("contact");
    }, 250);
  });

  function renderContactSummary() {
    if (!state.selectedSlot) return;
    const zoneRow = state.zoneCount
      ? `<dt>Zones</dt><dd>${escapeHtml(zoneCountLabel(state.zoneCount))}</dd>`
      : "";
    const durationLabel = state.serviceMeta.displayMinutes || `${state.serviceMeta.minutes} min`;
    contactSummary.innerHTML = `
      <dt>Service</dt><dd>${escapeHtml(state.serviceMeta.label)}</dd>
      ${zoneRow}
      <dt>Day</dt><dd>${escapeHtml(state.selectedSlot.dayLabel)}</dd>
      <dt>Time</dt><dd>${escapeHtml(state.selectedSlot.timeLabel)} (${escapeHtml(durationLabel)})</dd>
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
      const response = await fetch((window.PJL_API_BASE || "") + "/api/booking/reserve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error((data.errors || ["Couldn't reserve. Please try a different slot."]).join(" "));
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
      confirmDetail.innerHTML = `${detailIntro}${escapeHtml(state.serviceMeta.label)} is set for <strong>${escapeHtml(state.selectedSlot.dayLabel)}</strong> at <strong>${escapeHtml(state.selectedSlot.timeLabel)}</strong>.`;
      portalCta.href = data.portalUrl || "#";
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
    state.selectedDate = null;
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
            setTimeout(() => {
              showStep(landing);
              if (landing === "when") loadAvailability();
            }, 200);
            return;
          }

          // Multi-variant family without a session-locked choice: show the
          // family-filtered picker so the customer picks the right size.
          state.familyFilter = family;
        }
        renderServiceCards();
      }
    } catch (error) {
      serviceGrid.innerHTML = `<p class="lead" style="color:#a92e2e;">Couldn't load services. Please refresh, or call (905) 960-0181.</p>`;
    }
  }
  init();
})();
