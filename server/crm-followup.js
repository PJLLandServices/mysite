// Shared follow-up scheduling modal. Loaded on the desktop WO + tech WO
// pages. Exposes window.openCrmFollowup({ workOrderId, parentAddress })
// and handles everything in one single-panel modal — date+time slots
// (condensed into Morning / Midday / Afternoon / Evening), parts
// checklist (grouped by category from parts.json), notes textarea, and
// two submit buttons:
//   - "Schedule + create WO" (primary): POSTs with slotStart + materials.
//   - "Create WO, schedule later" (secondary): POSTs without slotStart;
//     legacy "Patrick to call customer" fallback.
//
// Visual contract: single-panel centered modal that scrolls vertically.
// NO drawer, NO bottom sheet, NO slide-up. The whole flow lives in one
// surface that the user scrolls top-to-bottom.

(function () {
  if (window.openCrmFollowup) return;

  let modal = null;
  let workOrderId = "";
  let parentAddress = "";
  let parentLineSkus = new Set();
  let onDoneCb = null;
  let selectedSlot = "";
  let partsCatalog = null;

  function ensureModal() {
    if (modal) return modal;
    modal = document.createElement("div");
    modal.className = "crm-followup-modal";
    modal.hidden = true;
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.innerHTML = `
      <div class="crm-followup-card">
        <header class="crm-followup-header">
          <h2>Schedule follow-up visit</h2>
          <button type="button" class="crm-followup-close" aria-label="Cancel">×</button>
        </header>
        <div class="crm-followup-body">
          <p class="crm-followup-help">
            Pick a return date + time and the parts that need to be on the truck. Customer will be notified once you confirm.
          </p>

          <section class="crm-followup-section">
            <h3>1. Date &amp; time</h3>
            <p class="crm-followup-section-help" data-slots-help>Loading available times…</p>
            <div class="crm-followup-slots" data-slots></div>
          </section>

          <section class="crm-followup-section">
            <h3>2. Parts to bring</h3>
            <p class="crm-followup-section-help">Tick each SKU you'll need on the truck. Inherited items from this visit are pre-checked.</p>
            <div class="crm-followup-parts" data-parts>Loading parts catalog…</div>
          </section>

          <section class="crm-followup-section">
            <h3>3. Scope notes</h3>
            <textarea class="crm-followup-notes" data-notes rows="3" maxlength="1000" placeholder="What's missing? What needs to come back? (e.g. 'Manifold rebuild — ordered 6-valve kit, return Tuesday')"></textarea>
          </section>

          <div class="crm-followup-actions">
            <button type="button" class="crm-followup-cancel">Cancel</button>
            <button type="button" class="crm-followup-later">Create WO — schedule later</button>
            <button type="button" class="crm-followup-submit" disabled>Schedule + create WO</button>
          </div>
          <p class="crm-followup-error" hidden role="alert"></p>
          <p class="crm-followup-status" role="status"></p>
        </div>
      </div>
    `;
    document.body.appendChild(modal);

    modal.querySelector(".crm-followup-close").addEventListener("click", close);
    modal.querySelector(".crm-followup-cancel").addEventListener("click", close);
    modal.addEventListener("click", (e) => { if (e.target === modal) close(); });
    document.addEventListener("keydown", (e) => {
      if (!modal.hidden && e.key === "Escape") close();
    });
    modal.querySelector(".crm-followup-submit").addEventListener("click", () => submit({ withSlot: true }));
    modal.querySelector(".crm-followup-later").addEventListener("click", () => submit({ withSlot: false }));
    return modal;
  }

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

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  // Date-first picker. Tap a date row → expands time buckets inline
  // below. Other dates collapse. No drawer, no slide.
  function renderSlots(days) {
    const slotsEl = modal.querySelector("[data-slots]");
    const helpEl = modal.querySelector("[data-slots-help]");
    slotsEl.innerHTML = "";
    let totalDays = 0;
    days.forEach((day) => {
      const condensed = condenseSlotsForDay(day.slots || []);
      if (!condensed.length) return;
      totalDays++;
      const dateBtn = document.createElement("button");
      dateBtn.type = "button";
      dateBtn.className = "crm-followup-date";
      dateBtn.innerHTML = `
        <span class="crm-followup-date-label">${escapeHtml(day.label || day.date || "")}</span>
        <span class="crm-followup-date-count">${condensed.length} time${condensed.length === 1 ? "" : "s"}</span>
      `;
      const times = document.createElement("div");
      times.className = "crm-followup-times";
      times.hidden = true;
      condensed.forEach((b) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "crm-followup-slot-btn";
        const time = new Date(b.slot.start).toLocaleTimeString("en-CA", { hour: "numeric", minute: "2-digit" });
        btn.innerHTML = `${time}<span class="crm-followup-bucket">${b.label}</span>`;
        btn.addEventListener("click", () => {
          slotsEl.querySelectorAll(".crm-followup-slot-btn.is-selected").forEach((x) => x.classList.remove("is-selected"));
          btn.classList.add("is-selected");
          selectedSlot = b.slot.start;
          modal.querySelector(".crm-followup-submit").disabled = false;
        });
        times.appendChild(btn);
      });
      dateBtn.addEventListener("click", () => {
        slotsEl.querySelectorAll(".crm-followup-date.is-open").forEach((d) => d.classList.remove("is-open"));
        slotsEl.querySelectorAll(".crm-followup-times").forEach((t) => { t.hidden = true; });
        const wasOpen = dateBtn.dataset.open === "1";
        if (!wasOpen) {
          dateBtn.classList.add("is-open");
          times.hidden = false;
          dateBtn.dataset.open = "1";
        } else {
          dateBtn.dataset.open = "0";
        }
      });
      slotsEl.appendChild(dateBtn);
      slotsEl.appendChild(times);
    });
    if (!totalDays) {
      helpEl.hidden = false;
      helpEl.textContent = "No available slots in the next 30 days. Use 'Create WO — schedule later' and Patrick will call to slot it.";
    } else {
      helpEl.hidden = true;
    }
  }

  // Render the parts catalog into the modal via the shared CrmParts
  // module. Three-level tree: Category > Subcategory > Items. Inherited
  // SKUs from the parent WO arrive as `parentLineSkus` (a Set) and get
  // pre-checked; the renderer auto-opens the right categories.
  function renderParts(catalog) {
    const partsEl = modal.querySelector("[data-parts]");
    if (!window.CrmParts || !catalog || !catalog.parts) {
      partsEl.textContent = "Parts catalog unavailable.";
      return;
    }
    window.CrmParts.render(partsEl, catalog, {
      preChecked: parentLineSkus,
      idPrefix: "fpart_"
    });
  }

  async function open(opts = {}) {
    ensureModal();
    workOrderId = opts.workOrderId || "";
    parentAddress = opts.parentAddress || "";
    parentLineSkus = new Set(Array.isArray(opts.parentSkus) ? opts.parentSkus : []);
    onDoneCb = typeof opts.onDone === "function" ? opts.onDone : null;
    selectedSlot = "";
    if (!workOrderId) return;

    modal.hidden = false;
    document.body.style.overflow = "hidden";
    const submitEl = modal.querySelector(".crm-followup-submit");
    submitEl.disabled = true;
    modal.querySelector(".crm-followup-error").hidden = true;
    modal.querySelector(".crm-followup-status").textContent = "";
    modal.querySelector("[data-notes]").value = "";
    modal.querySelector("[data-slots]").innerHTML = "";
    modal.querySelector("[data-parts]").textContent = "Loading parts catalog…";
    const slotsHelp = modal.querySelector("[data-slots-help]");
    slotsHelp.hidden = false;
    slotsHelp.textContent = "Loading available times…";

    // Two parallel fetches: availability for sprinkler_repair (the
    // default service for follow-ups) and the parts catalog. Either
    // failure is non-fatal — we degrade gracefully.
    const availUrl = `/api/booking/availability?service=sprinkler_repair&address=${encodeURIComponent(parentAddress)}&days=30`;
    const partsUrl = "/api/parts";
    const [availResp, partsResp] = await Promise.all([
      fetch(availUrl).then((r) => r.json()).catch((err) => ({ ok: false, errors: [err.message] })),
      partsCatalog ? Promise.resolve({ ok: true, categories: partsCatalog.categories, parts: partsCatalog.parts }) : fetch(partsUrl).then((r) => r.json()).catch((err) => ({ ok: false, errors: [err.message] }))
    ]);

    if (availResp.ok) {
      renderSlots(availResp.days || []);
    } else {
      slotsHelp.hidden = false;
      slotsHelp.textContent = (availResp.errors || ["Couldn't load times."]).join(" ");
    }

    if (partsResp.ok && partsResp.parts) {
      // Cache the FULL catalog envelope (categories + parts) so reopens
      // skip the network round-trip.
      partsCatalog = { categories: partsResp.categories || [], parts: partsResp.parts };
      renderParts(partsCatalog);
    } else {
      modal.querySelector("[data-parts]").textContent = "Parts catalog unavailable. You can still schedule — Patrick will sort packing.";
    }
  }

  function close() {
    if (!modal) return;
    modal.hidden = true;
    document.body.style.overflow = "";
    selectedSlot = "";
    workOrderId = "";
    onDoneCb = null;
  }

  async function submit({ withSlot }) {
    if (!workOrderId) return;
    if (withSlot && !selectedSlot) return;
    const submitEl = modal.querySelector(".crm-followup-submit");
    const laterEl = modal.querySelector(".crm-followup-later");
    const errorEl = modal.querySelector(".crm-followup-error");
    const statusEl = modal.querySelector(".crm-followup-status");
    submitEl.disabled = true;
    laterEl.disabled = true;
    errorEl.hidden = true;
    statusEl.textContent = withSlot ? "Scheduling follow-up…" : "Creating follow-up…";
    const notes = (modal.querySelector("[data-notes]").value || "").trim();
    const materials = Array.from(
      modal.querySelectorAll("[data-parts] input[type=checkbox]:checked")
    ).map((cb) => cb.dataset.sku).filter(Boolean);

    const body = { notes, materials };
    if (withSlot) body.slotStart = selectedSlot;
    try {
      const r = await fetch(`/api/work-orders/${encodeURIComponent(workOrderId)}/followup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      });
      const data = await r.json();
      if (!r.ok || !data.ok) throw new Error((data.errors || ["Couldn't create follow-up."]).join(" "));
      statusEl.textContent = withSlot
        ? `Follow-up ${data.followupWoId} scheduled. Customer notified.`
        : `Follow-up ${data.followupWoId} created. Patrick has been notified to schedule it.`;
      const cb = onDoneCb;
      setTimeout(() => {
        close();
        if (cb) cb(data);
      }, 800);
    } catch (err) {
      submitEl.disabled = !selectedSlot;
      laterEl.disabled = false;
      errorEl.hidden = false;
      errorEl.textContent = err.message || "Couldn't create follow-up.";
      statusEl.textContent = "";
    }
  }

  window.openCrmFollowup = open;
})();
