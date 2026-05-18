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
// Set of WO ids that have an invoice referencing them. Hydrated once at
// load via GET /api/invoices and used by the "needs_invoice" filter
// (Brief: WO Field-Readiness §6.6). Empty Set until the invoices fetch
// completes — filter then re-renders.
let invoicedWoIds = new Set();

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
  // Two parallel fetches: WOs (primary) + invoices (used to compute the
  // needs_invoice client-side join). Invoices fetch is best-effort —
  // if it fails the filter just shows zero results until reload.
  const [woResp, invResp] = await Promise.allSettled([
    fetch("/api/work-orders", { cache: "no-store" }),
    fetch("/api/invoices", { cache: "no-store" })
  ]);
  if (woResp.status === "fulfilled") {
    const data = await woResp.value.json().catch(() => ({}));
    cachedWos = (data.ok && Array.isArray(data.workOrders)) ? data.workOrders : [];
    cachedWos.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
  }
  if (invResp.status === "fulfilled") {
    const data = await invResp.value.json().catch(() => ({}));
    const invoices = (data.ok && Array.isArray(data.invoices)) ? data.invoices : [];
    invoicedWoIds = new Set(invoices.map((inv) => inv.woId).filter(Boolean));
  }
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
  } else if (currentStatus === "needs_invoice") {
    // "Needs invoice" — WOs signed (locked=true) that have NO invoice
    // on file referencing them. Catches both the cascade-never-fired
    // case (overlaps with "stuck") AND the cascade-fired-but-draft-
    // failed case (status="completed" but no invoice). Brief: WO
    // Field-Readiness §6.6.
    result = result.filter((w) => w.locked === true && !invoicedWoIds.has(w.id));
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
  const showNeedsInvoice = currentStatus === "needs_invoice";
  // Both recovery filters surface the per-row Run cascade button. The
  // user copy + empty message vary so the operator knows which subset
  // they're looking at.
  const showRunButton = showStuck || showNeedsInvoice;
  if (!items.length) {
    els.container.innerHTML = "";
    els.empty.hidden = false;
    els.empty.textContent = showStuck
      ? "No stuck completions. Every signed work order has fired its cascade."
      : showNeedsInvoice
        ? "No signed work orders are missing an invoice. Cascade is healthy."
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
    // Recovery action — visible on the "Stuck completions" + "Needs
    // invoice" filters. Both surface the same per-row Run cascade
    // button (idempotent — safe to re-run on already-cascaded WOs).
    // Disabled when the WO has no linked property since the cascade
    // short-circuits on that. Brief: WO Field-Readiness §6.6.
    const recoveryAction = showRunButton
      ? `<div class="wo-card-stuck-action">
           ${wo.propertyId
             ? `<button type="button" class="pjl-btn pjl-btn-primary wo-card-run-cascade" data-wo-id="${escapeHtml(wo.id)}">Run cascade now</button>`
             : `<a class="pjl-btn pjl-btn-outline" href="/admin/work-order/${encodeURIComponent(wo.id)}">Link property first</a>`}
         </div>`
      : "";
    return `
      <li class="ml-card${showRunButton ? " is-stuck" : ""}" data-wo-id="${escapeHtml(wo.id)}">
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
        ${recoveryAction}
      </li>
    `;
  }).join("");
  // Wire the bulk-selection toolbar (Session 2 brief). Refresh on every
  // render so newly-rendered rows get checkboxes.
  if (window.pjlBulkWiring) {
    window.pjlBulkWiring.attach("work-orders", {
      onActionComplete: () => { try { load(); } catch {} }
    });
  }
  // Relocate the injected wrap into .ml-card-head so it sits inline with
  // the customer name instead of indenting the whole card (Patrick's
  // feedback on the quote-folder rebuild: no reserved checkbox column).
  els.container.querySelectorAll(".ml-card").forEach((card) => {
    const wrap = card.querySelector(":scope > .pjl-bulk-checkbox-wrap");
    const head = card.querySelector(".ml-card-head");
    if (wrap && head) head.insertBefore(wrap, head.firstChild);
  });
}

// Per-card "Run cascade now" — calls POST /run-cascade (Brief: WO
// Field-Readiness §6.6). Idempotent at the cascade layer: re-runs
// against an already-cascaded WO short-circuit with alreadyRan=true
// at the service-record check. Works for both filters:
//   - "Stuck" (locked && status !== "completed"): cascade fires and
//     creates the missing artifacts; status stays where it was.
//   - "Needs invoice" (locked && no invoice on file): cascade re-runs
//     and the createDraft step generates the missing invoice.
els.container.addEventListener("click", async (event) => {
  const btn = event.target.closest(".wo-card-run-cascade");
  if (!btn) return;
  event.preventDefault();
  event.stopPropagation();
  const id = btn.dataset.woId;
  if (!id) return;
  if (!confirm(`Run completion cascade on ${id}? Drafts a service record + invoice from the signed scope. Idempotent — safe to re-run.`)) return;
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Running…";
  try {
    const r = await fetch(`/api/work-orders/${encodeURIComponent(id)}/run-cascade`, { method: "POST" });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data.ok) throw new Error((data.errors || ["Couldn't run cascade."]).join(" "));
    const invoiceId = data.invoice && data.invoice.id;
    const alreadyRan = !!data.alreadyRan;
    let msg;
    if (alreadyRan) {
      msg = `Cascade already fired on this WO. Service record + invoice on file.`;
    } else if (invoiceId) {
      msg = `Cascade fired. Draft invoice ${invoiceId} on file.`;
    } else {
      msg = `Cascade fired. Service record on file (no billable line items).`;
    }
    alert(msg);
    await load(); // refresh the list — this WO should drop out of the recovery filter
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

// URL query bootstrap (Brief: WO Field-Readiness §6.6) — links like
// /admin/work-orders?needs_invoice=1 auto-activate the matching pill
// so Patrick can deep-link from elsewhere (recovery dashboards,
// memory notes) and land on the filtered view. Falls back to "All
// active" when no param matches.
(function applyQueryParamFilter() {
  try {
    const params = new URLSearchParams(window.location.search || "");
    let preselect = "";
    if (params.get("needs_invoice") === "1") preselect = "needs_invoice";
    else if (params.get("stuck") === "1") preselect = "stuck";
    else if (params.get("status")) preselect = params.get("status");
    if (preselect) {
      const target = Array.from(els.filterButtons).find((b) => b.dataset.statusFilter === preselect);
      if (target) {
        currentStatus = preselect;
        els.filterButtons.forEach((b) => b.classList.toggle("is-active", b === target));
      }
    }
  } catch (_e) { /* malformed querystring — ignore, use defaults */ }
})();

load();
