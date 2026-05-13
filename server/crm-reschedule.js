// Shared admin reschedule modal. Loaded on every admin page that needs
// it (desktop work-order, tech-mode work-order, schedule grid). Exposes
// a single global `openCrmReschedule({ bookingId, leadId, onDone })` —
// callers pass either the BK- id directly or a leadId for resolution.
//
// Visual contract: single-panel centered modal that scrolls vertically
// inside the card. NO bottom-sheet, NO slide-up, NO drawer. Patrick
// explicitly does not want sliding panels in any modal.
//
// The day + time picker is the shared component from /js/time-picker.js
// (mode: "admin", custom-time enabled). Admin reschedule uses
// /api/bookings/:id/availability + /api/bookings/:id/reschedule.

(function () {
  if (window.openCrmReschedule) return; // already loaded

  // Lazy-create the modal DOM the first time it's opened. Saves every
  // admin page from having to embed the markup; one source of truth.
  let modal = null;
  let onDoneCb = null;
  let selectedSlot = "";
  let bookingId = "";
  let pickerDestroy = null;

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
          <div class="crm-resched-picker" data-picker></div>
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

  // Drive the shared time picker from the admin reschedule endpoint. Each
  // visible-range request hits /api/bookings/:id/availability with ?from/?to.
  // onSelect captures the picked slot (regular or admin custom-time) and
  // enables the Confirm new time button.
  function mountPicker() {
    const host = modal.querySelector("[data-picker]");
    if (typeof window.mountTimePicker !== "function") {
      const helpEl = modal.querySelector("[data-help]");
      helpEl.hidden = false;
      helpEl.textContent = "Time picker failed to load. Refresh the page and try again.";
      return;
    }
    pickerDestroy = window.mountTimePicker(host, {
      mode: "admin",
      allowCustomTime: true,
      loadAvailability: async ({ from, to }) => {
        if (!bookingId) return { days: [] };
        const url = `/api/bookings/${encodeURIComponent(bookingId)}/availability`
          + `?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
        const r = await fetch(url, { cache: "no-store" });
        const data = await r.json();
        if (!data.ok) throw new Error((data.errors || ["Couldn't load times."]).join(" "));
        // The first fetch carries `currentScheduledFor` — refresh the
        // header line so the admin always sees the current booking time.
        if (data.currentScheduledFor) {
          const d = new Date(data.currentScheduledFor);
          modal.querySelector("[data-current]").textContent = d.toLocaleString("en-CA", {
            weekday: "long", month: "long", day: "numeric", hour: "numeric", minute: "2-digit"
          });
        }
        return { days: data.days || [] };
      },
      onSelect: (iso) => {
        selectedSlot = iso;
        modal.querySelector(".crm-resched-submit").disabled = false;
        modal.querySelector(".crm-resched-error").hidden = true;
      }
    });
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
    const pickerEl = modal.querySelector("[data-picker]");
    const currentEl = modal.querySelector("[data-current]");
    const errorEl = modal.querySelector(".crm-resched-error");
    const statusEl = modal.querySelector(".crm-resched-status");
    const submitEl = modal.querySelector(".crm-resched-submit");
    // Tear down any picker left from a previous open() so we don't double-mount.
    if (typeof pickerDestroy === "function") { try { pickerDestroy(); } catch (_) {} pickerDestroy = null; }
    helpEl.hidden = true;
    pickerEl.innerHTML = "";
    currentEl.textContent = "—";
    errorEl.hidden = true;
    statusEl.textContent = "";
    submitEl.disabled = true;
    modal.querySelector(".crm-resched-reason").value = "";
    try {
      const id = await resolveBookingId(opts);
      if (!id) throw new Error("No booking record found for this customer.");
      bookingId = id;
      mountPicker();
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
    if (typeof pickerDestroy === "function") { try { pickerDestroy(); } catch (_) {} pickerDestroy = null; }
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
