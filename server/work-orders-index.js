// Work orders index — Phase 5.
// Lists every WO in the system. Status filter (defaults to "all active",
// which excludes completed + cancelled), free-text search across id /
// customer / address. Card click opens the desktop editor.

const els = {
  container: document.getElementById("woContainer"),
  empty: document.getElementById("woEmpty"),
  search: document.getElementById("woSearch"),
  showClosed: document.getElementById("woShowClosed"),
  filterButtons: document.querySelectorAll("[data-status-filter]")
};

const STATUS_LABELS = {
  scheduled: "Scheduled",
  dispatched: "Dispatched",
  en_route: "En route",
  on_site: "On site",
  in_progress: "In progress",
  awaiting_approval: "Awaiting approval",
  approved: "Approved",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "No show"
};
const TYPE_LABELS = {
  service_visit: "Service visit",
  spring_opening: "Spring opening",
  fall_closing: "Fall closing"
};
// Closed = terminal states. Hidden by default unless either the explicit
// status filter targets one of them OR the "Show completed + cancelled"
// toggle is on.
const CLOSED_STATUSES = new Set(["completed", "cancelled", "no_show"]);

let currentStatus = "";
let cachedWos = [];

function escapeHtml(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}
function fmtDate(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-CA", { month: "short", day: "numeric", year: "numeric" });
}
function fmtDateTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("en-CA", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

async function load() {
  const r = await fetch("/api/work-orders", { cache: "no-store" });
  const data = await r.json().catch(() => ({}));
  cachedWos = (data.ok && Array.isArray(data.workOrders)) ? data.workOrders : [];
  // Most-recently-updated first — matches how the existing /api/work-orders
  // endpoint sorts, but be explicit so future API changes don't drift.
  cachedWos.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  render();
}

function applyFilters(items) {
  let result = items;
  // Status filter — pill row.
  if (currentStatus === "stuck") {
    // "Stuck completions" — WOs signed (locked=true) whose status never
    // flipped past completed. These are the cases the cascade missed
    // (Patrick had to draft invoices manually for these pre-merge).
    // Tap a row to open the desktop editor, then Re-run completion
    // cascade — OR use the inline button on each card here.
    result = result.filter((w) => w.locked === true && w.status !== "completed");
  } else if (currentStatus) {
    result = result.filter((w) => w.status === currentStatus);
  } else {
    // "All active" view — hide closed by default unless toggle on.
    if (!els.showClosed.checked) {
      result = result.filter((w) => !CLOSED_STATUSES.has(w.status));
    }
  }
  // Free-text search.
  const q = els.search.value.trim().toLowerCase();
  if (q) {
    result = result.filter((w) => {
      const haystack = [
        w.id, w.customerName, w.customerEmail, w.customerPhone, w.address, w.diagnosis
      ].map((v) => String(v || "").toLowerCase()).join(" ");
      return haystack.includes(q);
    });
  }
  return result;
}

function render() {
  const items = applyFilters(cachedWos);
  const showStuck = currentStatus === "stuck";
  if (!items.length) {
    els.container.innerHTML = "";
    els.empty.hidden = false;
    els.empty.textContent = showStuck
      ? "No stuck completions. Every signed work order has fired its cascade."
      : "No work orders match the current filter.";
    return;
  }
  els.empty.hidden = true;
  els.container.innerHTML = items.map((wo) => {
    const status = STATUS_LABELS[wo.status] || wo.status;
    const typeLabel = TYPE_LABELS[wo.type] || wo.type;
    const customer = wo.customerName || wo.customerEmail || "(no customer)";
    const addressLine = wo.address ? ` &middot; ${escapeHtml(wo.address)}` : "";
    const scheduled = wo.scheduledFor ? fmtDateTime(wo.scheduledFor) : "Not yet scheduled";
    // Tag chips — locked, follow-up, photo count, intake guarantee.
    const tags = [];
    if (wo.locked) tags.push(`<span class="wo-card-tag is-locked">🔒 Locked</span>`);
    if (wo.followupOfWoId) tags.push(`<span class="wo-card-tag is-followup">↪ Follow-up of ${escapeHtml(wo.followupOfWoId)}</span>`);
    if (wo.intakeGuarantee && wo.intakeGuarantee.applies) tags.push(`<span class="wo-card-tag">AI guarantee</span>`);
    const photoCount = (wo.photos || []).length;
    if (photoCount) tags.push(`<span class="wo-card-tag">${photoCount} photo${photoCount === 1 ? "" : "s"}</span>`);
    // Stuck-recovery action — visible only on the "Stuck completions"
    // filter. PATCHes status=completed which fires the cascade server-
    // side (idempotent, safe to re-run). Disabled when the WO has no
    // linked property since the cascade short-circuits on that.
    const stuckAction = showStuck
      ? `<div class="wo-card-stuck-action">
           ${wo.propertyId
             ? `<button type="button" class="pjl-btn pjl-btn-primary wo-card-run-cascade" data-wo-id="${escapeHtml(wo.id)}">Run cascade now</button>`
             : `<a class="pjl-btn pjl-btn-outline" href="/admin/work-order/${encodeURIComponent(wo.id)}">Link property first</a>`}
         </div>`
      : "";
    return `
      <li class="ml-card${showStuck ? " is-stuck" : ""}">
        <a class="ml-card-link" href="/admin/work-order/${encodeURIComponent(wo.id)}">
          <div class="ml-card-head">
            <h3 class="ml-card-name">${escapeHtml(customer)}</h3>
            <span class="ml-card-id">${escapeHtml(wo.id)}</span>
            <span class="wo-status wo-status--${escapeHtml(wo.status)}">${escapeHtml(status)}</span>
          </div>
          <div class="ml-card-meta">
            <strong>${escapeHtml(typeLabel)}</strong>${addressLine}
            <br>Scheduled: ${escapeHtml(scheduled)}
            ${wo.diagnosis ? `<br><span style="color:#7A7A72">${escapeHtml(String(wo.diagnosis).slice(0, 140))}${String(wo.diagnosis).length > 140 ? "…" : ""}</span>` : ""}
          </div>
          ${tags.length ? `<div class="wo-card-tags">${tags.join("")}</div>` : ""}
          <div class="wo-card-meta-row">
            <span>Updated ${escapeHtml(fmtDate(wo.updatedAt))}</span>
            <span class="wo-card-id">${(wo.zones || []).length} zone${(wo.zones || []).length === 1 ? "" : "s"}</span>
          </div>
        </a>
        ${stuckAction}
      </li>
    `;
  }).join("");
}

// Per-card "Run cascade now" — PATCHes status=completed, which on the
// server side fires the completion cascade for the first time on this
// WO and returns the freshly-drafted invoice id. Idempotent (re-running
// against an already-cascaded WO just short-circuits at the service-
// record check). Confirms before firing because this changes the WO
// status to completed.
els.container.addEventListener("click", async (event) => {
  const btn = event.target.closest(".wo-card-run-cascade");
  if (!btn) return;
  event.preventDefault();
  event.stopPropagation();
  const id = btn.dataset.woId;
  if (!id) return;
  if (!confirm(`Run completion cascade on ${id}? This marks the visit completed and drafts the invoice. Safe to re-run if it's already cascaded.`)) return;
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Running…";
  try {
    const r = await fetch(`/api/work-orders/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "completed" })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error((data.errors || ["Couldn't run cascade."]).join(" "));
    const invoiceId = data.cascade && data.cascade.invoiceId;
    const alreadyRan = data.cascade && data.cascade.alreadyRan;
    let msg;
    if (alreadyRan) {
      msg = `Cascade already fired on this WO. Service record + invoice on file.`;
    } else if (invoiceId) {
      msg = `Cascade fired. Draft invoice ${invoiceId} on file.`;
    } else {
      msg = `Cascade fired. Service record on file (no billable line items).`;
    }
    alert(msg);
    await load(); // refresh the list — this WO should drop out of "stuck"
  } catch (err) {
    btn.disabled = false;
    btn.textContent = original;
    alert(err.message || "Couldn't run cascade.");
  }
});

els.search.addEventListener("input", () => render());
els.showClosed.addEventListener("change", () => render());
els.filterButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    currentStatus = btn.dataset.statusFilter || "";
    els.filterButtons.forEach((b) => b.classList.toggle("is-active", b === btn));
    render();
  });
});

load();
