// PJL Unified Time Picker — month calendar + slot list.
//
// Single shared module used by:
//   - Public booking flow      (book.html / js/booking.js)
//   - Customer portal reschedule (server/portal.html / portal.js)
//   - Admin reschedule modal     (server/crm-reschedule.js, used by schedule + WO pages)
//   - Admin +Book a customer     (server/schedule.html / schedule.js)
//
// Exposes a single global: window.mountTimePicker(rootEl, options).
//
// Contract:
//   mountTimePicker(rootEl, {
//     mode: "customer" | "admin",          // gates the Custom time block
//     loadAvailability: async ({from, to}) => { days: [{date, slots, reason?}] },
//     onSelect: (isoDatetime, slotMeta) => void,
//     allowCustomTime: boolean,            // default mode === "admin"; ignored when customer
//     initialMonth: "YYYY-MM" | Date,      // default = current month
//     currentDate: Date,                   // "today" override (testing)
//     customDurationMinutes: number        // default 60 — used to compute end of an admin custom-time pick
//   })
//
// The picker is idempotent on the same root: a second call to mountTimePicker()
// tears down the previous instance first.
//
// Calls onSelect(iso, slot) when a slot is chosen. `slot.source === "admin_custom"`
// when the admin used the Custom time override.

(function () {
  if (window.mountTimePicker) return; // already loaded

  const WEEKDAY_LETTERS = ["S", "M", "T", "W", "T", "F", "S"];
  const MONTH_NAMES = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];

  // YYYY-MM-DD from a Date in LOCAL time. The availability endpoint emits
  // dates in local Toronto time and we need to match those strings exactly
  // (using toISOString() here would silently shift across midnight UTC).
  function localDateKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  function parseDateKey(key) {
    // Parse YYYY-MM-DD as a local-midnight Date (NOT UTC, which would shift
    // by the local offset and put the date on the wrong calendar day).
    const [y, m, d] = String(key).split("-").map(Number);
    return new Date(y, (m || 1) - 1, d || 1);
  }

  function escapeHtml(value) {
    return String(value == null ? "" : value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function isSameDay(a, b) {
    return a.getFullYear() === b.getFullYear()
      && a.getMonth() === b.getMonth()
      && a.getDate() === b.getDate();
  }

  // The 6×7 visible window for a given month: start on the Sunday of (or
  // before) the 1st, end on the Saturday of (or after) the last day.
  // Always returns 42 days so the grid height never jumps.
  function monthGridRange(year, month) {
    const first = new Date(year, month, 1);
    const startOffset = first.getDay(); // 0 = Sunday
    const from = new Date(year, month, 1 - startOffset);
    const to = new Date(from);
    to.setDate(from.getDate() + 41);
    return { from, to };
  }

  function mountTimePicker(rootEl, opts = {}) {
    if (!rootEl || rootEl.nodeType !== 1) {
      throw new Error("mountTimePicker: rootEl must be an element");
    }

    // Idempotent: tear down any prior instance on this root before mounting.
    if (typeof rootEl.__tpDestroy === "function") {
      try { rootEl.__tpDestroy(); } catch (_) { /* swallow */ }
    }

    const mode = opts.mode === "admin" ? "admin" : "customer";
    const allowCustomTime = mode === "admin"
      ? (opts.allowCustomTime !== false)   // admin default: on
      : false;                              // customer: always off
    // The open bucket ("first available") — opt-in per mount, so the
    // public booking page shows it and the portal-reschedule / admin
    // pickers (where it makes no sense) stay exactly as they are.
    const allowOpenBucket = opts.allowOpenBucket === true;
    const loadAvailability = typeof opts.loadAvailability === "function"
      ? opts.loadAvailability
      : null;
    const onSelect = typeof opts.onSelect === "function" ? opts.onSelect : null;
    const today = opts.currentDate instanceof Date ? new Date(opts.currentDate) : new Date();
    today.setHours(0, 0, 0, 0);
    const customDurationMinutes = Number(opts.customDurationMinutes) || 60;

    if (!loadAvailability) {
      rootEl.innerHTML = `<p class="tp-error" role="alert">Time picker misconfigured (no loader).</p>`;
      return () => {};
    }

    // Resolve initial month.
    let initialDate;
    if (opts.initialMonth instanceof Date) {
      initialDate = new Date(opts.initialMonth);
    } else if (typeof opts.initialMonth === "string" && /^\d{4}-\d{2}/.test(opts.initialMonth)) {
      const [y, m] = opts.initialMonth.split("-").map(Number);
      initialDate = new Date(y, (m || 1) - 1, 1);
    } else {
      initialDate = new Date(today);
    }
    let viewYear = initialDate.getFullYear();
    let viewMonth = initialDate.getMonth();

    // State.
    const daysByDate = new Map(); // 'YYYY-MM-DD' -> { slots, reason? }
    let selectedDate = null;       // 'YYYY-MM-DD'
    let selectedSlotStart = null;  // ISO datetime
    let loadingMonthKey = "";      // most-recent fetch key (used to cancel stale fetches)
    let lookaheadStarted = false;  // one wide fetch past the visible month, for the call-out
    let destroyed = false;

    // Root scaffolding.
    rootEl.innerHTML = "";
    rootEl.classList.add("tp");
    const wrap = document.createElement("div");
    wrap.className = "tp-wrap";
    wrap.innerHTML = `
      <div class="tp-calendar">
        <header class="tp-header">
          <button type="button" class="tp-nav tp-nav-prev" aria-label="Previous month">‹</button>
          <h3 class="tp-month-label" data-month-label></h3>
          <button type="button" class="tp-nav tp-nav-next" aria-label="Next month">›</button>
        </header>
        <div class="tp-weekdays" aria-hidden="true">
          ${WEEKDAY_LETTERS.map((l) => `<span>${l}</span>`).join("")}
        </div>
        <div class="tp-callout" data-legend role="status" hidden>
          <span class="tp-callout-star" aria-hidden="true">★</span>
          <span class="tp-callout-text">
            <strong class="tp-callout-title">We're already in your neighbourhood!</strong>
            <span class="tp-callout-body" data-callout-body>Pick a starred day — our crew is scheduled near you.</span>
            <button type="button" class="tp-callout-jump" data-callout-jump hidden></button>
          </span>
        </div>
        <div class="tp-grid" data-grid role="grid"></div>
        <p class="tp-month-empty" data-month-empty hidden>
          No availability this month. Try next month.
        </p>
        <p class="tp-error" data-error role="alert" hidden></p>
      </div>
      <div class="tp-slots" data-slots hidden>
        <h4 class="tp-slots-label" data-slots-label>Pick a time</h4>
        <div class="tp-slot-grid" data-slot-grid></div>
      </div>
    `;
    if (allowCustomTime) {
      const custom = document.createElement("div");
      custom.className = "tp-custom";
      custom.innerHTML = `
        <button type="button" class="tp-custom-toggle" data-custom-toggle aria-expanded="false">
          + Custom time
        </button>
        <div class="tp-custom-body" data-custom-body hidden>
          <p class="tp-custom-help">Use any date and time, outside the standard slot grid.</p>
          <div class="tp-custom-fields">
            <label class="tp-custom-field">
              <span>Date</span>
              <input type="date" data-custom-date>
            </label>
            <label class="tp-custom-field">
              <span>Time</span>
              <input type="time" data-custom-time step="900">
            </label>
          </div>
          <button type="button" class="tp-custom-submit" data-custom-submit disabled>
            Use this time
          </button>
          <p class="tp-custom-error" data-custom-error role="alert" hidden></p>
        </div>
      `;
      wrap.appendChild(custom);
    }
    if (allowOpenBucket) {
      const open = document.createElement("button");
      open.type = "button";
      open.className = "tp-openbucket";
      open.innerHTML = `
        <span class="tp-openbucket-flag">First available</span>
        <strong class="tp-openbucket-title">Skip the calendar — we'll fit you in.</strong>
        <span class="tp-openbucket-body">Join our route: the next time our crew is working in your
        neighbourhood, you're on the list. We confirm your exact day ahead of time.</span>
        <span class="tp-openbucket-cta">Fit me in when you're nearby →</span>`;
      open.addEventListener("click", () => {
        if (onSelect) onSelect(null, { source: "open_bucket" });
      });
      wrap.insertBefore(open, wrap.firstChild);
    }
    rootEl.appendChild(wrap);

    // Element handles.
    const monthLabelEl = wrap.querySelector("[data-month-label]");
    const gridEl = wrap.querySelector("[data-grid]");
    const monthEmptyEl = wrap.querySelector("[data-month-empty]");
    const legendEl = wrap.querySelector("[data-legend]");
    const calloutBodyEl = wrap.querySelector("[data-callout-body]");
    const calloutJumpEl = wrap.querySelector("[data-callout-jump]");
    const errorEl = wrap.querySelector("[data-error]");
    const slotsBlock = wrap.querySelector("[data-slots]");
    const slotsLabelEl = wrap.querySelector("[data-slots-label]");
    const slotGridEl = wrap.querySelector("[data-slot-grid]");
    const prevBtn = wrap.querySelector(".tp-nav-prev");
    const nextBtn = wrap.querySelector(".tp-nav-next");
    const customToggleEl = wrap.querySelector("[data-custom-toggle]");
    const customBodyEl = wrap.querySelector("[data-custom-body]");
    const customDateEl = wrap.querySelector("[data-custom-date]");
    const customTimeEl = wrap.querySelector("[data-custom-time]");
    const customSubmitEl = wrap.querySelector("[data-custom-submit]");
    const customErrorEl = wrap.querySelector("[data-custom-error]");

    // Customer mode cannot navigate to months in the past.
    function canNavigatePrev() {
      if (mode === "admin") return true;
      const firstOfThisMonth = new Date(today.getFullYear(), today.getMonth(), 1);
      const firstOfView = new Date(viewYear, viewMonth, 1);
      return firstOfView.getTime() > firstOfThisMonth.getTime();
    }

    function renderMonthLabel() {
      monthLabelEl.textContent = `${MONTH_NAMES[viewMonth]} ${viewYear}`;
      prevBtn.disabled = !canNavigatePrev();
    }

    function renderGrid() {
      const { from } = monthGridRange(viewYear, viewMonth);
      gridEl.innerHTML = "";
      let anyAvailableThisMonth = false;
      for (let i = 0; i < 42; i++) {
        const cellDate = new Date(from);
        cellDate.setDate(from.getDate() + i);
        const key = localDateKey(cellDate);
        const inThisMonth = cellDate.getMonth() === viewMonth;
        const inPast = cellDate.getTime() < today.getTime();
        const data = daysByDate.get(key);
        const hasSlots = Boolean(data && data.slots && data.slots.length);
        // Best-day stars: the server marks the days where this address
        // joins a route we're already driving. Pure presentation here —
        // the ranking lives server-side with the drive-time math.
        const recommended = Boolean(hasSlots && !inPast && data.recommended);
        const classes = ["tp-day"];
        if (!inThisMonth) classes.push("is-other-month");
        if (isSameDay(cellDate, today)) classes.push("is-today");
        if (inPast || !hasSlots) classes.push("is-unavailable");
        else classes.push("is-available");
        if (recommended) classes.push("is-recommended");
        if (selectedDate === key) classes.push("is-selected");
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = classes.join(" ");
        btn.dataset.date = key;
        btn.textContent = String(cellDate.getDate());
        if (!hasSlots || inPast) {
          btn.disabled = true;
        } else if (recommended) {
          btn.title = "Best day for your address — we're already in your neighbourhood";
          btn.setAttribute("aria-label", `${key} — best day for your address`);
        } else {
          btn.title = `${data.slots.length} slot${data.slots.length === 1 ? "" : "s"}`;
        }
        gridEl.appendChild(btn);
        if (hasSlots && inThisMonth) anyAvailableThisMonth = true;
      }
      monthEmptyEl.hidden = anyAvailableThisMonth;
      renderCallout();
    }

    // The customer's single best day across EVERYTHING loaded — not just
    // the month on screen. Cheapest added drive first, earliest date
    // breaking ties. (YYYY-MM-DD keys compare correctly as strings.)
    function computeBestDay() {
      const todayKey = localDateKey(today);
      let best = null;
      daysByDate.forEach((data, key) => {
        if (!data || !data.recommended || !(data.slots && data.slots.length)) return;
        if (key < todayKey) return;
        const cost = Number.isFinite(data.addedDriveMinutes) ? data.addedDriveMinutes : Infinity;
        if (!best || cost < best.cost || (cost === best.cost && key < best.key)) {
          best = { key, cost };
        }
      });
      return best;
    }

    // The big call-out shows the moment ANY loaded day is starred, even
    // when that day sits in a month the customer hasn't paged to yet
    // (Patrick: "we should populate this right away") — with a button
    // that jumps the calendar straight to it.
    function renderCallout() {
      if (!legendEl) return;
      const best = computeBestDay();
      if (!best) {
        legendEl.hidden = true;
        return;
      }
      const bestDate = parseDateKey(best.key);
      const label = bestDate.toLocaleDateString("en-CA", {
        weekday: "long", month: "long", day: "numeric"
      });
      if (calloutBodyEl) {
        calloutBodyEl.textContent = `Our crew is already booked near your address on ${label}. `
          + `Choose that day and we'll be right around the corner — one tight route through your `
          + `neighbourhood means an on-time arrival and the smoothest visit for you. `
          + `Days marked ★ are your best picks.`;
      }
      if (calloutJumpEl) {
        const inView = bestDate.getFullYear() === viewYear && bestDate.getMonth() === viewMonth;
        calloutJumpEl.textContent = inView ? `★ Pick ${label}` : `★ Take me to ${label}`;
        calloutJumpEl.dataset.date = best.key;
        calloutJumpEl.hidden = false;
      }
      legendEl.hidden = false;
    }

    // One wide background fetch (today → +90 days) after the first month
    // lands, so the call-out can name a best day that lives past the
    // visible 6-week window. Month rows already loaded are kept as-is.
    async function loadLookahead() {
      const from = localDateKey(today);
      const toDate = new Date(today);
      toDate.setDate(toDate.getDate() + 90);
      try {
        const result = await loadAvailability({ from, to: localDateKey(toDate) });
        if (destroyed) return;
        const days = (result && Array.isArray(result.days)) ? result.days : [];
        days.forEach((day) => {
          if (day && day.date && !daysByDate.has(day.date)) daysByDate.set(day.date, day);
        });
        renderGrid(); // repaint stars + call-out with the wider horizon
      } catch (_) {
        // Non-fatal: the call-out just stays scoped to what the month
        // fetches have seen.
      }
    }

    function renderSlotsList() {
      if (!selectedDate) {
        slotsBlock.hidden = true;
        slotGridEl.innerHTML = "";
        return;
      }
      const data = daysByDate.get(selectedDate);
      const slots = (data && data.slots) || [];
      if (!slots.length) {
        slotsBlock.hidden = true;
        slotGridEl.innerHTML = "";
        return;
      }
      const dateObj = parseDateKey(selectedDate);
      slotsLabelEl.textContent = `${dateObj.toLocaleDateString("en-CA", {
        weekday: "long", month: "long", day: "numeric"
      })} — pick a time`;
      slotGridEl.innerHTML = "";
      slots.forEach((slot) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "tp-slot" + (selectedSlotStart === slot.start ? " is-selected" : "");
        btn.dataset.slotStart = slot.start;
        const primary = slot.timeLabel || new Date(slot.start).toLocaleTimeString("en-CA", {
          hour: "numeric", minute: "2-digit"
        });
        // bucketWindow ("8 AM – 12 PM") shows under the label when present;
        // legacy slots without it fall back to the duration in minutes.
        const subtitle = slot.bucketWindow
          ? `<span class="tp-slot-dur">${escapeHtml(slot.bucketWindow)}</span>`
          : (slot.durationMinutes ? `<span class="tp-slot-dur">${slot.durationMinutes} min</span>` : "");
        btn.innerHTML = `<span class="tp-slot-time">${escapeHtml(primary)}</span>${subtitle}`;
        slotGridEl.appendChild(btn);
      });
      slotsBlock.hidden = false;
    }

    function showError(message) {
      errorEl.textContent = message || "Couldn't load availability.";
      errorEl.hidden = false;
    }
    function clearError() {
      errorEl.hidden = true;
      errorEl.textContent = "";
    }

    async function loadMonth() {
      const { from, to } = monthGridRange(viewYear, viewMonth);
      const fromKey = localDateKey(from);
      const toKey = localDateKey(to);
      const fetchKey = `${fromKey}…${toKey}`;
      loadingMonthKey = fetchKey;
      clearError();
      gridEl.setAttribute("aria-busy", "true");
      try {
        const result = await loadAvailability({ from: fromKey, to: toKey });
        if (destroyed || loadingMonthKey !== fetchKey) return; // stale or torn down
        const days = (result && Array.isArray(result.days)) ? result.days : [];
        days.forEach((day) => {
          if (day && day.date) daysByDate.set(day.date, day);
        });
        renderGrid();
        // If the selected date was lost on month nav, hide the slot list.
        if (selectedDate && !daysByDate.has(selectedDate)) {
          selectedDate = null;
          selectedSlotStart = null;
        }
        renderSlotsList();
        if (!lookaheadStarted) {
          lookaheadStarted = true;
          loadLookahead();
        }
      } catch (err) {
        if (destroyed) return;
        showError(err && err.message ? err.message : "Couldn't load availability.");
      } finally {
        gridEl.removeAttribute("aria-busy");
      }
    }

    // ---- Event wiring ----
    prevBtn.addEventListener("click", () => {
      if (!canNavigatePrev()) return;
      viewMonth--;
      if (viewMonth < 0) { viewMonth = 11; viewYear--; }
      selectedDate = null;
      selectedSlotStart = null;
      renderSlotsList();
      renderMonthLabel();
      renderGrid();
      loadMonth();
    });
    nextBtn.addEventListener("click", () => {
      viewMonth++;
      if (viewMonth > 11) { viewMonth = 0; viewYear++; }
      selectedDate = null;
      selectedSlotStart = null;
      renderSlotsList();
      renderMonthLabel();
      renderGrid();
      loadMonth();
    });

    if (calloutJumpEl) {
      calloutJumpEl.addEventListener("click", () => {
        const key = calloutJumpEl.dataset.date;
        if (!key || !daysByDate.has(key)) return;
        const target = parseDateKey(key);
        const monthChanged = target.getFullYear() !== viewYear || target.getMonth() !== viewMonth;
        viewYear = target.getFullYear();
        viewMonth = target.getMonth();
        selectedDate = key;
        selectedSlotStart = null;
        renderMonthLabel();
        renderGrid();
        renderSlotsList();
        // Fill in the rest of the target month's grid window; the selected
        // day's own data is already here, so the slot list shows now.
        if (monthChanged) loadMonth();
        try {
          slotsBlock.scrollIntoView({ behavior: "smooth", block: "nearest" });
        } catch (_) { /* older browsers — no-op */ }
      });
    }

    gridEl.addEventListener("click", (event) => {
      const cell = event.target.closest(".tp-day");
      if (!cell || cell.disabled) return;
      const key = cell.dataset.date;
      if (!key) return;
      selectedDate = key;
      selectedSlotStart = null;
      // Repaint selected highlight on grid + render slots.
      gridEl.querySelectorAll(".tp-day.is-selected").forEach((d) => d.classList.remove("is-selected"));
      cell.classList.add("is-selected");
      renderSlotsList();
      // Scroll the slot block into view on narrow viewports so the customer
      // doesn't have to hunt for it under the calendar.
      try {
        slotsBlock.scrollIntoView({ behavior: "smooth", block: "nearest" });
      } catch (_) { /* older browsers — no-op */ }
    });

    slotGridEl.addEventListener("click", (event) => {
      const btn = event.target.closest(".tp-slot");
      if (!btn) return;
      const start = btn.dataset.slotStart;
      if (!start) return;
      selectedSlotStart = start;
      slotGridEl.querySelectorAll(".tp-slot.is-selected").forEach((b) => b.classList.remove("is-selected"));
      btn.classList.add("is-selected");
      const data = daysByDate.get(selectedDate);
      const slot = (data && data.slots || []).find((s) => s.start === start);
      if (onSelect && slot) {
        onSelect(slot.start, { ...slot, source: "slot" });
      }
    });

    if (allowCustomTime) {
      customToggleEl.addEventListener("click", () => {
        const expanded = customToggleEl.getAttribute("aria-expanded") === "true";
        customToggleEl.setAttribute("aria-expanded", String(!expanded));
        customBodyEl.hidden = expanded;
        if (!expanded) {
          // Default to selected day (or today) when first opening.
          if (!customDateEl.value) {
            customDateEl.value = selectedDate || localDateKey(today);
          }
          if (!customTimeEl.value) {
            customTimeEl.value = "08:00";
          }
        }
      });
      const updateCustomSubmitState = () => {
        customSubmitEl.disabled = !(customDateEl.value && customTimeEl.value);
        customErrorEl.hidden = true;
      };
      customDateEl.addEventListener("input", updateCustomSubmitState);
      customTimeEl.addEventListener("input", updateCustomSubmitState);
      customSubmitEl.addEventListener("click", () => {
        const dateVal = customDateEl.value;
        const timeVal = customTimeEl.value;
        if (!dateVal || !timeVal) return;
        // Build a local-time datetime so toISOString() converts cleanly.
        const [y, m, d] = dateVal.split("-").map(Number);
        const [hh, mm] = timeVal.split(":").map(Number);
        const dt = new Date(y, (m || 1) - 1, d || 1, hh || 0, mm || 0, 0, 0);
        if (Number.isNaN(dt.getTime())) {
          customErrorEl.textContent = "That date/time looks invalid.";
          customErrorEl.hidden = false;
          return;
        }
        const iso = dt.toISOString();
        const endIso = new Date(dt.getTime() + customDurationMinutes * 60 * 1000).toISOString();
        if (onSelect) {
          onSelect(iso, {
            start: iso,
            end: endIso,
            durationMinutes: customDurationMinutes,
            source: "admin_custom"
          });
        }
      });
    }

    // First paint.
    renderMonthLabel();
    renderGrid();
    loadMonth();

    function destroy() {
      destroyed = true;
      rootEl.innerHTML = "";
      rootEl.classList.remove("tp");
      delete rootEl.__tpDestroy;
    }
    rootEl.__tpDestroy = destroy;
    return destroy;
  }

  window.mountTimePicker = mountTimePicker;
})();
