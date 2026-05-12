// /admin/booking/:id — booking folder detail. Editable status + prep
// notes (PATCH /api/bookings/:id), read-only tabs for linked WOs,
// source quote, and history audit trail.

(function setupNavToggle() {
  const toggle = document.getElementById("navToggle");
  const nav = document.querySelector(".pjl-admin-nav");
  if (!toggle || !nav) return;
  toggle.addEventListener("click", () => {
    const open = !nav.classList.contains("is-open");
    nav.classList.toggle("is-open", open);
    toggle.setAttribute("aria-expanded", String(open));
  });
  nav.querySelectorAll(".pjl-nav-links a").forEach((a) => {
    a.addEventListener("click", () => {
      nav.classList.remove("is-open");
      toggle.setAttribute("aria-expanded", "false");
    });
  });
})();

const idMatch = location.pathname.match(/^\/admin\/booking\/([^/]+)/);
const bookingId = idMatch ? decodeURIComponent(idMatch[1]) : null;

const titleEl = document.getElementById("bookingTitle");
const profileEl = document.getElementById("bookingProfile");
const loadErrorEl = document.getElementById("loadError");
const summaryIdEl = document.getElementById("summaryId");
const summaryStatusEl = document.getElementById("summaryStatus");
const summaryCustomerEl = document.getElementById("summaryCustomer");
const summaryPropertyEl = document.getElementById("summaryProperty");
const summaryServiceEl = document.getElementById("summaryService");
const summaryScheduledEl = document.getElementById("summaryScheduled");
const summaryDurationEl = document.getElementById("summaryDuration");
const summaryAddressEl = document.getElementById("summaryAddress");
const statusSelect = document.getElementById("statusSelect");
const prepNotes = document.getElementById("prepNotes");
const saveBtn = document.getElementById("saveBtn");
const revertBtn = document.getElementById("revertBtn");
const saveError = document.getElementById("saveError");
const logoutButton = document.getElementById("logoutButton");

let original = null;

function esc(v) {
  return String(v == null ? "" : v)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
}

function formatDateTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-CA", { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function applyToForm(b, ext) {
  original = b;
  titleEl.textContent = b.id;
  summaryIdEl.textContent = b.id;
  summaryStatusEl.textContent = b.status || "confirmed";
  summaryStatusEl.className = `customer-status is-${b.status || "confirmed"}`;
  if (b.customerId) {
    summaryCustomerEl.innerHTML = `<a href="/admin/customer/${esc(b.customerId)}">${esc(b.customerName) || "(unnamed)"}</a> · ${esc(b.customerEmail) || ""}`;
  } else {
    summaryCustomerEl.textContent = `${b.customerName || "(unnamed)"} · ${b.customerEmail || ""}`;
  }
  if (b.propertyId) {
    summaryPropertyEl.innerHTML = `<a href="/admin/property/${esc(b.propertyId)}">${esc(b.address) || "—"}</a>`;
  } else {
    summaryPropertyEl.textContent = b.address || "(no property)";
  }
  summaryServiceEl.textContent = `${b.serviceLabel || b.serviceKey || "—"}${b.zoneCount ? ` · ${b.zoneCount} zones` : ""}`;
  summaryScheduledEl.textContent = formatDateTime(b.scheduledFor);
  summaryDurationEl.textContent = b.durationMinutes ? `${b.durationMinutes} min` : "—";
  summaryAddressEl.textContent = b.address || "—";
  statusSelect.value = b.status || "confirmed";
  prepNotes.value = b.prepNotes || "";
  saveBtn.disabled = true;
  revertBtn.disabled = true;
  saveError.hidden = true;

  // Linked work orders
  const woEl = document.getElementById("panelWorkOrders");
  const wos = ext?.workOrders || [];
  document.getElementById("countWorkOrders").textContent = wos.length;
  if (!wos.length) {
    woEl.innerHTML = `<p class="customer-tab-empty">No work orders linked yet.</p>`;
  } else {
    woEl.innerHTML = `
      <table>
        <thead><tr><th>ID</th><th>Type</th><th>Status</th><th>Scheduled</th></tr></thead>
        <tbody>
          ${wos.map((w) => `
            <tr>
              <td><a href="/admin/work-order/${esc(w.id)}"><strong>${esc(w.id)}</strong></a></td>
              <td>${esc(w.type)}</td>
              <td>${esc(w.status)}${w.locked ? " (locked)" : ""}</td>
              <td>${formatDateTime(w.scheduledFor)}</td>
            </tr>
          `).join("")}
        </tbody>
      </table>
    `;
  }

  // Source quote
  const qEl = document.getElementById("panelQuote");
  if (b.sourceQuoteId) {
    qEl.innerHTML = `<p>Booked from <a href="/admin/quote-folder?q=${esc(b.sourceQuoteId)}"><strong>${esc(b.sourceQuoteId)}</strong></a>.</p>`;
  } else {
    qEl.innerHTML = `<p class="customer-tab-empty">No source quote.</p>`;
  }

  // History
  const hEl = document.getElementById("panelHistory");
  const history = Array.isArray(b.history) ? b.history : [];
  document.getElementById("countHistory").textContent = history.length;
  if (!history.length) {
    hEl.innerHTML = `<p class="customer-tab-empty">No history yet.</p>`;
  } else {
    const ordered = [...history].sort((a, b) => String(b.ts || "").localeCompare(String(a.ts || "")));
    hEl.innerHTML = ordered.map((h) => `
      <div class="customer-history-row">
        <span class="ts">${formatDateTime(h.ts)}</span>
        <span class="action">${esc(h.action)}</span>
        <span class="by">by ${esc(h.by || "system")}</span>
        ${h.note ? `<span>· ${esc(h.note)}</span>` : ""}
      </div>
    `).join("");
  }
}

function checkDirty() {
  if (!original) return;
  const dirty = (statusSelect.value !== (original.status || "confirmed"))
    || (prepNotes.value !== (original.prepNotes || ""));
  saveBtn.disabled = !dirty;
  revertBtn.disabled = !dirty;
}

statusSelect.addEventListener("change", checkDirty);
prepNotes.addEventListener("input", checkDirty);

revertBtn.addEventListener("click", () => {
  if (original) applyToForm(original, { workOrders: original._workOrders || [] });
});

saveBtn.addEventListener("click", async () => {
  saveError.hidden = true;
  saveBtn.disabled = true;
  const patch = { status: statusSelect.value, prepNotes: prepNotes.value };
  try {
    const res = await fetch(`/api/bookings/${encodeURIComponent(bookingId)}`, {
      method: "PATCH",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch)
    });
    const body = await res.json();
    if (!res.ok || !body.ok) {
      saveError.textContent = body?.errors?.[0] || body?.error || "Couldn't save.";
      saveError.hidden = false;
      saveBtn.disabled = false;
      return;
    }
    await load();
  } catch (err) {
    saveError.textContent = err.message || "Network error.";
    saveError.hidden = false;
    saveBtn.disabled = false;
  }
});

// Tab switching
Array.from(document.querySelectorAll(".customer-tab-header")).forEach((h) => {
  h.addEventListener("click", () => {
    const target = h.dataset.tab;
    document.querySelectorAll(".customer-tab-header").forEach((x) => x.classList.toggle("is-active", x === h));
    document.querySelectorAll(".customer-tab-panel").forEach((p) => { p.hidden = p.dataset.tab !== target; });
  });
});

if (logoutButton) {
  logoutButton.addEventListener("click", async () => {
    try { await fetch("/api/logout", { method: "POST" }); } catch {}
    location.href = "/login";
  });
}

async function load() {
  if (!bookingId) {
    loadErrorEl.textContent = "Couldn't read booking id from URL.";
    loadErrorEl.hidden = false;
    return;
  }
  try {
    const res = await fetch(`/api/bookings/${encodeURIComponent(bookingId)}`, { credentials: "same-origin" });
    if (res.status === 404) {
      loadErrorEl.textContent = `Booking ${bookingId} not found.`;
      loadErrorEl.hidden = false;
      return;
    }
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json();
    if (!body.ok || !body.booking) throw new Error(body?.error || "Bad response.");
    // Decorate with workOrders by fetching them. /api/bookings/:id
    // doesn't currently return WOs decorated, so pull them client-side.
    const wos = [];
    for (const woId of (body.booking.workOrderIds || [])) {
      try {
        const woRes = await fetch(`/api/work-orders/${encodeURIComponent(woId)}`, { credentials: "same-origin" });
        if (woRes.ok) {
          const woBody = await woRes.json();
          if (woBody?.workOrder) wos.push(woBody.workOrder);
        }
      } catch { /* tolerate */ }
    }
    profileEl.hidden = false;
    applyToForm(body.booking, { workOrders: wos });
    original._workOrders = wos;
  } catch (err) {
    loadErrorEl.textContent = err?.message || "Failed to load booking.";
    loadErrorEl.hidden = false;
  }
}

load();
