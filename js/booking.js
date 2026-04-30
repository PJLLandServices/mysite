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
    selectedDate: null, // YYYY-MM-DD
    selectedSlot: null, // { start, end, timeLabel, ... }
    days: [],           // grouped slots from /api/booking/availability
    services: {},       // catalog from /api/booking/services
    familyFilter: null  // when set, only services with this `family` are shown
  };

  // ===== DOM =====
  const steps = Array.from(document.querySelectorAll(".book-step"));
  const progressSteps = Array.from(document.querySelectorAll(".book-progress-step"));
  const serviceGrid = document.getElementById("serviceGrid");
  const serviceHeading = document.getElementById("serviceHeading");
  const serviceLead = document.getElementById("serviceLead");
  const bookOtherWrap = document.getElementById("bookOtherWrap");
  const bookOtherLink = document.getElementById("bookOther");
  const addressInput = document.getElementById("bookAddress");
  const addressNextBtn = document.getElementById("addressNextBtn");
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

  function showStep(name) {
    state.step = name;
    steps.forEach((s) => { s.hidden = s.dataset.step !== name; });

    // Update progress strip — current = name, completed = anything before it.
    const order = ["service", "address", "when", "contact", "confirm"];
    const idx = order.indexOf(name);
    progressSteps.forEach((p, i) => {
      p.classList.remove("is-current", "is-complete");
      if (i < idx) p.classList.add("is-complete");
      else if (i === idx) p.classList.add("is-current");
    });

    // Scroll to the active step on mobile so the user always sees it.
    const active = steps.find((s) => s.dataset.step === name);
    if (active) active.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // ===== Service catalog =====
  // Friendly meta — emoji + short blurb — keyed off what server.js exposes
  // via /api/booking/services. If the server adds a new bookable service
  // with no entry here, it falls back to a default icon.
  const SERVICE_META = {
    spring_open_4z:         { icon: "🌿", blurb: "≤4 zones · seasonal startup, head check, schedule reset" },
    spring_open_8z:         { icon: "🌿", blurb: "5-7 zones · seasonal startup with full system check" },
    spring_open_15z:        { icon: "🌿", blurb: "8+ zones · large-system startup with full inspection" },
    spring_open_commercial: { icon: "🏢", blurb: "Commercial property · morning or afternoon appointment" },
    fall_close_6z:          { icon: "🍂", blurb: "≤6 zones · winterization with compressed-air blowout" },
    fall_close_15z:         { icon: "🍂", blurb: "7-15 zones · full-system winterization" },
    fall_close_commercial:  { icon: "🏢", blurb: "Commercial winterization · morning or afternoon appointment" },
    sprinkler_repair:       { icon: "🔧", blurb: "90-min default · diagnose + fix on the spot" },
    hydrawise_retrofit:     { icon: "📡", blurb: "Smart controller upgrade with app + WiFi setup" },
    site_visit:             { icon: "📋", blurb: "Free walkaround · we scope and quote new installs" }
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
    // it; otherwise fall back to the generic catalog view.
    if (state.familyFilter && FAMILY_COPY[state.familyFilter]) {
      serviceHeading.textContent = FAMILY_COPY[state.familyFilter].heading;
      serviceLead.textContent = FAMILY_COPY[state.familyFilter].lead;
    } else {
      serviceHeading.textContent = "What do you need done?";
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
    setTimeout(() => showStep("address"), 250);
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

    whenLead.textContent = `Showing real-time openings for ${state.serviceMeta.label} at ${state.address}.`;

    try {
      const url = `/api/booking/availability?service=${encodeURIComponent(state.serviceKey)}&address=${encodeURIComponent(state.address)}&days=14`;
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
    contactSummary.innerHTML = `
      <dt>Service</dt><dd>${escapeHtml(state.serviceMeta.label)}</dd>
      <dt>Day</dt><dd>${escapeHtml(state.selectedSlot.dayLabel)}</dd>
      <dt>Time</dt><dd>${escapeHtml(state.selectedSlot.timeLabel)} (${state.serviceMeta.minutes} min)</dd>
      <dt>Address</dt><dd>${escapeHtml(state.formattedAddress)}</dd>
    `;
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
          notes: bookNotes.value.trim()
        },
        pageUrl: window.location.href,
        userAgent: navigator.userAgent
      };
      const response = await fetch("/api/booking/reserve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error((data.errors || ["Couldn't reserve. Please try a different slot."]).join(" "));
      // Success
      confirmTitle.textContent = `${bookFirst.value.trim()}, you're booked!`;
      confirmDetail.innerHTML = `Your ${escapeHtml(state.serviceMeta.label)} is set for <strong>${escapeHtml(state.selectedSlot.dayLabel)}</strong> at <strong>${escapeHtml(state.selectedSlot.timeLabel)}</strong>.`;
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

  // ===== Bootstrap: load service catalog =====
  async function init() {
    try {
      const response = await fetch("/api/booking/services", { cache: "no-store" });
      const data = await response.json();
      if (data.ok) {
        state.services = data.services || {};

        // Honor ?service= deep link from CTAs elsewhere on the site.
        // If the param matches a service key, pull its family out of the
        // catalog and use that as the filter — so clicking "Book Spring
        // Opening" elsewhere shows ALL spring opening variants (4z / 5-7z /
        // 8+z / commercial), not just the 4z it linked to. The customer
        // picks the right size before continuing.
        const params = new URLSearchParams(window.location.search);
        const preselect = params.get("service");
        if (preselect && state.services[preselect]) {
          const family = state.services[preselect].family;
          if (family) {
            const familyMembers = Object.values(state.services)
              .filter((m) => m.bookable && m.family === family);
            // If only one variant exists in this family, jump straight past
            // the picker. Otherwise filter the grid to the family and let
            // the customer choose.
            if (familyMembers.length === 1) {
              state.serviceKey = preselect;
              state.serviceMeta = state.services[preselect];
              renderServiceCards();
              setTimeout(() => showStep("address"), 200);
              return;
            }
            state.familyFilter = family;
          }
        }
        renderServiceCards();
      }
    } catch (error) {
      serviceGrid.innerHTML = `<p class="lead" style="color:#a92e2e;">Couldn't load services. Please refresh, or call (905) 960-0181.</p>`;
    }
  }
  init();
})();
