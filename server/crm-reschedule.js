// Shared admin reschedule modal. Loaded on every admin page that needs
// it (desktop work-order, tech-mode work-order, schedule grid). Exposes
// a single global `openCrmReschedule({ bookingId, leadId, onDone })` —
// callers pass either the BK- id directly or a leadId for resolution.
//
// Visual contract: single-panel centered modal that scrolls vertically
// inside the card. NO bottom-sheet, NO slide-up, NO drawer. Patrick
// explicitly does not want sliding panels in any modal.
//
// The same /api/bookings/:id/availability + /api/bookings/:id/reschedule
// endpoints back this UI; the customer-side portal modal is a parallel
// implementation against /api/portal/:token/* routes.

(function () {
  if (window.openCrmReschedule) return; // already loaded

  // Lazy-create the modal DOM the first time it's opened. Saves every
  // admin page from having to embed the markup; one source of truth.
  let modal = null;
  let onDoneCb = null;
  let selectedSlot = "";
  let bookingId = "";

  function ensureModal() {
    if (modal) return modal;
    modal = document.createElement("div");
    modal.className = "crm-resched-modal";
    modal.hidden = true;
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.innerHTML = `
      <div class="crm-resched-card">
        <header class="crm-resched-header">
          <h2>Reschedule appointment</h2>
          <button type="button" class="crm-resched-close" aria-label="Cancel">×</button>
        </header>
        <div class="crm-resched-body">
          <p class="crm-resched-current">Currently scheduled: <strong data-current>—</strong></p>
          <p class="crm-resched-help" data-help>Loading available times…</p>
          <div class="crm-resched-slots" data-slots></div>
          <label class="crm-resched-reason-label">Reason / note (optional)</label>
          <textarea class="crm-resched-reason" rows="2" maxlength="200" placeholder="e.g. customer asked to push back a day"></textarea>
          <div class="crm-resched-actions">
            <button type="button" class="crm-resched-cancel">Cancel</button>
            <button type="button" class="crm-resched-submit" disabled>Confirm new time</button>
          </div>
          <p class="crm-resched-error" hidden role="alert"></p>
          <p class="crm-resched-status" role="status"></p>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    modal.querySelector(".crm-resched-close").addEventListener("click", close);
    modal.querySelector(".crm-resched-cancel").addEventListener("click", close);
    modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
    document.addEventListener("keydown", (e) => {
      if (!modal.hidden && e.key === "Escape") close();
    });
    modal.querySelector(".crm-resched-submit").addEventListener("click", submit);
    return modal;
  }

  // Bucket a day's slots into Morning / Midday / Afternoon / Evening.
  // Returns the FIRST slot in each bucket so the time picker shows max
  // 4 buttons. Empty buckets are skipped.
  function condenseSlotsForDay(slots) {
    const buckets = [
      { key: "morning",   label: "Morning",   from: 8,  to: 11 },
      { key: "midday",    label: "Midday",    from: 11, to: 14 },
      { key: "afternoon", label: "Afternoon", from: 14, to: 17 },
      { key: "evening",   label: "Evening",   from: 17, to: 22 }
    ];
    return buckets
      .map((b) => ({
        ...b,
        slot: slots.find((s) => {
          const h = new Date(s.start).getHours();
          return h >= b.from && h < b.to;
        })
      }))
      .filter((b) => b.slot);
  }

  // Render a date-first picker. The user picks a date from the list
  // (cleaner + more scannable than 25 days of buttons stacked), then
  // picks a time bucket below the chosen date. Only one date stays
  // expanded at a time. Inline expand — no slide / drawer / sheet.
  function renderSlots(days) {
    const slotsEl = modal.querySelector("[data-slots]");
    const helpEl = modal.querySelector("[data-help]");
    slotsEl.innerHTML = "";
    let totalDays = 0;
    days.forEach((day) => {
      const condensed = condenseSlotsForDay(day.slots || []);
      if (!condensed.length) return;
      totalDays++;
      const dateBtn = document.createElement("button");
      dateBtn.type = "button";
      dateBtn.className = "crm-resched-date";
      dateBtn.innerHTML = `
        <span class="crm-resched-date-label">${escapeHtml(day.label || day.date || "")}</span>
        <span class="crm-resched-date-count">${condensed.length} time${condensed.length === 1 ? "" : "s"}</span>
      `;
      const timesRow = document.createElement("div");
      timesRow.className = "crm-resched-times";
      timesRow.hidden = true;
      condensed.forEach((b) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "crm-resched-slot-btn";
        const time = new Date(b.slot.start).toLocaleTimeString("en-CA", {
          hour: "numeric", minute: "2-digit"
        });
        btn.innerHTML = `${time}<span class="crm-resched-bucket">${b.label}</span>`;
        btn.addEventListener("click", () => {
          slotsEl.querySelectorAll(".crm-resched-slot-btn.is-selected").forEach((x) => x.classList.remove("is-selected"));
          btn.classList.add("is-selected");
          selectedSlot = b.slot.start;
          modal.querySelector(".crm-resched-submit").disabled = false;
          modal.querySelector(".crm-resched-error").hidden = true;
        });
        timesRow.appendChild(btn);
      });
      dateBtn.addEventListener("click", () => {
        // Toggle: collapse all other dates, expand this one.
        slotsEl.querySelectorAll(".crm-resched-date.is-open").forEach((d) => d.classList.remove("is-open"));
        slotsEl.querySelectorAll(".crm-resched-times").forEach((t) => { t.hidden = true; });
        const wasOpen = dateBtn.dataset.open === "1";
        if (!wasOpen) {
          dateBtn.classList.add("is-open");
          timesRow.hidden = false;
          dateBtn.dataset.open = "1";
        } else {
          dateBtn.dataset.open = "0";
        }
      });
      slotsEl.appendChild(dateBtn);
      slotsEl.appendChild(timesRow);
    });
    if (!totalDays) {
      helpEl.hidden = false;
      helpEl.textContent = "No available slots in the next 30 days. Block the calendar for a custom time, or adjust working hours in /admin/schedule.";
    } else {
      helpEl.hidden = true;
    }
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  async function resolveBookingId({ bookingId: bid, leadId, scheduledFor }) {
    if (bid) return bid;
    if (!leadId) return null;
    try {
      const r = await fetch(`/api/bookings?leadId=${encodeURIComponent(leadId)}`);
      const data = await r.json();
      if (data.ok && Array.isArray(data.bookings) && data.bookings.length) {
        // If the caller knows the exact start time (e.g. clicked a
        // specific card on the schedule grid), match on that — a lead
        // with multiple bookings (original + follow-up) needs this to
        // pick the right one.
        if (scheduledFor) {
          const exact = data.bookings.find((b) => b.scheduledFor === scheduledFor);
          if (exact) return exact.id;
        }
        // Fallback: prefer non-terminal records, most recently scheduled.
        const sorted = data.bookings
          .filter((b) => b.status !== "cancelled" && b.status !== "completed" && b.status !== "no_show")
          .sort((a, b) => new Date(b.scheduledFor || 0) - new Date(a.scheduledFor || 0));
        return sorted[0]?.id || data.bookings[0].id;
      }
    } catch {}
    return null;
  }

  async function open(opts = {}) {
    ensureModal();
    selectedSlot = "";
    bookingId = "";
    onDoneCb = typeof opts.onDone === "function" ? opts.onDone : null;
    modal.hidden = false;
    document.body.style.overflow = "hidden";
    const helpEl = modal.querySelector("[data-help]");
    const slotsEl = modal.querySelector("[data-slots]");
    const currentEl = modal.querySelector("[data-current]");
    const errorEl = modal.querySelector(".crm-resched-error");
    const statusEl = modal.querySelector(".crm-resched-status");
    const submitEl = modal.querySelector(".crm-resched-submit");
    helpEl.hidden = false;
    helpEl.textContent = "Loading available times…";
    slotsEl.innerHTML = "";
    currentEl.textContent = "—";
    errorEl.hidden = true;
    statusEl.textContent = "";
    submitEl.disabled = true;
    modal.querySelector(".crm-resched-reason").value = "";
    try {
      const id = await resolveBookingId(opts);
      if (!id) throw new Error("No booking record found for this customer.");
      bookingId = id;
      const r = await fetch(`/api/bookings/${encodeURIComponent(id)}/availability`, { cache: "no-store" });
      const data = await r.json();
      if (!data.ok) throw new Error((data.errors || ["Couldn't load times."]).join(" "));
      if (data.currentScheduledFor) {
        const d = new Date(data.currentScheduledFor);
        currentEl.textContent = d.toLocaleString("en-CA", {
          weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit"
        });
      }
      renderSlots(data.days || []);
    } catch (err) {
      helpEl.hidden = false;
      helpEl.textContent = err.message || "Couldn't load times.";
    }
  }

  function close() {
    if (!modal) return;
    modal.hidden = true;
    document.body.style.overflow = "";
    selectedSlot = "";
    bookingId = "";
    onDoneCb = null;
  }

  async function submit() {
    if (!bookingId || !selectedSlot) return;
    const submitEl = modal.querySelector(".crm-resched-submit");
    const errorEl = modal.querySelector(".crm-resched-error");
    const statusEl = modal.querySelector(".crm-resched-status");
    const reasonEl = modal.querySelector(".crm-resched-reason");
    submitEl.disabled = true;
    errorEl.hidden = true;
    statusEl.textContent = "Confirming…";
    try {
      const r = await fetch(`/api/bookings/${encodeURIComponent(bookingId)}/reschedule`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          slotStart: selectedSlot,
          reason: (reasonEl.value || "").trim()
        })
      });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error((data.errors || ["Couldn't reschedule."]).join(" "));
      statusEl.textContent = "Done. Customer notified.";
      const cb = onDoneCb;
      setTimeout(() => {
        close();
        if (cb) cb(data);
      }, 700);
    } catch (err) {
      submitEl.disabled = false;
      errorEl.hidden = false;
      errorEl.textContent = err.message || "Couldn't reschedule.";
      statusEl.textContent = "";
    }
  }

  window.openCrmReschedule = open;
})();
