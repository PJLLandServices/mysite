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
    services: {}        // catalog from /api/booking/services
  };

  // ===== DOM =====
  const steps = Array.from(document.querySelectorAll(".book-step"));
  const progressSteps = Array.from(document.querySelectorAll(".book-progress-step"));
  const serviceGrid = document.getElementById("serviceGrid");
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
    spring_open_4z:     { icon: "🌿", blurb: "≤4 zones · seasonal startup, head check, schedule reset" },
    spring_open_8z:     { icon: "🌿", blurb: "5-8 zones · seasonal startup with full system check" },
    fall_close_6z:      { icon: "🍂", blurb: "≤6 zones · winterization with compressed-air blowout" },
    fall_close_15z:     { icon: "🍂", blurb: "7-15 zones · full-system winterization" },
    sprinkler_repair:   { icon: "🔧", blurb: "90-min default · diagnose + fix on the spot" },
    hydrawise_retrofit: { icon: "📡", blurb: "Smart controller upgrade with app + WiFi setup" },
    site_visit:         { icon: "📋", blurb: "Free walkaround · we scope and quote new installs" }
  };

  function renderServiceCards() {
    serviceGrid.innerHTML = "";
    const entries = Object.entries(state.services).filter(([, m]) => m.bookable);
    entries.forEach(([key, meta]) => {
      const friendly = SERVICE_META[key] || { icon: "✓", blurb: `${meta.minutes} min` };
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "service-card";
      btn.dataset.serviceKey = key;
      btn.innerHTML = `
        <span class="icon" aria-hidden="true">${friendly.icon}</span>
        <span class="label">${escapeHtml(meta.label)}</span>
        <span class="meta">${escapeHtml(friendly.blurb)} · ${meta.minutes} min</span>
      `;
      serviceGrid.append(btn);
    });
  }

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
        renderServiceCards();
        // Honor ?service= deep link from CTAs elsewhere on the site.
        const params = new URLSearchParams(window.location.search);
        const preselect = params.get("service");
        if (preselect && state.services[preselect]) {
          const card = serviceGrid.querySelector(`[data-service-key="${preselect}"]`);
          if (card) card.click();
        }
      }
    } catch (error) {
      serviceGrid.innerHTML = `<p class="lead" style="color:#a92e2e;">Couldn't load services. Please refresh, or call (905) 960-0181.</p>`;
    }
  }
  init();
})();
